/**
 * Webhook signing and delivery.
 * SOURCE: https://help.extensiv.com/en_US/rest-api/implementing-webhooks — HTTP POST, Content-Type
 * application/json, `Signature` header = base64(RSA-SHA256 over the raw body), public key served
 * from GET /events/webhook/key, retries for ~6 hours, receiver must answer within 3 seconds.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { WebhookPayload } from './models.js';
import { webhookDate } from './util.js';

export interface WebhookSubscription {
  name: string;
  /** SOURCE: rels/master/webhooksconfig — Order, Receiver, Adjustment, Assembly, OrderItem, Item, InventorySummary. */
  resource: string;
  /** Empty = every event type for the resource. */
  eventTypes: string[];
  url: string;
  includeResource: boolean;
  resourceApiParameters: string | null;
  /** Mock-only: which seeded customer the subscription came from (null for control-plane ones). */
  customerId: number | null;
}

export interface DeliveryAttempt {
  attempt: number;
  status: number | null;
  error: string | null;
  at: string;
}

export interface WebhookDelivery {
  deliveryId: number;
  url: string;
  eventType: string;
  resourceRel: string;
  resourceId: number;
  tags: string;
  body: string;
  signature: string;
  attempts: DeliveryAttempt[];
  ok: boolean;
  done: boolean;
}

export interface EmitInput {
  eventType: string;
  /** e.g. `orders/order` (SOURCE: implementing-webhooks resource.rel). */
  resourceRel: string;
  resourceId: number;
  /** Path of the resource, e.g. `/orders/123` (becomes resource.href plus any resourceApiParameters). */
  resourcePath: string;
  /** Which subscription resource this maps to, e.g. "Order". */
  resource: string;
  customerId: number;
  facilityId: number;
  tags?: string;
  /** Wire body of the resource, embedded as an escaped string when the subscription asks for it. */
  resourceBody?: unknown;
  /** Extra `data` members beyond the id (escaped JSON on the wire). */
  data?: Record<string, string>;
  /** Extra `links` members (escaped JSON on the wire). */
  links?: Record<string, unknown>;
}

