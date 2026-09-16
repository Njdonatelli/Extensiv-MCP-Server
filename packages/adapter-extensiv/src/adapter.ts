/**
 * WmsAdapter implementation for the Extensiv 3PL Warehouse Manager REST API.
 *
 * Division of labour: core owns policy, the two-phase mutation engine and the
 * tool surface; this file owns endpoints, RQL translation, ETag/If-Match
 * concurrency and the error taxonomy. Every upstream call goes through core's
 * HttpClient, which already implements the one-shot 401 re-auth, 429 Retry-After,
 * bounded backoff and OUTCOME_UNKNOWN on a lost response for non-idempotent
 * requests — none of that is repeated here.
 *
 * Citations: `// SOURCE: <url>` for documented behaviour, `// INFERRED:` for an
 * RQL property name or semantic the docs do not spell out, `// GUESS:` for a
 * value we had to choose. The README lists every INFERRED name in one table.
 */
import { HttpClient, UpstreamHttpError, WmsError, silentLogger, systemClock } from '@mcp-3pl/core';
import type {
  AdapterInfo,
  Address,
  CancelOrderInput,
  Clock,
  ConnectionStatus,
  CreateOrderInput,
  CreateReceiptInput,
  Customer,
  CustomerRef,
  Facility,
  FacilityRef,
  HttpResponse,
  InventoryPosition,
  InventoryQuery,
  Item,
  ItemQuery,
  Logger,
  MutationInputMap,
  MutationKind,
  MutationOutcome,
  MutationPlan,
  OrderDetail,
  OrderQuery,
  OrderRef,
  OrderStatus,
  OrderSummary,
  Page,
  Precondition,
  PreconditionResult,
  ReceiptDetail,
  ReceiptQuery,
  ReceiptRef,
  ReceiptSummary,
  TokenProvider,
  UpdateOrderInput,
  UpstreamRequest,
  WmsAdapter,
} from '@mcp-3pl/core';
import { ExtensivTokenProvider } from './auth.js';
import type { ExtensivConfig } from './config.js';
import { REL, embedded, pageAll, toWireId, totalResults } from './hal.js';
import { attachLots, toCustomer, toFacility, toInventoryPositions, toItem, toOrderDetail, toOrderSummary, toReceiptDetail, toReceiptSummary, type RefMaps } from './mapping.js';
import { and, contains, eq, ge, hv, inList, lt, ne, or } from './rql.js';
import { WIRE_STATUS } from './wire.js';
import type { WireCustomer, WireErrorBody, WireFacility, WireItem, WireOrder, WireReceiver, WireStockDetail, WireStockSummary } from './wire.js';

const SYSTEM = 'extensiv-3pl-warehouse-manager';
const DISPLAY_NAME = 'Extensiv 3PL Warehouse Manager';

/**
 * Per-rel `pgsiz` ceilings (SOURCE https://3w.extensiv.com/Rels/rql). Exceeding
 * one is an error, so these are the largest page this adapter ever asks for.
 * /properties/facilities is absent from that table; 100 is used as a safe value.
 */
const MAX_PGSIZ = {
  orders: 1000,
  customers: 100,
  facilities: 100,
  items: 100,
  receivers: 500,
  stockSummaries: 500,
  stockDetails: 500,
} as const;

/** The id->name maps are needed by almost every mapping, so they are cached briefly. */
const REF_CACHE_TTL_MS = 60_000;

/** Upper bound on /inventory/stockdetails calls per getInventory, since customerid+facilityid are both required. */
const MAX_LOT_REQUESTS = 8;

/**
 * Token provider plus the two optional diagnostics ExtensivTokenProvider offers.
 * A caller may inject any TokenProvider; verifyConnection degrades gracefully.
 */
export interface DescribableTokenProvider extends TokenProvider {
  expiresInSeconds?(): number | undefined;
  describe?(): { clientIdMasked?: string; userLogin?: string; tplGuid?: string; authUrl?: string; logins?: number };
}

