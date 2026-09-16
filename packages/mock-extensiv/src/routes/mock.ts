/**
 * MOCK-ONLY CONTROL PLANE — none of these paths exist on the real Extensiv API.
 *
 * Everything under `/__mock/` is a test harness: reseed the world, read the request log, inject
 * faults, force webhook emissions and move stock. It is deliberately unauthenticated so a test can
 * reach it without a token, and it is excluded from the bearer middleware and the fault middleware.
 * Never point an integration at these paths expecting production behaviour.
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import { modelValidation } from '../errors.js';
import type { FaultRequest, OnceFault } from '../faults.js';
import { emptyFaults } from '../faults.js';
import type { EmitInput } from '../webhooks.js';
import type { MockState } from '../state.js';
import { jsonBody } from './common.js';

const JSON_CT = 'application/json; charset=utf-8';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status: status as 200, headers: { 'Content-Type': JSON_CT } });
}

function str(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function num(body: Record<string, unknown>, name: string): number | undefined {
  const v = body[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function mockControlRoutes(state: MockState, reseed: (kind: 'default' | 'empty') => void): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  /** Re-seed the world. Body `{ "seed": "default" | "empty" }`. */
  app.post('/__mock/reset', async (c) => {
    const body = await jsonBody(c);
    const kind = str(body, 'seed') === 'empty' ? 'empty' : 'default';
    reseed(kind);
    return json({ ok: true, seed: kind, orders: state.orders.length, receivers: state.receivers.length, lots: state.lots.length });
  });

  /** The request log. Authorization headers were redacted when the entry was recorded. */
  app.get('/__mock/requests', (c) => {
    const limit = Number(c.req.query('limit') ?? '0');
    const rows = Number.isInteger(limit) && limit > 0 ? state.requests.slice(-limit) : state.requests;
    return json({ totalResults: state.requests.length, requests: rows });
  });

  app.delete('/__mock/requests', () => {
    state.requests.length = 0;
    return new Response(null, { status: 204 });
  });

  /** Fault injection: `{ expireAllTokens?, once?: [...], latencyMs?, clear? }`. */
  app.post('/__mock/faults', async (c) => {
    const body = (await jsonBody(c)) as FaultRequest;
    if (body.clear === true) state.faults = emptyFaults();
    if (body.expireAllTokens === true) state.expireAllTokens();
    if (typeof body.latencyMs === 'number' && Number.isFinite(body.latencyMs)) {
      state.faults.latencyMs = Math.max(0, body.latencyMs);
    }
    if (Array.isArray(body.once)) {
      for (const raw of body.once) {
        state.faults.once.push(normaliseFault(raw));
      }
    }
    return json({ ok: true, faults: state.faults });
  });

  app.get('/__mock/state', () => json(state.dump()));

  /** Add a webhook subscription that fires for every customer ("Any Customer" scope). */
  app.post('/__mock/webhooks', async (c) => {
    const body = await jsonBody(c);
    const url = str(body, 'url');
    if (url === undefined) throw modelValidation('Required', [{ Name: 'url', Value: null }], 'url is required');
    const resource = str(body, 'resource') ?? 'Order';
    const eventTypes = Array.isArray(body.eventTypes)
      ? body.eventTypes.filter((e): e is string => typeof e === 'string')
      : typeof body.eventTypes === 'string'
        ? body.eventTypes.split(',').map((s) => s.trim()).filter((s) => s !== '')
        : [];
    const subscription = {
      name: str(body, 'name') ?? `mock-${state.webhooks.subscriptions.length + 1}`,
      resource,
      eventTypes,
      url,
      includeResource: body.includeResource !== false,
      resourceApiParameters: str(body, 'resourceApiParameters') ?? null,
      customerId: num(body, 'customerId') ?? null,
    };
    state.webhooks.addSubscription(subscription);
    return json({ ok: true, subscription }, 201);
  });

  /** Force an emission without performing the underlying business operation. */
  app.post('/__mock/webhooks/emit', async (c) => {
    const body = await jsonBody(c);
    const eventType = str(body, 'eventType') ?? 'OrderUpdate';
    const resourceRel = str(body, 'resourceRel') ?? 'orders/order';
    const resourceId = num(body, 'resourceId') ?? 0;
    const input = emitInputFor(state, eventType, resourceRel, resourceId);
    const deliveries = state.emitWebhook(input);
    return json({ ok: true, emitted: deliveries.length, deliveryIds: deliveries.map((d) => d.deliveryId) });
  });

  /** Delivery log. Waits for in-flight deliveries unless `?flush=false`. */
  app.get('/__mock/webhooks/deliveries', async (c) => {
    if (!/^(false|0)$/i.test((c.req.query('flush') ?? '').trim())) await state.flushWebhooks();
    return json({ totalResults: state.webhooks.deliveries.length, deliveries: state.webhooks.deliveries });
  });

  /** Move stock without a receipt: `{ customerId, facilityId, sku, onHandDelta }`. */
  app.post('/__mock/stock', async (c) => {
    const body = await jsonBody(c);
    const customerId = num(body, 'customerId');
    const facilityId = num(body, 'facilityId');
    const sku = str(body, 'sku');
    const onHandDelta = num(body, 'onHandDelta');
    if (customerId === undefined || facilityId === undefined || sku === undefined || onHandDelta === undefined) {
      throw modelValidation(
        'Required',
        [{ Name: 'customerId/facilityId/sku/onHandDelta', Value: null }],
        'customerId, facilityId, sku and onHandDelta are all required',
      );
    }
    const lot = state.adjustStock(customerId, facilityId, sku, onHandDelta);
    return json({ ok: true, lot });
  });

  return app;
}

function normaliseFault(raw: OnceFault): OnceFault {
  if (typeof raw?.match !== 'string' || raw.match.trim() === '') {
    throw modelValidation('Required', [{ Name: 'once[].match', Value: null }], 'match must look like "METHOD /path-prefix"');
  }
  const status = typeof raw.status === 'number' ? raw.status : 500;
  const fault: OnceFault = { match: raw.match.trim(), status };
  if (typeof raw.retryAfterSeconds === 'number') fault.retryAfterSeconds = raw.retryAfterSeconds;
  if (raw.body !== undefined) fault.body = raw.body;
  if (raw.dropConnection === true) fault.dropConnection = true;
  return fault;
}

/** Build a plausible EmitInput for a forced emission, filling customer/facility from the resource. */
function emitInputFor(state: MockState, eventType: string, resourceRel: string, resourceId: number): EmitInput {
  if (resourceRel.startsWith('inventory/receiver')) {
    const rec = state.receiverById(resourceId);
    const ro = rec?.receiver.readOnly;
    return {
      eventType,
      resource: 'Receiver',
      resourceRel,
      resourceId,
      resourcePath: `/inventory/receivers/${resourceId}`,
      customerId: ro?.customerIdentifier.id ?? 0,
      facilityId: ro?.facilityIdentifier.id ?? 0,
      resourceBody: rec ? state.renderReceiver(rec, { items: true }) : undefined,
    };
  }
  const rec = state.orderById(resourceId);
  const ro = rec?.order.readOnly;
  return {
    eventType,
    resource: 'Order',
    resourceRel,
    resourceId,
    resourcePath: `/orders/${resourceId}`,
    customerId: ro?.customerIdentifier.id ?? 0,
    facilityId: ro?.facilityIdentifier.id ?? 0,
    resourceBody: rec ? state.renderOrder(rec, { items: true, packages: false, allocations: false }) : undefined,
  };
}