export interface WebhookOptions {
  /** Real API retries for ~6 hours; the mock shortens this to a few quick attempts. */
  maxAttempts: number;
  retryDelayMs: number;
  /** SOURCE: implementing-webhooks — "respond within 3 seconds". */
  timeoutMs: number;
  tplId: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WebhookDispatcher {
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  /** When the current key became current; drives the 304 on previousRetrievalDateISO. */
  keyGeneratedAt: Date;
  subscriptions: WebhookSubscription[] = [];
  deliveries: WebhookDelivery[] = [];
  /** Promises of in-flight deliveries so tests can `await flush()`; never blocks a response. */
  pending: Promise<WebhookDelivery>[] = [];
  private nextDeliveryId = 1;
  private nextEventId = 2_000_000;
  private nextTransactionEventId = 1;
  private fetchImpl: typeof fetch;

  constructor(
    public options: WebhookOptions,
    fetchImpl: typeof fetch = fetch,
  ) {
    // The real service signs with RSA-SHA256 and publishes an spki PEM (SOURCE: implementing-webhooks).
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.keyGeneratedAt = new Date();
    this.fetchImpl = fetchImpl;
  }

  sign(rawBody: string): string {
    const signer = createSign('RSA-SHA256');
    signer.update(rawBody);
    return signer.sign(this.privateKey).toString('base64');
  }

  reset(): void {
    this.subscriptions = [];
    this.deliveries = [];
    this.pending = [];
  }

  addSubscription(sub: WebhookSubscription): void {
    this.subscriptions.push(sub);
  }

  matching(input: EmitInput): WebhookSubscription[] {
    return this.subscriptions.filter((s) => {
      if (s.resource.toLowerCase() !== input.resource.toLowerCase()) return false;
      // Seeded customer subscriptions only fire for that customer; "Any Customer" (control-plane) fire for all
      // (SOURCE: configuring-webhooks "Webhook Scope (a customer or 'Any Customer')").
      if (s.customerId !== null && s.customerId !== input.customerId) return false;
      if (s.eventTypes.length === 0) return true;
      return s.eventTypes.some((e) => e.toLowerCase() === input.eventType.toLowerCase());
    });
  }

  buildPayload(input: EmitInput, sub: WebhookSubscription, now: Date): WebhookPayload {
    // GUESS: the sample href carries `?detail=OrderItems`; the mock appends the subscription's
    // resourceApiParameters, which is what that query string most plausibly comes from.
    const href = `${input.resourcePath}${sub.resourceApiParameters ? `?${sub.resourceApiParameters}` : ''}`;
    const links = {
      // SOURCE: implementing-webhooks sample links block.
      'uiproperties/user': { LastModifiedBy: '/uiproperties/users/-1' },
      'customers/customer': `/customers/${input.customerId}`,
      'properties/facility': `/properties/facilities/${input.facilityId}`,
      ...(input.links ?? {}),
    };
    const idKey = input.resource === 'Order' ? 'OrderId' : `${input.resource}Id`;
    const data = { [idKey]: String(input.resourceId), ...(input.data ?? {}) };
    const payload: WebhookPayload = {
      tplId: this.options.tplId,
      wmsEventId: this.nextEventId++,
      dateTime: webhookDate(now),
      eventDateTimeUtc: webhookDate(now),
      warehouseTransactionEventId: this.nextTransactionEventId++,
      createDateTimeUtc: webhookDate(new Date(now.getTime() + 3000)),
      eventType: input.eventType,
      resource: { rel: input.resourceRel, href },
      links: JSON.stringify(links),
      data: JSON.stringify(data),
      tags: input.tags ?? '',
    };
    if (sub.includeResource && input.resourceBody !== undefined) {
      // SOURCE: implementing-webhooks — resource.body only when "Include resource in payload".
      payload.resource.body = JSON.stringify(input.resourceBody);
    }
    return payload;
  }

  /** Fire-and-forget; returns the delivery records created (one per matching subscription). */
  emit(input: EmitInput, now: Date = new Date()): WebhookDelivery[] {
    const out: WebhookDelivery[] = [];
    for (const sub of this.matching(input)) {
      const payload = this.buildPayload(input, sub, now);
      const body = JSON.stringify(payload);
      const delivery: WebhookDelivery = {
        deliveryId: this.nextDeliveryId++,
        url: sub.url,
        eventType: input.eventType,
        resourceRel: input.resourceRel,
        resourceId: input.resourceId,
        tags: payload.tags,
        body,
        signature: this.sign(body),
        attempts: [],
        ok: false,
        done: false,
      };
      this.deliveries.push(delivery);
      out.push(delivery);
      const p = this.deliver(delivery).catch(() => delivery);
      this.pending.push(p);
    }
    return out;
  }

  private async deliver(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      const at = new Date().toISOString();
      try {
        const res = await this.fetchImpl(delivery.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Signature: delivery.signature },
          body: delivery.body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        delivery.attempts.push({ attempt, status: res.status, error: null, at });
        // SOURCE: implementing-webhooks — any 20x counts as accepted.
        if (res.status >= 200 && res.status < 300) {
          delivery.ok = true;
          break;
        }
      } catch (e) {
        delivery.attempts.push({ attempt, status: null, error: (e as Error).message, at });
      }
      if (attempt < this.options.maxAttempts) await sleep(this.options.retryDelayMs);
    }
    delivery.done = true;
    return delivery;
  }

  async flush(): Promise<WebhookDelivery[]> {
    // Deliveries can enqueue while awaiting, so loop until the queue drains.
    const seen = new Set<Promise<WebhookDelivery>>();
    let result: WebhookDelivery[] = [];
    for (;;) {
      const batch = this.pending.filter((p) => !seen.has(p));
      if (batch.length === 0) break;
      batch.forEach((p) => seen.add(p));
      result = result.concat(await Promise.all(batch));
    }
    this.pending = [];
    return result;
  }
}