export interface ExtensivAdapterDeps {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  tokenProvider?: DescribableTokenProvider;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function statusOf(e: unknown): number | undefined {
  if (e instanceof UpstreamHttpError) return e.status;
  // Duck-typing as well: a workspace with two copies of core would break instanceof.
  const o = e as { name?: string; status?: unknown; details?: { status?: unknown } } | null;
  if (o && typeof o === 'object') {
    if (typeof o.status === 'number') return o.status;
    if (o.details && typeof o.details.status === 'number') return o.details.status;
  }
  return undefined;
}

function errorBodyOf(e: unknown): WireErrorBody | undefined {
  const body = e instanceof UpstreamHttpError ? e.body : (e as { body?: unknown } | null)?.body;
  return body !== null && typeof body === 'object' ? (body as WireErrorBody) : undefined;
}

/** ErrorCode from a plain exception body or from the first fault of a ListException. */
function errorCodeOf(body: WireErrorBody | undefined): string | undefined {
  if (!body) return undefined;
  if (typeof body.ErrorCode === 'string') return body.ErrorCode;
  const fault = body.Faults?.find((f) => typeof f.WmsException?.ErrorCode === 'string');
  return fault?.WmsException?.ErrorCode;
}

function hintOf(body: WireErrorBody | undefined): string | undefined {
  if (!body) return undefined;
  if (typeof body.Hint === 'string' && body.Hint.trim() !== '') return body.Hint;
  const fault = body.Faults?.find((f) => typeof f.WmsException?.Hint === 'string');
  return fault?.WmsException?.Hint;
}

function isOperationException(body: WireErrorBody | undefined): boolean {
  return typeof body?.$type === 'string' && body.$type.includes('OperationException');
}

/**
 * Maps an Extensiv HTTP failure onto the core error taxonomy.
 * SOURCE https://3w.extensiv.com/Rels/exceptions (status codes, `$type`, ErrorCode, Hint)
 * and https://3w.extensiv.com/Rels/headers (412 / 428 semantics).
 *
 * 400 with ErrorCode `Duplicate` is deliberately NOT handled here: the caller has
 * to re-run the natural-key lookup first, because a duplicate reference number is
 * exactly what a retried create after a lost response looks like.
 */
export function translateUpstreamError(e: unknown, context: { what: string }): WmsError {
  const status = statusOf(e);
  const body = errorBodyOf(e);
  const code = errorCodeOf(body);
  const hint = hintOf(body);
  if (status === 412) {
    return new WmsError('PRECONDITION_FAILED', `${context.what} was rejected with 412: the resource changed upstream after the preview was built.`, {
      hint: 'Prepare the change again so the preview and the If-Match version reflect current state, then commit the new change id.',
      details: { status, errorCode: code },
      cause: e,
    });
  }
  if (status === 428) {
    // 428 means the server wanted If-Match and did not get one. This adapter always
    // sends it for a PUT or an operator, so a 428 is our bug, not the operator's.
    return new WmsError('INTERNAL', `${context.what} was rejected with 428 (If-Match required) although this adapter always sends If-Match.`, {
      hint: 'Report this: the version captured from the ETag was empty when the request was built.',
      details: { status },
      cause: e,
    });
  }
  if (status === 403) {
    if (isOperationException(body)) {
      return new WmsError('VALIDATION', `${context.what} is not allowed in the order's current state${code ? ` (${code})` : ''}.`, {
        hint: hint ?? 'Re-read the order: an operation like confirm, cancel or complete may already have been applied.',
        details: { status, errorCode: code, actionName: body?.ActionName },
        cause: e,
      });
    }
    return new WmsError('SCOPE_DENIED', `${context.what} was refused with 403: the API credential lacks the required role.`, {
      hint: hint ?? 'Add the missing role to the credential in the Extensiv Support Portal (Manage Credentials) and try again.',
      details: { status, errorCode: code },
      cause: e,
    });
  }
  if (status === 404) {
    return new WmsError('NOT_FOUND', `${context.what} failed with 404: the resource does not exist (or is not visible to this credential).`, {
      details: { status, errorCode: code },
      cause: e,
    });
  }
  if (status === 400) {
    return new WmsError('VALIDATION', `${context.what} was rejected with 400${code ? ` (${code})` : ''}.`, {
      hint: hint ?? 'Fix the highlighted field and prepare the change again.',
      details: { status, errorCode: code, properties: body?.Properties },
      cause: e,
    });
  }
  // Anything else (429, 5xx, transport) already carries the right code from HttpClient.
  if (e instanceof WmsError) return e;
  return new WmsError('UPSTREAM_ERROR', `${context.what} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
}

// ---------------------------------------------------------------------------
// RQL translation
// ---------------------------------------------------------------------------

/**
 * Order status -> RQL.
 * SOURCE https://3w.extensiv.com/Rels/rql: "for rql on orders, `status` is only
 * reliable for Canceled; otherwise filter on readonly.isclosed".
 * The domain's 'complete' is not a distinct API status (see mapping.toOrderStatus),
 * so it selects the same rows as 'open'.
 */
export function orderStatusRql(statuses: OrderStatus[] | undefined): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  const want = new Set(statuses);
  const groups: string[] = [];
  if (want.has('cancelled')) groups.push(eq('readonly.status', WIRE_STATUS.cancelled));
  if (want.has('closed')) groups.push(eq('readonly.isclosed', true));
  if (want.has('open') || want.has('complete')) {
    // An open order is one that is not closed and not cancelled.
    groups.push(`(${and(eq('readonly.isclosed', false), ne('readonly.status', WIRE_STATUS.cancelled))})`);
  }
  if (groups.length <= 1) return groups[0];
  return or(...groups);
}

export function orderRql(query: OrderQuery): string {
  return and(
    // INFERRED: readonly.customeridentifier.id / readonly.facilityidentifier.id — the rql doc
    // shows `customeridentifier.id` as the dotted-nesting example but never names these two
    // on the order model; they follow the documented model property path.
    query.customerId !== undefined && eq('readonly.customeridentifier.id', toWireId(query.customerId)),
    query.facilityId !== undefined && eq('readonly.facilityidentifier.id', toWireId(query.facilityId)),
    // SOURCE https://3w.extensiv.com/Rels/rql names readonly.creationdate verbatim.
    query.createdAfter !== undefined && ge('readonly.creationdate', query.createdAfter),
    query.createdBefore !== undefined && lt('readonly.creationdate', query.createdBefore),
    // INFERRED: readonly.shipdate (the field exists on the model; its rql spelling is not shown).
    query.shippedAfter !== undefined && ge('readonly.shipdate', query.shippedAfter),
    query.shippedBefore !== undefined && lt('readonly.shipdate', query.shippedBefore),
    // INFERRED: readonly.onholddate with the documented `=hv=` (has-value) operator; an order is
    // on hold exactly while it has a hold date.
    query.onHold !== undefined && hv('readonly.onholddate', query.onHold),
    // INFERRED: referencenum / shipto.name as rql property names.
    query.referenceNum !== undefined && eq('referencenum', query.referenceNum),
    query.referenceNumContains !== undefined && contains('referencenum', query.referenceNumContains),
    query.shipToNameContains !== undefined && contains('shipto.name', query.shipToNameContains),
    orderStatusRql(query.statuses),
  );
}

/** Receipt status codes share the order enum (SOURCE https://3w.extensiv.com/rels/inventory/receiver). */
export function receiptStatusRql(statuses: ReceiptSummary['status'][] | undefined): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  const codes = new Set<number>();
  for (const s of statuses) {
    if (s === 'cancelled') codes.add(WIRE_STATUS.cancelled);
    else if (s === 'closed') codes.add(WIRE_STATUS.closed);
    else codes.add(WIRE_STATUS.open); // open and complete are both status 0 upstream
  }
  const list = [...codes];
  if (list.length === 0) return undefined;
  // INFERRED: readonly.status is the rql spelling for a receiver's status.
  return list.length === 1 ? eq('readonly.status', list[0]!) : inList('readonly.status', list);
}

export function receiptRql(query: ReceiptQuery): string {
  return and(
    // INFERRED: same identifier paths as orders.
    query.customerId !== undefined && eq('readonly.customeridentifier.id', toWireId(query.customerId)),
    query.facilityId !== undefined && eq('readonly.facilityidentifier.id', toWireId(query.facilityId)),
    query.referenceNum !== undefined && eq('referencenum', query.referenceNum),
    // INFERRED: ponum / expecteddate / arrivaldate as rql property names.
    query.poNum !== undefined && eq('ponum', query.poNum),
    query.expectedAfter !== undefined && ge('expecteddate', query.expectedAfter),
    query.expectedBefore !== undefined && lt('expecteddate', query.expectedBefore),
    query.createdAfter !== undefined && ge('readonly.creationdate', query.createdAfter),
    receiptStatusRql(query.statuses),
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function blank(v: string | undefined | null): boolean {
  return v === undefined || v === null || String(v).trim() === '';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ExtensivAdapter implements WmsAdapter {
  readonly info: AdapterInfo;
  private readonly cfg: ExtensivConfig;
  private readonly http: HttpClient;
  private readonly tokens: DescribableTokenProvider;
  private readonly log: Logger;
  private readonly clock: Clock;
  private customerCache: CacheEntry<Customer[]> | undefined;
  private facilityCache: CacheEntry<Facility[]> | undefined;

  constructor(cfg: ExtensivConfig, deps: ExtensivAdapterDeps = {}) {
    this.cfg = cfg;
    this.log = (deps.logger ?? silentLogger).child({ adapter: SYSTEM });
    this.clock = deps.clock ?? systemClock;
    this.tokens =
      deps.tokenProvider ??
      new ExtensivTokenProvider(cfg, { fetchImpl: deps.fetchImpl, clock: this.clock, logger: this.log });
    this.http = new HttpClient({
      baseUrl: cfg.baseUrl,
      tokenProvider: this.tokens,
      // SOURCE https://3w.extensiv.com/Rels/headers: hal+json in both directions.
      defaultHeaders: { Accept: 'application/hal+json' },
      timeoutMs: cfg.httpTimeoutMs,
      maxRetries: cfg.maxRetries,
      logger: this.log,
      fetchImpl: deps.fetchImpl,
    });
    this.info = {
      system: SYSTEM,
      displayName: DISPLAY_NAME,
      baseUrl: cfg.baseUrl,
      environmentLabel: cfg.environmentLabel,
    };
  }

  // ---- low-level helpers -------------------------------------------------

  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<HttpResponse<T>> {
    return this.http.request<T>({ method: 'GET', path, query });
  }

  /** GET that answers null on 404 instead of throwing, for "does it exist" reads. */
  private async getMaybe<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<HttpResponse<T> | null> {
    try {
      return await this.get<T>(path, query);
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw translateUpstreamError(e, { what: `GET ${path}` });
    }
  }

  // ---- connection --------------------------------------------------------

  async verifyConnection(): Promise<ConnectionStatus> {
    const started = this.clock.now().getTime();
    const problems: string[] = [];
    let authenticated = false;
    try {
      await this.tokens.getToken();
      authenticated = true;
    } catch (e) {
      problems.push(e instanceof WmsError ? `authentication failed (${e.code}): ${e.message}` : `authentication failed: ${String(e)}`);
    }

    let reachableFacilities: number | undefined;
    let reachableCustomers: number | undefined;
    if (authenticated) {
      // pgsiz=1 keeps the probe cheap; totalResults still reports the full count.
      reachableFacilities = await this.probeCount('/properties/facilities', 'FacilityView (and ReadPropertiesThirdParty)', problems);
      reachableCustomers = await this.probeCount('/customers', 'CustomerView', problems);
    }

    const identity: ConnectionStatus['identity'] = {};
    const described = this.tokens.describe?.();
    if (described) {
      identity.userLogin = described.userLogin;
      identity.clientIdMasked = described.clientIdMasked;
      identity.tplId = described.tplGuid;
    }

    return {
      ok: authenticated && problems.length === 0,
      system: SYSTEM,
      baseUrl: this.cfg.baseUrl,
      environmentLabel: this.cfg.environmentLabel,
      authenticated,
      tokenExpiresInSeconds: this.tokens.expiresInSeconds?.(),
      identity,
      reachableCustomers,
      reachableFacilities,
      latencyMs: Math.max(0, this.clock.now().getTime() - started),
      problems,
    };
  }

  /** A 403 on a probe is a configuration problem to report, never a thrown error. */
  private async probeCount(path: string, roles: string, problems: string[]): Promise<number | undefined> {
    try {
      const res = await this.get(path, { pgsiz: 1 });
      return totalResults(res.body, 0);
    } catch (e) {
      const status = statusOf(e);
      if (status === 403) {
        const hint = hintOf(errorBodyOf(e));
        problems.push(`GET ${path} returned 403: the credential is missing the ${roles} role${hint ? ` (${hint})` : ''}.`);
        return undefined;
      }
      problems.push(`GET ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  // ---- reference data ----------------------------------------------------

  async listCustomers(): Promise<Customer[]> {
    const fresh = this.customerCache && this.clock.now().getTime() - this.customerCache.at < REF_CACHE_TTL_MS;
    if (fresh && this.customerCache) return this.customerCache.value;
    const { items } = await pageAll<WireCustomer>(
      async (pgnum, pgsiz) => {
        const res = await this.get(`/customers`, { pgsiz, pgnum });
        return { items: embedded<WireCustomer>(res.body, REL.customer), total: totalResults(res.body, 0) };
      },
      { pageSize: MAX_PGSIZ.customers },
    );
    const value = items.map(toCustomer);
    this.customerCache = { at: this.clock.now().getTime(), value };
    return value;
  }

  async listFacilities(): Promise<Facility[]> {
    const fresh = this.facilityCache && this.clock.now().getTime() - this.facilityCache.at < REF_CACHE_TTL_MS;
    if (fresh && this.facilityCache) return this.facilityCache.value;
    const { items } = await pageAll<WireFacility>(
      async (pgnum, pgsiz) => {
        const res = await this.get(`/properties/facilities`, { pgsiz, pgnum });
        return { items: embedded<WireFacility>(res.body, REL.facility), total: totalResults(res.body, 0) };
      },
      { pageSize: MAX_PGSIZ.facilities },
    );
    const value = items.map(toFacility);
    this.facilityCache = { at: this.clock.now().getTime(), value };
    return value;
  }

  /** id->name maps for mapping. Never fails a read: rows usually carry their own names. */
  private async refMaps(): Promise<RefMaps> {
    try {
      const [customers, facilities] = await Promise.all([this.listCustomers(), this.listFacilities()]);
      return {
        customers: new Map(customers.map((c) => [c.id, c.name])),
        facilities: new Map(facilities.map((f) => [f.id, f.name])),
      };
    } catch (e) {
      this.log.warn('could not load customer/facility names', { err: e instanceof Error ? e.message : String(e) });
      return {};
    }
  }

  private async requireCustomer(customerId: string): Promise<Customer> {
    const customers = await this.listCustomers();
    const found = customers.find((c) => c.id === String(customerId));
    if (!found) {
      throw new WmsError('NOT_FOUND', `No customer with id '${customerId}' is visible to this credential.`, {
        hint: 'Call describe_scope to list the customer ids this server can see.',
        details: { customers: customers.map((c) => ({ id: c.id, name: c.name })) },
      });
    }
    return found;
  }

  /** A facility is usable for a customer only when it is on that customer's facility list. */
  private async requireCustomerFacility(customer: Customer, facilityId: string): Promise<FacilityRef> {
    const onCustomer = customer.facilities.find((f) => f.id === String(facilityId));
    if (onCustomer) return onCustomer;
    const facilities = await this.listFacilities();
    const exists = facilities.find((f) => f.id === String(facilityId));
    throw new WmsError('VALIDATION', exists ? `Facility ${facilityId} (${exists.name}) is not enabled for customer ${customer.id} (${customer.name}).` : `No facility with id '${facilityId}' is visible to this credential.`, {
      hint: `Customer ${customer.name} can use: ${customer.facilities.map((f) => `${f.id} (${f.name})`).join(', ') || '(none listed)'}.`,
      details: { customerFacilities: customer.facilities },
    });
  }

  // ---- orders ------------------------------------------------------------

  async findOrders(query: OrderQuery): Promise<Page<OrderSummary>> {
    const pageSize = clamp(query.limit ?? 50, 1, MAX_PGSIZ.orders);
    const pgnum = Math.max(1, Math.trunc(query.page ?? 1));
    const rql = orderRql(query);
    const res = await this.get(`/orders`, {
      // detail=OrderItems gives line counts and unit totals in one round trip.
      detail: 'OrderItems',
      sort: '-readonly.creationdate',
      pgsiz: pageSize,
      pgnum,
      rql: rql === '' ? undefined : rql,
      // SOURCE https://3w.extensiv.com/rels/orders/orders: SKU filtering is a documented
      // query parameter (`skulist`), not an rql property.
      skulist: query.sku,
    });
    const names = await this.refMaps();
    const rows = embedded<WireOrder>(res.body, REL.order);
    const items = rows.map((r) => toOrderSummary(r, names));
    const total = totalResults(res.body, items.length);
    return { items, total, page: pgnum, pageSize, hasMore: pgnum * pageSize < total };
  }

  async getOrder(ref: OrderRef): Promise<OrderDetail | null> {
    if (ref.id !== undefined && ref.id !== '') {
      const res = await this.getMaybe<WireOrder>(`/orders/${encodeURIComponent(ref.id)}`, { detail: 'All', itemdetail: 'All' });
      if (!res) return null;
      return toOrderDetail(res.body, { version: res.etag, names: await this.refMaps() });
    }
    if (blank(ref.referenceNum)) {
      throw new WmsError('VALIDATION', 'getOrder needs either an order id or a reference number.');
    }
    const id = await this.orderIdByReference(ref.referenceNum!, ref.customerId);
    if (id === null) return null;
    // Fetched by id so the ETag belongs to the order resource and can be used as If-Match.
    return this.getOrder({ id });
  }

  /** null when nothing matches; throws AMBIGUOUS when a reference number spans customers. */
  private async orderIdByReference(referenceNum: string, customerId?: string): Promise<string | null> {
    const rql = and(eq('referencenum', referenceNum), customerId !== undefined && eq('readonly.customeridentifier.id', toWireId(customerId)));
    const res = await this.get(`/orders`, { rql, pgsiz: 25, detail: 'None' });
    const rows = embedded<WireOrder>(res.body, REL.order);
    if (rows.length === 0) return null;
    if (rows.length === 1) {
      const id = rows[0]!.readOnly?.orderId;
      return id === undefined ? null : String(id);
    }
    const candidates = rows.map((r) => ({
      orderId: r.readOnly?.orderId !== undefined ? String(r.readOnly.orderId) : '',
      customerId: r.readOnly?.customerIdentifier?.id !== undefined ? String(r.readOnly.customerIdentifier.id) : '',
      customerName: r.readOnly?.customerIdentifier?.name ?? '',
    }));
    throw new WmsError('AMBIGUOUS', `Reference number '${referenceNum}' matches ${rows.length} orders (customers: ${candidates.map((c) => `${c.customerName || c.customerId}`).join(', ')}).`, {
      hint: 'Reference numbers are unique per customer, not per 3PL. Pass customer_id, or use the order id.',
      details: { candidates },
    });
  }

  // ---- receipts ----------------------------------------------------------

  async findReceipts(query: ReceiptQuery): Promise<Page<ReceiptSummary>> {
    const pageSize = clamp(query.limit ?? 50, 1, MAX_PGSIZ.receivers);
    const pgnum = Math.max(1, Math.trunc(query.page ?? 1));
    const rql = receiptRql(query);
    const res = await this.get(`/inventory/receivers`, {
      detail: 'ReceiveItems',
      sort: '-readonly.creationdate',
      pgsiz: pageSize,
      pgnum,
      rql: rql === '' ? undefined : rql,
    });
    const names = await this.refMaps();
    const rows = embedded<WireReceiver>(res.body, REL.receiver);
    const items = rows.map((r) => toReceiptSummary(r, names));
    const total = totalResults(res.body, items.length);
    return { items, total, page: pgnum, pageSize, hasMore: pgnum * pageSize < total };
  }

  async getReceipt(ref: ReceiptRef): Promise<ReceiptDetail | null> {
    if (ref.id !== undefined && ref.id !== '') {
      const res = await this.getMaybe<WireReceiver>(`/inventory/receivers/${encodeURIComponent(ref.id)}`, { detail: 'All' });
      if (!res) return null;
      return toReceiptDetail(res.body, { version: res.etag, names: await this.refMaps() });
    }
    if (blank(ref.referenceNum)) {
      throw new WmsError('VALIDATION', 'getReceipt needs either a receipt id or a reference number.');
    }
    const id = await this.receiptIdByReference(ref.referenceNum!, ref.customerId);
    if (id === null) return null;
    return this.getReceipt({ id });
  }

  private async receiptIdByReference(referenceNum: string, customerId?: string): Promise<string | null> {
    const rql = and(eq('referencenum', referenceNum), customerId !== undefined && eq('readonly.customeridentifier.id', toWireId(customerId)));
    const res = await this.get(`/inventory/receivers`, { rql, pgsiz: 25, detail: 'None' });
    const rows = embedded<WireReceiver>(res.body, REL.receiver);
    if (rows.length === 0) return null;
    if (rows.length === 1) {
      const id = rows[0]!.readOnly?.receiverId;
      return id === undefined ? null : String(id);
    }
    throw new WmsError('AMBIGUOUS', `Reference number '${referenceNum}' matches ${rows.length} receipts.`, {
      hint: 'Pass customer_id, or use the receipt id.',
      details: {
        candidates: rows.map((r) => ({
          receiptId: r.readOnly?.receiverId !== undefined ? String(r.readOnly.receiverId) : '',
          customerName: r.readOnly?.customerIdentifier?.name ?? '',
        })),
      },
    });
  }

  // ---- inventory ---------------------------------------------------------

  async getInventory(query: InventoryQuery): Promise<InventoryPosition[]> {
    const limit = clamp(query.limit ?? 200, 1, 5000);
    const [customers, facilities] = await Promise.all([this.listCustomers(), this.listFacilities()]);
    const facilityNames = new Map(facilities.map((f) => [f.id, f.name]));
    const targets: Customer[] = query.customerId !== undefined ? [await this.requireCustomer(query.customerId)] : customers.filter((c) => c.active);
    const requestedFacility = query.facilityId !== undefined ? (facilities.find((f) => f.id === String(query.facilityId)) ?? { id: String(query.facilityId), name: String(query.facilityId) }) : undefined;

    const positions: InventoryPosition[] = [];
    let lotRequests = 0;
    for (const customer of targets) {
      if (positions.length >= limit) break;
      const rql = and(
        // INFERRED: /inventory/stocksummaries rows carry no customer at all, so the customer
        // filter can only be an rql property; `customeridentifier.id` is the doc's own
        // dotted-nesting example but is not listed for this rel.
        eq('customeridentifier.id', toWireId(customer.id)),
        // INFERRED: `facilityid` (the summary row spells the field `facilityId`).
        query.facilityId !== undefined && eq('facilityid', toWireId(query.facilityId)),
        // INFERRED: `itemidentifier.sku` for an exact SKU filter.
        query.skus !== undefined && query.skus.length > 0 && inList('itemidentifier.sku', query.skus),
      );
      const { items: rows } = await pageAll<WireStockSummary>(
        async (pgnum, pgsiz) => {
          const res = await this.get(`/inventory/stocksummaries`, { pgsiz, pgnum, rql: rql === '' ? undefined : rql });
          // SOURCE https://3w.extensiv.com/rels/inventory/stocksummaries: this rel has no
          // `_embedded`; rows live in a plain `summaries` array.
          const body = res.body as { summaries?: WireStockSummary[] } | undefined;
          return { items: body?.summaries ?? [], total: totalResults(res.body, body?.summaries?.length ?? 0) };
        },
        { pageSize: MAX_PGSIZ.stockSummaries, maxItems: limit },
      );
      const mapped = toInventoryPositions(rows, {
        customer: { id: customer.id, name: customer.name },
        facilities: facilityNames,
        facility: requestedFacility,
      });

      if (query.includeLots) {
        // SOURCE https://3w.extensiv.com/rels/inventory/stockdetails: customerid AND facilityid
        // are both required, so with no facility in the query we walk the customer's facilities.
        const facilityIds = requestedFacility ? [requestedFacility.id] : customer.facilities.map((f) => f.id);
        for (const facilityId of facilityIds) {
          if (lotRequests >= MAX_LOT_REQUESTS) {
            this.log.warn('lot detail truncated', { limit: MAX_LOT_REQUESTS, customerId: customer.id });
            break;
          }
          lotRequests += 1;
          const details = await this.stockDetails(customer.id, facilityId, query.skus);
          attachLots(mapped, details, (d) => {
            const fromLocation = d.locationIdentifier?.nameKey?.facilityIdentifier?.id;
            return fromLocation !== undefined ? String(fromLocation) : facilityId;
          });
        }
      }
      positions.push(...mapped);
    }

    const needle = query.skuContains?.toLowerCase();
    return positions
      .filter((p) => (query.includeZero ? true : p.onHand !== 0 || p.available !== 0 || p.allocated !== 0))
      .filter((p) => (needle === undefined ? true : p.sku.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle)))
      .slice(0, limit);
  }

  private async stockDetails(customerId: string, facilityId: string, skus?: string[]): Promise<WireStockDetail[]> {
    const rql = skus !== undefined && skus.length > 0 ? inList('itemidentifier.sku', skus) : '';
    try {
      const { items } = await pageAll<WireStockDetail>(
        async (pgnum, pgsiz) => {
          const res = await this.get(`/inventory/stockdetails`, { customerid: toWireId(customerId), facilityid: toWireId(facilityId), pgsiz, pgnum, rql: rql === '' ? undefined : rql });
          return { items: embedded<WireStockDetail>(res.body, REL.item), total: totalResults(res.body, 0) };
        },
        { pageSize: MAX_PGSIZ.stockDetails, maxPages: 4 },
      );
      return items;
    } catch (e) {
      // Lot detail needs the InventoryDetailView role; losing it must not break the quantities.
      this.log.warn('stock details unavailable', { customerId, facilityId, err: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  // ---- items -------------------------------------------------------------

  async findItems(query: ItemQuery): Promise<Item[]> {
    if (blank(query.customerId)) {
      throw new WmsError('VALIDATION', 'A customer id is required: the Extensiv item master is per customer (GET /customers/{customerId}/items).', {
        hint: 'Call describe_scope to list customers, then pass customer_id.',
      });
    }
    const customerId = String(query.customerId);
    const customer = (await this.listCustomers()).find((c) => c.id === customerId);
    const limit = clamp(query.limit ?? 50, 1, 1000);
    const rql = and(
      // INFERRED: sku / upc / description / readonly.deactivated as rql property names on the item model.
      query.sku !== undefined && eq('sku', query.sku),
      query.upc !== undefined && eq('upc', query.upc),
      query.textSearch !== undefined && or(contains('sku', query.textSearch), contains('description', query.textSearch)),
      query.activeOnly === true && eq('readonly.deactivated', false),
    );
    const { items } = await pageAll<WireItem>(
      async (pgnum, pgsiz) => {
        const res = await this.get(`/customers/${encodeURIComponent(customerId)}/items`, { pgsiz, pgnum, rql: rql === '' ? undefined : rql });
        return { items: embedded<WireItem>(res.body, REL.customerItem), total: totalResults(res.body, 0) };
      },
      { pageSize: MAX_PGSIZ.items, maxItems: limit },
    );
    const ref: CustomerRef | undefined = customer ? { id: customer.id, name: customer.name } : undefined;
    return items.slice(0, limit).map((w) => toItem(w, ref));
  }

  /** SKU -> item, keyed upper-case because RQL and SKUs are case-insensitive upstream. */
  private async lookupSkus(customerId: string, skus: string[]): Promise<Map<string, Item>> {
    const unique = [...new Set(skus.map((s) => s.trim()).filter((s) => s !== ''))];
    const out = new Map<string, Item>();
    if (unique.length === 0) return out;
    const customer = (await this.listCustomers()).find((c) => c.id === String(customerId));
    const res = await this.get(`/customers/${encodeURIComponent(customerId)}/items`, {
      rql: inList('sku', unique),
      pgsiz: clamp(unique.length * 2, 10, MAX_PGSIZ.items),
    });
    for (const w of embedded<WireItem>(res.body, REL.customerItem)) {
      const item = toItem(w, customer ? { id: customer.id, name: customer.name } : undefined);
      if (item.sku !== '') out.set(item.sku.toUpperCase(), item);
    }
    return out;
  }

  // ---- mutation planning -------------------------------------------------

  async planMutation<K extends MutationKind>(kind: K, input: MutationInputMap[K]): Promise<MutationPlan<K>> {
    switch (kind) {
      case 'create_order':
        return (await this.planCreateOrder(input as CreateOrderInput)) as unknown as MutationPlan<K>;
      case 'update_order':
        return (await this.planUpdateOrder(input as UpdateOrderInput)) as unknown as MutationPlan<K>;
      case 'cancel_order':
        return (await this.planCancelOrder(input as CancelOrderInput)) as unknown as MutationPlan<K>;
      case 'create_receipt':
        return (await this.planCreateReceipt(input as CreateReceiptInput)) as unknown as MutationPlan<K>;
      default:
        throw new WmsError('VALIDATION', `Unsupported mutation kind '${String(kind)}'.`);
    }
  }

  /** Ship-to fields 3PL Warehouse Manager needs to label a parcel at all. */
  private validateShipTo(shipTo: Address): void {
    const missing: string[] = [];
    if (blank(shipTo.name) && blank(shipTo.companyName)) missing.push('name or companyName');
    if (blank(shipTo.address1)) missing.push('address1');
    if (blank(shipTo.city)) missing.push('city');
    if (blank(shipTo.state)) missing.push('state');
    if (blank(shipTo.zip)) missing.push('zip');
    if (missing.length > 0) {
      throw new WmsError('VALIDATION', `The ship-to address is missing: ${missing.join(', ')}.`, {
        hint: 'Ask the operator for the missing ship-to fields; the warehouse cannot label a parcel without them.',
        details: { missing },
      });
    }
  }

  /** Validates every SKU against the customer's item master. Reads only. */
  private async resolveLines(customerId: string, lines: { sku: string; qty: number }[]): Promise<Map<string, Item>> {
    if (lines.length === 0) {
      throw new WmsError('VALIDATION', 'At least one line is required.');
    }
    const bad = lines.filter((l) => !(Number.isFinite(l.qty) && l.qty > 0));
    if (bad.length > 0) {
      throw new WmsError('VALIDATION', `Every line needs a positive quantity; got ${bad.map((l) => `${l.sku}=${l.qty}`).join(', ')}.`);
    }
    const items = await this.lookupSkus(customerId, lines.map((l) => l.sku));
    const missing = lines.map((l) => l.sku).filter((sku) => !items.has(sku.trim().toUpperCase()));
    if (missing.length > 0) {
      throw new WmsError('NOT_FOUND', `Customer ${customerId} has no item master record for SKU(s): ${[...new Set(missing)].join(', ')}.`, {
        hint: 'Check the SKU with lookup_item. Items must exist (and be active) before an order or receipt can reference them.',
        details: { missingSkus: [...new Set(missing)] },
      });
    }
    const inactive = lines.map((l) => l.sku).filter((sku) => items.get(sku.trim().toUpperCase())?.active === false);
    if (inactive.length > 0) {
      throw new WmsError('VALIDATION', `SKU(s) ${[...new Set(inactive)].join(', ')} are deactivated for customer ${customerId}.`, {
        hint: 'A deactivated item cannot be ordered or received. Ask the warehouse to reactivate it, or use the replacement SKU.',
        details: { inactiveSkus: [...new Set(inactive)] },
      });
    }
    return items;
  }

  private async planCreateOrder(input: CreateOrderInput): Promise<MutationPlan<'create_order'>> {
    if (blank(input.referenceNum)) {
      throw new WmsError('VALIDATION', 'referenceNum is required and is the natural key that makes this create replay-safe.');
    }
    const customer = await this.requireCustomer(input.customerId);
    const facility = await this.requireCustomerFacility(customer, input.facilityId);
    this.validateShipTo(input.shipTo);
    const items = await this.resolveLines(input.customerId, input.lines);

    // Availability is advisory: an order that will not fully allocate is still a legal order.
    const available = new Map<string, number>();
    try {
      const positions = await this.getInventory({
        customerId: customer.id,
        facilityId: facility.id,
        skus: input.lines.map((l) => l.sku),
        includeZero: true,
        limit: Math.max(50, input.lines.length * 4),
      });
      for (const p of positions) available.set(p.sku.toUpperCase(), (available.get(p.sku.toUpperCase()) ?? 0) + p.available);
    } catch (e) {
      this.log.warn('stock check skipped', { err: e instanceof Error ? e.message : String(e) });
    }

    const warnings: string[] = [];
    const previewLines = input.lines.map((l) => {
      const item = items.get(l.sku.trim().toUpperCase());
      const avail = available.get(l.sku.trim().toUpperCase());
      const short = avail === undefined ? undefined : Math.max(0, l.qty - avail);
      if (short !== undefined && short > 0) {
        warnings.push(`${l.sku}: ${l.qty} ordered but ${avail} available at ${facility.name} (short ${short}). The order will be created and will simply not fully allocate.`);
      }
      return {
        sku: item?.sku ?? l.sku,
        description: item?.description,
        qty: l.qty,
        qualifier: l.qualifier,
        lotNumber: l.lotNumber,
        availableAtFacility: avail,
        short,
      };
    });
    if (blank(input.shipTo.country)) warnings.push('No ship-to country was given; the warehouse will assume its default.');

    const totalUnits = input.lines.reduce((s, l) => s + l.qty, 0);
    // SOURCE https://3w.extensiv.com/rels/orders/orders (POST body: customerIdentifier,
    // facilityIdentifier, referenceNum, orderItems[itemIdentifier+qty], shipTo).
    const body = {
      customerIdentifier: { id: toWireId(customer.id) },
      facilityIdentifier: { id: toWireId(facility.id) },
      referenceNum: input.referenceNum,
      poNum: input.poNum,
      notes: input.notes,
      earliestShipDate: input.earliestShipDate,
      routingInfo: { carrier: input.carrier, mode: input.service },
      shipTo: toWireAddress(input.shipTo),
      orderItems: input.lines.map((l) => ({
        // SOURCE https://3w.extensiv.com/Rels/identifiers: one alternate is enough on a write.
        itemIdentifier: { sku: l.sku },
        qty: l.qty,
        qualifier: l.qualifier,
        lotNumber: l.lotNumber,
      })),
    };

    return {
      kind: 'create_order',
      summary: `Create order ${input.referenceNum} for ${customer.name} at ${facility.name} with ${input.lines.length} line${input.lines.length === 1 ? '' : 's'} (${totalUnits} units)`,
      scope: { customerId: customer.id, customerName: customer.name, facilityId: facility.id, facilityName: facility.name },
      input,
      preview: {
        customer: { id: customer.id, name: customer.name },
        facility: { id: facility.id, name: facility.name },
        referenceNum: input.referenceNum,
        poNum: input.poNum,
        carrier: input.carrier,
        service: input.service,
        earliestShipDate: input.earliestShipDate,
        shipTo: input.shipTo,
        lineCount: input.lines.length,
        totalUnits,
        lines: previewLines,
        notes: input.notes,
      },
      warnings,
      preconditions: [
        {
          type: 'absent',
          resource: `order.referenceNum/${customer.id}:${input.referenceNum}`,
          description: `no order with reference number ${input.referenceNum} exists for ${customer.name} yet`,
        },
      ],
      // 3PL Warehouse Manager rejects a duplicate reference number per customer with
      // 400 ModelValidation/Duplicate, which is what makes this key usable.
      naturalKey: { type: 'order.referenceNum', value: `${customer.id}:${input.referenceNum}` },
      upstream: [{ method: 'POST', path: '/orders', body }],
      risk: 'medium',
      upstreamIdempotent: false,
    };
  }

  private async planUpdateOrder(input: UpdateOrderInput): Promise<MutationPlan<'update_order'>> {
    const res = await this.getMaybe<WireOrder>(`/orders/${encodeURIComponent(input.orderId)}`, { detail: 'All', itemdetail: 'All' });
    if (!res) {
      throw new WmsError('NOT_FOUND', `No order with id '${input.orderId}'.`, { hint: 'Use find_orders or get_order_status to get the order id.' });
    }
    const wire = res.body;
    const names = await this.refMaps();
    const order = toOrderDetail(wire, { version: res.etag, names });
    if (order.status !== 'open') {
      throw new WmsError('VALIDATION', `Order ${order.id} (${order.referenceNum}) is ${order.status}; only an open order can be edited through the API.`, {
        hint:
          order.status === 'cancelled'
            ? 'A cancelled order cannot be edited. Create a replacement order instead.'
            : 'SOURCE https://3w.extensiv.com/rels/orders/order: PUT /orders/{id} "updates an unconfirmed order". A closed (shipped) order must be reopened in the 3PL Warehouse Manager UI first.',
        details: { status: order.status, orderId: order.id, referenceNum: order.referenceNum },
      });
    }
    if (order.version === undefined || order.version === '') {
      throw new WmsError('UPSTREAM_ERROR', `Order ${order.id} was returned without an ETag, so no safe If-Match value exists.`, {
        hint: 'Retry; if it persists the upstream is not sending ETag headers and edits cannot be made safely.',
      });
    }
    if (!blank(input.expectedVersion) && input.expectedVersion !== order.version) {
      throw new WmsError('PRECONDITION_FAILED', `Order ${order.id} has changed since it was read (expected version ${input.expectedVersion}).`, {
        hint: 'Re-read the order with get_order_status and prepare the update again.',
        details: { expected: input.expectedVersion, actual: order.version },
      });
    }

    const before: Record<string, unknown> = {
      carrier: order.carrier,
      service: order.service,
      notes: order.notes,
      earliestShipDate: order.earliestShipDate,
      shipTo: order.shipTo,
    };
    const mergedShipTo: Address = { ...order.shipTo, ...(input.shipTo ?? {}) };
    const after: Record<string, unknown> = {
      carrier: input.carrier ?? order.carrier,
      service: input.service ?? order.service,
      notes: input.notes ?? order.notes,
      earliestShipDate: input.earliestShipDate ?? order.earliestShipDate,
      shipTo: mergedShipTo,
    };
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    if (changed.length === 0) {
      throw new WmsError('VALIDATION', `Nothing would change on order ${order.id} (${order.referenceNum}).`, {
        hint: 'Pass at least one field that differs from the current value.',
      });
    }

    // INFERRED: the writable body is the GET body minus readOnly/_links/_embedded. The
    // documented required-field list for PUT was truncated (research notes §10), and the rel
    // page only says "updates an unconfirmed order". Order items are deliberately NOT sent:
    // INFERRED that omitting `orderItems` leaves the existing lines untouched, because lines
    // have their own sub-resource (POST/PUT /orders/{id}/items) for editing.
    const body = writableOrderBody(wire, {
      carrier: input.carrier,
      service: input.service,
      notes: input.notes,
      earliestShipDate: input.earliestShipDate,
      shipTo: input.shipTo,
    });

    const customerId = order.customer.id || input.customerId || '';
    return {
      kind: 'update_order',
      summary: `Update order ${order.id} (${order.referenceNum}) for ${order.customer.name}: ${changed.join(', ')}`,
      scope: { customerId, customerName: order.customer.name, facilityId: order.facility.id, facilityName: order.facility.name },
      input,
      preview: {
        orderId: order.id,
        referenceNum: order.referenceNum,
        status: order.status,
        changedFields: changed,
        before: pick(before, changed),
        after: pick(after, changed),
        lineCount: order.lineCount,
        note: 'Order lines are not touched by this update.',
      },
      warnings: order.onHold ? [`Order ${order.id} is on hold (${order.holdReason ?? 'no reason given'}); edits are allowed but the order will not ship until the hold is released.`] : [],
      preconditions: [
        { type: 'version', resource: `order/${order.id}`, expected: order.version, description: `order ${order.id} is still at the version that was previewed` },
        { type: 'status', resource: `order/${order.id}`, expected: ['open'], description: `order ${order.id} is still open` },
      ],
      // SOURCE https://3w.extensiv.com/Rels/headers: PUT requires If-Match; 412 when it does not match.
      upstream: [{ method: 'PUT', path: `/orders/${encodeURIComponent(order.id)}?detail=None`, body, headers: { 'If-Match': order.version } }],
      risk: 'medium',
      upstreamIdempotent: false,
    };
  }

  private async planCancelOrder(input: CancelOrderInput): Promise<MutationPlan<'cancel_order'>> {
    if (blank(input.reason)) {
      // SOURCE https://3w.extensiv.com/rels/orders/ordercancel: `reason` is required.
      throw new WmsError('VALIDATION', 'A cancellation reason is required by the API and is stored on the order.');
    }
    const order = await this.getOrder({ id: input.orderId });
    if (!order) {
      throw new WmsError('NOT_FOUND', `No order with id '${input.orderId}'.`, { hint: 'Use find_orders to locate the order id.' });
    }
    if (order.status === 'closed') {
      throw new WmsError('VALIDATION', `Order ${order.id} (${order.referenceNum}) is closed: shipped orders cannot be cancelled here.`, {
        hint: 'SOURCE https://3w.extensiv.com/rels/orders/ordercancel: the canceller cancels an open order. A shipped order needs an unconfirm/reopen in the 3PL Warehouse Manager UI, or a return.',
        details: { status: order.status, shippedAt: order.shippedAt, trackingNumbers: order.trackingNumbers },
      });
    }
    const already = order.status === 'cancelled';
    const warnings = already ? [`Order ${order.id} (${order.referenceNum}) is already cancelled upstream; committing will confirm that and call nothing.`] : [];
    if (!already && order.trackingNumbers.length > 0) {
      warnings.push(`Order ${order.id} already has tracking number(s) ${order.trackingNumbers.join(', ')}; cancelling may strand a label.`);
    }
    const version = order.version ?? '';
    return {
      kind: 'cancel_order',
      summary: `Cancel order ${order.id} (${order.referenceNum}) for ${order.customer.name} — reason: ${input.reason}`,
      scope: { customerId: order.customer.id || input.customerId || '', customerName: order.customer.name, facilityId: order.facility.id, facilityName: order.facility.name },
      input,
      preview: {
        orderId: order.id,
        referenceNum: order.referenceNum,
        currentStatus: order.status,
        alreadyCancelled: already,
        reason: input.reason,
        customer: order.customer,
        facility: order.facility,
        lineCount: order.lineCount,
        totalQty: order.totalQty,
        trackingNumbers: order.trackingNumbers,
      },
      warnings,
      preconditions: [
        { type: 'status', resource: `order/${order.id}`, expected: already ? ['open', 'cancelled'] : ['open'], description: `order ${order.id} is still cancellable (open)` },
        ...(version !== '' ? [{ type: 'version' as const, resource: `order/${order.id}`, expected: version, description: `order ${order.id} is still at the version that was previewed` }] : []),
      ],
      naturalKey: { type: 'order.cancelled', value: order.id },
      // SOURCE https://3w.extensiv.com/rels/orders/ordercancel: POST /orders/{id}/canceler,
      // If-Match required, 204 No Content, body { reason }.
      upstream: [{ method: 'POST', path: `/orders/${encodeURIComponent(order.id)}/canceler`, body: { reason: input.reason }, headers: version !== '' ? { 'If-Match': version } : {} }],
      risk: 'high',
      // A cancel of an already-cancelled order is a no-op, so a replay cannot do harm.
      upstreamIdempotent: already,
    };
  }

  private async planCreateReceipt(input: CreateReceiptInput): Promise<MutationPlan<'create_receipt'>> {
    if (blank(input.referenceNum)) {
      throw new WmsError('VALIDATION', 'referenceNum is required and is the natural key that makes this create replay-safe.');
    }
    const customer = await this.requireCustomer(input.customerId);
    const facility = await this.requireCustomerFacility(customer, input.facilityId);
    const items = await this.resolveLines(input.customerId, input.lines);

    const warnings: string[] = [];
    const previewLines = input.lines.map((l) => {
      const item = items.get(l.sku.trim().toUpperCase());
      if (item?.trackLots === true && blank(l.lotNumber)) {
        warnings.push(`${l.sku} is lot-tracked but no lot number was given; the warehouse will have to supply one at receipt.`);
      }
      if (item?.trackExpiration === true && blank(l.expirationDate)) {
        warnings.push(`${l.sku} is expiration-tracked but no expiration date was given.`);
      }
      return { sku: item?.sku ?? l.sku, description: item?.description, qty: l.qty, qualifier: l.qualifier, lotNumber: l.lotNumber, expirationDate: l.expirationDate };
    });
    const totalUnits = input.lines.reduce((s, l) => s + l.qty, 0);

    // SOURCE https://3w.extensiv.com/rels/inventory/receivers (POST body).
    const body = {
      customerIdentifier: { id: toWireId(customer.id) },
      facilityIdentifier: { id: toWireId(facility.id) },
      referenceNum: input.referenceNum,
      poNum: input.poNum,
      expectedDate: input.expectedDate,
      notes: input.notes,
      receiveItems: input.lines.map((l) => ({
        itemIdentifier: { sku: l.sku },
        qty: l.qty,
        qualifier: l.qualifier,
        lotNumber: l.lotNumber,
        expirationDate: l.expirationDate,
      })),
    };

    return {
      kind: 'create_receipt',
      summary: `Create receipt ${input.referenceNum} for ${customer.name} at ${facility.name} with ${input.lines.length} line${input.lines.length === 1 ? '' : 's'} (${totalUnits} units)`,
      scope: { customerId: customer.id, customerName: customer.name, facilityId: facility.id, facilityName: facility.name },
      input,
      preview: {
        customer: { id: customer.id, name: customer.name },
        facility: { id: facility.id, name: facility.name },
        referenceNum: input.referenceNum,
        poNum: input.poNum,
        expectedDate: input.expectedDate,
        supplier: input.supplier,
        lineCount: input.lines.length,
        totalUnits,
        lines: previewLines,
        notes: input.notes,
        // SOURCE https://3w.extensiv.com/rels/inventory/receivers: customers configured for
        // "Receive Against" get an ASN (receiverType 2) rather than a plain receiver.
        note: 'Creating a receipt does not put stock on hand; the warehouse must confirm it.',
      },
      warnings,
      preconditions: [
        {
          type: 'absent',
          resource: `receipt.referenceNum/${customer.id}:${input.referenceNum}`,
          description: `no receipt with reference number ${input.referenceNum} exists for ${customer.name} yet`,
        },
      ],
      naturalKey: { type: 'receipt.referenceNum', value: `${customer.id}:${input.referenceNum}` },
      upstream: [{ method: 'POST', path: '/inventory/receivers', body }],
      risk: 'medium',
      upstreamIdempotent: false,
    };
  }

  // ---- preconditions, natural keys, execution ---------------------------

  async checkPreconditions(plan: MutationPlan): Promise<PreconditionResult[]> {
    const out: PreconditionResult[] = [];
    for (const pre of plan.preconditions) {
      out.push(await this.checkOne(pre));
    }
    return out;
  }

  private async checkOne(pre: Precondition): Promise<PreconditionResult> {
    const [kind, id] = splitResource(pre.resource);
    if (pre.type === 'version' || pre.type === 'status') {
      const current = kind === 'receipt' ? await this.getReceipt({ id }) : await this.getOrder({ id });
      if (!current) {
        return { precondition: pre, ok: false, actual: null, message: `${kind} ${id} no longer exists upstream` };
      }
      if (pre.type === 'version') {
        const ok = current.version === pre.expected;
        return { precondition: pre, ok, actual: current.version, message: ok ? undefined : 'the resource was modified upstream after the preview was built' };
      }
      const ok = pre.expected.includes(current.status);
      return { precondition: pre, ok, actual: current.status, message: ok ? undefined : `status is now '${current.status}', expected one of ${pre.expected.join(', ')}` };
    }
    if (pre.type === 'absent') {
      const found = await this.lookupByReferenceResource(pre.resource);
      return { precondition: pre, ok: found === null, actual: found, message: found === null ? undefined : `${kind === 'receipt.referenceNum' ? 'receipt' : 'order'} ${found} already exists with that reference number` };
    }
    // 'custom' preconditions are not produced by this adapter; reporting them as unchecked
    // is safer than silently passing something we did not evaluate.
    return { precondition: pre, ok: false, message: 'this adapter does not know how to check a custom precondition' };
  }

  /** Resource form `order.referenceNum/{customerId}:{ref}` -> existing id, or null. */
  private async lookupByReferenceResource(resource: string): Promise<string | null> {
    const [kind, rest] = splitResource(resource);
    const sep = rest.indexOf(':');
    const customerId = sep >= 0 ? rest.slice(0, sep) : undefined;
    const referenceNum = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (referenceNum === '') return null;
    if (kind === 'receipt.referenceNum') return this.receiptIdByReference(referenceNum, customerId);
    return this.orderIdByReference(referenceNum, customerId);
  }

  async findApplied(plan: MutationPlan): Promise<MutationOutcome | null> {
    switch (plan.kind) {
      case 'create_order': {
        const input = plan.input as CreateOrderInput;
        const id = await this.orderIdByReference(input.referenceNum, input.customerId);
        if (id === null) return null;
        const order = await this.getOrder({ id });
        return {
          resourceType: 'order',
          resourceId: id,
          referenceNum: input.referenceNum,
          status: order?.status,
          version: order?.version,
          via: 'found_existing',
          detail: { lineCount: order?.lineCount, totalQty: order?.totalQty },
        };
      }
      case 'create_receipt': {
        const input = plan.input as CreateReceiptInput;
        const id = await this.receiptIdByReference(input.referenceNum, input.customerId);
        if (id === null) return null;
        const receipt = await this.getReceipt({ id });
        return {
          resourceType: 'receipt',
          resourceId: id,
          referenceNum: input.referenceNum,
          status: receipt?.status,
          version: receipt?.version,
          via: 'found_existing',
          detail: { lineCount: receipt?.lineCount, totalExpectedQty: receipt?.totalExpectedQty },
        };
      }
      case 'cancel_order': {
        const input = plan.input as CancelOrderInput;
        const order = await this.getOrder({ id: input.orderId });
        if (!order || order.status !== 'cancelled') return null;
        return { resourceType: 'order', resourceId: order.id, referenceNum: order.referenceNum, status: order.status, version: order.version, via: 'found_existing' };
      }
      case 'update_order':
        // An update leaves no natural key behind: the same field values could have been set by
        // anyone. The version precondition is what protects a replay after a lost response.
        return null;
      default:
        return null;
    }
  }

  async executeMutation(plan: MutationPlan): Promise<MutationOutcome> {
    const req = plan.upstream[0];
    if (!req) {
      throw new WmsError('INTERNAL', `Plan for ${plan.kind} carries no upstream request.`);
    }
    const what = `${req.method} ${req.path}`;
    try {
      const res = await this.http.request<unknown>({
        method: req.method,
        path: req.path,
        body: req.body,
        headers: req.headers,
        // Never retried by the client: a replay could double-apply the write.
        idempotent: false,
      });
      return await this.outcomeOf(plan, req, res);
    } catch (e) {
      const status = statusOf(e);
      const body = errorBodyOf(e);
      if (status === 400 && errorCodeOf(body) === 'Duplicate') {
        // SOURCE https://3w.extensiv.com/rels/orders/orders: a duplicate reference number is a
        // 400 ModelValidation/Duplicate. That is exactly what a retry after a lost response
        // looks like, so reconcile by natural key before reporting a failure.
        const applied = await this.findApplied(plan);
        if (applied) {
          this.log.info('duplicate rejected by upstream but the resource exists; reporting the existing one', { kind: plan.kind, resourceId: applied.resourceId });
          return { ...applied, via: 'found_existing' };
        }
        throw new WmsError('VALIDATION', `${what} was rejected as a duplicate, but no matching resource could be found to report.`, {
          hint: 'The reference number is already used by a resource this credential cannot see. Use a different reference number.',
          details: { status, errorCode: 'Duplicate' },
          cause: e,
        });
      }
      throw translateUpstreamError(e, { what });
    }
  }

  private async outcomeOf(plan: MutationPlan, req: UpstreamRequest, res: HttpResponse<unknown>): Promise<MutationOutcome> {
    if (plan.kind === 'create_receipt') {
      const wire = res.body as WireReceiver | undefined;
      const id = wire?.readOnly?.receiverId !== undefined ? String(wire.readOnly.receiverId) : undefined;
      const input = plan.input as CreateReceiptInput;
      if (id === undefined) {
        const found = await this.findApplied(plan);
        if (found) return { ...found, via: 'executed' };
        throw new WmsError('OUTCOME_UNKNOWN', `${req.method} ${req.path} returned ${res.status} without a receiver id.`, {
          hint: 'Look the receipt up by its reference number before retrying.',
        });
      }
      const receipt = wire ? toReceiptSummary(wire, await this.refMaps()) : undefined;
      return {
        resourceType: 'receipt',
        resourceId: id,
        referenceNum: input.referenceNum,
        status: receipt?.status,
        version: res.etag,
        via: 'executed',
        detail: { lineCount: receipt?.lineCount, totalExpectedQty: receipt?.totalExpectedQty },
      };
    }

    // Everything else acts on an order.
    if (plan.kind === 'create_order') {
      const wire = res.body as WireOrder | undefined;
      const id = wire?.readOnly?.orderId !== undefined ? String(wire.readOnly.orderId) : undefined;
      const input = plan.input as CreateOrderInput;
      if (id === undefined) {
        const found = await this.findApplied(plan);
        if (found) return { ...found, via: 'executed' };
        throw new WmsError('OUTCOME_UNKNOWN', `${req.method} ${req.path} returned ${res.status} without an order id.`, {
          hint: 'Look the order up by its reference number before retrying.',
        });
      }
      const summary = wire ? toOrderSummary(wire, await this.refMaps()) : undefined;
      return {
        resourceType: 'order',
        resourceId: id,
        referenceNum: input.referenceNum,
        status: summary?.status,
        version: res.etag,
        via: 'executed',
        detail: { lineCount: summary?.lineCount, totalQty: summary?.totalQty, fullyAllocated: summary?.fullyAllocated },
      };
    }

    const orderId = plan.kind === 'cancel_order' ? (plan.input as CancelOrderInput).orderId : (plan.input as UpdateOrderInput).orderId;
    // SOURCE https://3w.extensiv.com/Rels/headers: an operator answers 204 with no body, so the
    // resulting status and version have to be re-read to report anything truthful.
    const fresh = await this.getOrder({ id: orderId });
    return {
      resourceType: 'order',
      resourceId: orderId,
      referenceNum: fresh?.referenceNum,
      status: fresh?.status,
      version: fresh?.version ?? res.etag,
      via: 'executed',
      detail: plan.kind === 'cancel_order' ? { reason: (plan.input as CancelOrderInput).reason } : { changedFields: plan.preview.changedFields },
    };
  }

  /** Nothing to release: fetch/undici owns the sockets and the token cache is plain memory. */
  async close(): Promise<void> {
    return undefined;
  }
}

/**
 * Declared as `WmsAdapter` rather than `ExtensivAdapter` so callers (the server
 * package, the evals) stay adapter-agnostic and can substitute any other adapter
 * for the same variable. The class itself is exported for anyone who needs it.
 */
export function createExtensivAdapter(cfg: ExtensivConfig, deps: ExtensivAdapterDeps = {}): WmsAdapter {
  return new ExtensivAdapter(cfg, deps);
}

// ---------------------------------------------------------------------------
// Helpers shared by the planners
// ---------------------------------------------------------------------------

function splitResource(resource: string): [string, string] {
  const i = resource.indexOf('/');
  return i < 0 ? [resource, ''] : [resource.slice(0, i), resource.slice(i + 1)];
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = source[k];
  return out;
}

/** Domain address -> the wire contact block (SOURCE https://3w.extensiv.com/rels/orders/order shipTo). */
export function toWireAddress(a: Address): Record<string, unknown> {
  return {
    companyName: a.companyName,
    name: a.name,
    address1: a.address1,
    address2: a.address2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country,
    phoneNumber: a.phone,
    emailAddress: a.email,
  };
}

/**
 * The PUT body for an order: the GET body with the server-owned parts removed and the
 * requested edits merged in. `readOnly`, `_links` and `_embedded` are stripped because
 * they are server-computed; `orderItems` is never sent (see planUpdateOrder).
 */
export function writableOrderBody(
  wire: WireOrder,
  edits: { carrier?: string; service?: string; notes?: string; earliestShipDate?: string; shipTo?: Partial<Address> },
): Record<string, unknown> {
  const { readOnly: _readOnly, _links: _links, _embedded: _embedded, orderItems: _orderItems, ...writable } = wire;
  const body: Record<string, unknown> = { ...writable };
  if (edits.notes !== undefined) body.notes = edits.notes;
  if (edits.earliestShipDate !== undefined) body.earliestShipDate = edits.earliestShipDate;
  if (edits.carrier !== undefined || edits.service !== undefined) {
    body.routingInfo = {
      ...(wire.routingInfo ?? {}),
      ...(edits.carrier !== undefined ? { carrier: edits.carrier } : {}),
      ...(edits.service !== undefined ? { mode: edits.service } : {}),
    };
  }
  if (edits.shipTo !== undefined) {
    const patch = toWireAddress(edits.shipTo as Address);
    const merged: Record<string, unknown> = { ...(wire.shipTo ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) merged[k] = v;
    }
    body.shipTo = merged;
  }
  return body;
}
