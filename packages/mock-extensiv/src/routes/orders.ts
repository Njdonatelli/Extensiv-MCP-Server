/**
 * Orders: collection, single resource, sub-resources and operators.
 * SOURCE: https://3w.extensiv.com/rels/orders/orders ; /rels/orders/order ; /rels/orders/items ;
 * /rels/orders/packages ; /rels/orders/summaries ; /rels/orders/shipmentstrackinginfo ;
 * /rels/orders/ordercancel ; /rels/orders/orderconfirm ; /rels/orders/ordercomplete ;
 * /rels/orders/orderholder.
 * Every handler is thin: parse, call MockState, render.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MockEnv } from '../env.js';
import { modelValidation, notFound } from '../errors.js';
import { collection, hal, listPipeline, parsePaging, REL } from '../hal.js';
import type { Order, OrderCreateInput, OrderSummaryRow, ShipmentTrackingRow } from '../models.js';
import { compileRql, compileSort } from '../rql.js';
import type { MockState, OrderRecord } from '../state.js';
import { ci } from '../util.js';
import { jsonBody, listQuery, PAGING, pathId, requireIfMatch } from './common.js';
import { parseEnumList } from './common.js';
import { ORDER_SHAPE, ORDER_SUMMARY_SHAPE, TRACKING_SHAPE } from './shapes.js';

/** SOURCE: rels/orders/orders — the documented `detail` enum (comma-delimited, default None). */
const ORDER_DETAIL = [
  'None',
  'OrderItems',
  'BillingDetails',
  'SavedElements',
  'Packages',
  'Contacts',
  'ProposedBilling',
  'OutboundSerialNumbers',
  'SmallParcel',
  'ParcelOptions',
  'Inserts',
  'All',
] as const;

/** SOURCE: rels/orders/orders — `itemdetail`: None, SavedElements, Allocations, All, AllocationsWithDetail. */
const ITEM_DETAIL = ['None', 'SavedElements', 'Allocations', 'All', 'AllocationsWithDetail'] as const;

interface DetailFlags {
  items: boolean;
  packages: boolean;
  allocations: boolean;
  allocationDetail: boolean;
}

function detailFlags(c: Context<MockEnv>, defaultDetail = 'None'): DetailFlags {
  const detail = parseEnumList(c, 'detail', ORDER_DETAIL, defaultDetail);
  const itemDetail = parseEnumList(c, 'itemdetail', ITEM_DETAIL, 'None');
  const has = (list: string[], name: string): boolean => list.includes(name);
  const all = has(detail, 'All');
  const itemAll = has(itemDetail, 'All') || has(itemDetail, 'AllocationsWithDetail');
  return {
    items: all || has(detail, 'OrderItems'),
    packages: all || has(detail, 'Packages'),
    allocations: itemAll || has(itemDetail, 'Allocations'),
    allocationDetail: has(itemDetail, 'AllocationsWithDetail'),
  };
}

/**
 * The row an rql/sort expression is evaluated against. It is the wire order plus top-level aliases
 * for customerIdentifier / facilityIdentifier / status / isClosed, which on the wire live under
 * readOnly (GUESS: Rels/rql quotes both `readonly.isclosed` and `customeridentifier.id`).
 */
type OrderView = Order & Record<string, unknown>;

function orderView(rec: OrderRecord): OrderView {
  const o = rec.order;
  return {
    ...o,
    customerIdentifier: o.readOnly.customerIdentifier,
    facilityIdentifier: o.readOnly.facilityIdentifier,
    status: o.readOnly.status,
    isClosed: o.readOnly.isClosed,
  };
}

export function ordersRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  // Static sub-paths first so `/orders/:id` never swallows them.

  // SOURCE: rels/orders/summaries — `_embedded.item` with the bare "item" key.
  app.get('/orders/summaries', (c) => {
    const paging = parsePaging(c, PAGING.orderSummaries);
    const filter = compileRql<OrderSummaryRow>(c.req.query('rql'), ORDER_SUMMARY_SHAPE);
    const sort = compileSort<OrderSummaryRow>(c.req.query('sort'), ORDER_SUMMARY_SHAPE);
    const { page, totalResults, links } = listPipeline(c, state.orderSummaries(), filter, sort, paging);
    return hal(c, collection('item', page, totalResults, links));
  });

  // SOURCE: rels/orders/shipmentstrackinginfo — page size limit 4000.
  app.get('/orders/shipmentstrackinginfo', (c) => {
    const paging = parsePaging(c, PAGING.shipmentTracking);
    const filter = compileRql<ShipmentTrackingRow>(c.req.query('rql'), TRACKING_SHAPE);
    const sort = compileSort<ShipmentTrackingRow>(c.req.query('sort'), TRACKING_SHAPE);
    const { page, totalResults, links } = listPipeline(c, state.shipmentTrackingRows(), filter, sort, paging);
    return hal(c, collection(REL.trackingInfo, page, totalResults, links));
  });

  // SOURCE: rels/orders/orderholder — PUT /orders/orderholder{?deallocate,holdReason,release};
  // body {"orderIdentifiers":[{"id":1}]}; response {"heldOrderIds":[1],"exceptions":{...}}.
  app.put('/orders/orderholder', async (c) => {
    const body = await jsonBody(c);
    const ids = identifierIds(body.orderIdentifiers, 'OrderIdentifiers');
    const release = boolParam(c, 'release');
    const holdReason = c.req.query('holdReason') ?? null;
    const result = state.holdOrders(ids, holdReason, release);
    if (!release && boolParam(c, 'deallocate')) {
      // SOURCE: the rel exposes a `deallocate` flag on the hold operation; MockState.holdOrders only
      // flags the hold, so the route performs the deallocation it names.
      for (const id of result.heldOrderIds) {
        const rec = state.orderById(id);
        if (rec) state.releaseOrder(rec);
      }
    }
    return hal(c, { heldOrderIds: result.heldOrderIds, exceptions: listException(result.faults) });
  });

  // SOURCE: rels/orders/orders — GET /orders{?pgsiz,pgnum,rql,sort,detail,itemdetail,skulist,skucontains,upclist},
  // limit 1000, default 100.
  app.get('/orders', (c) => {
    const paging = parsePaging(c, PAGING.orders);
    const detail = detailFlags(c);
    const filter = compileRql<OrderView>(c.req.query('rql'), ORDER_SHAPE);
    const sort = compileSort<OrderView>(c.req.query('sort'), ORDER_SHAPE);
    const skuMatch = skuFilter(state, c);
    const pairs = state.orders.map((rec) => ({ rec, view: orderView(rec) }));
    const { page, totalResults, links } = listPipeline(
      c,
      pairs,
      (p) => skuMatch(p.rec) && filter(p.view),
      sort ? (a, b) => sort(a.view, b.view) : null,
      paging,
    );
    const rows = page.map((p) => state.renderOrder(p.rec, detail));
    return hal(c, collection(REL.order, rows, totalResults, links));
  });

  // SOURCE: rels/orders/orders — POST /orders → 201 + ETag.
  app.post('/orders', async (c) => {
    const body = (await jsonBody(c)) as OrderCreateInput;
    // GUESS: the create response's default `detail` is not documented; the mock echoes the order with
    // its items so a caller can see what was allocated without a second round trip.
    const detail = detailFlags(c, 'OrderItems');
    const rec = state.createOrder(body);
    return hal(c, state.renderOrder(rec, detail), 201, { ETag: state.etagOfOrder(rec) });
  });

  // SOURCE: rels/orders/order — GET /orders/{id}{?detail,itemdetail} → 200 + ETag.
  app.get('/orders/:id', (c) => {
    const rec = requireOrder(state, c);
    return hal(c, state.renderOrder(rec, detailFlags(c)), 200, { ETag: state.etagOfOrder(rec) });
  });

  // SOURCE: rels/orders/order — PUT "Updates an unconfirmed order"; If-Match required; 200 + ETag.
  app.put('/orders/:id', async (c) => {
    const rec = requireOrder(state, c);
    requireIfMatch(c, state.etagOfOrder(rec));
    const body = (await jsonBody(c)) as OrderCreateInput;
    const detail = detailFlags(c, 'OrderItems');
    // GUESS: whether a PUT carrying orderItems replaces the lines or merges them is not documented;
    // the mock replaces them, matching the "full representation" reading of PUT.
    state.updateOrder(rec, body, Array.isArray(body.orderItems), {});
    return hal(c, state.renderOrder(rec, detail), 200, { ETag: state.etagOfOrder(rec) });
  });

  // SOURCE: rels/orders/items — GET /orders/{id}/items → 200 + ETag.
  app.get('/orders/:id/items', (c) => {
    const rec = requireOrder(state, c);
    const detail = detailFlags(c);
    const rows = rec.items.map((i) => state.renderOrderItem(rec, i, detail.allocations, detail.allocationDetail));
    return hal(c, collection(REL.orderItem, rows, rows.length, { self: { href: `/orders/${rec.order.readOnly.orderId}/items` } }), 200, {
      ETag: state.etagOfOrder(rec),
    });
  });

  // SOURCE: rels/orders/packages — packages carry their contents under the packagecontent rel.
  app.get('/orders/:id/packages', (c) => {
    const rec = requireOrder(state, c);
    return hal(
      c,
      collection(REL.package, rec.packages, rec.packages.length, { self: { href: `/orders/${rec.order.readOnly.orderId}/packages` } }),
      200,
      { ETag: state.etagOfOrder(rec) },
    );
  });

  // SOURCE: rels/orders/ordercancel — POST /orders/{id}/canceler, If-Match required, reason required, 204.
  app.post('/orders/:id/canceler', async (c) => {
    const rec = requireOrder(state, c);
    requireIfMatch(c, state.etagOfOrder(rec));
    const body = await jsonBody(c);
    state.cancelOrder(rec, typeof body.reason === 'string' ? body.reason : null);
    return new Response(null, { status: 204 });
  });

  // SOURCE: rels/orders/orderconfirm — POST /orders/{id}/confirmer, If-Match required, 204;
  // 403 NotFullyAllocated / DateInFuture / OrderConfirmed.
  app.post('/orders/:id/confirmer', async (c) => {
    const rec = requireOrder(state, c);
    requireIfMatch(c, state.etagOfOrder(rec));
    const body = await jsonBody(c);
    state.confirmOrder(rec, body as Parameters<MockState['confirmOrder']>[1]);
    return new Response(null, { status: 204 });
  });

  // SOURCE: rels/orders/ordercomplete — POST /orders/{id}/completer, If-Match required, 204.
  app.post('/orders/:id/completer', async (c) => {
    const rec = requireOrder(state, c);
    requireIfMatch(c, state.etagOfOrder(rec));
    await jsonBody(c);
    state.completeOrder(rec);
    return new Response(null, { status: 204 });
  });

  return app;
}

function requireOrder(state: MockState, c: Context<MockEnv>): OrderRecord {
  const rec = state.orderById(pathId(c, 'id'));
  if (!rec) throw notFound();
  return rec;
}

function boolParam(c: Context<MockEnv>, name: string): boolean {
  const raw = c.req.query(name);
  return raw !== undefined && /^(true|1)$/i.test(raw.trim());
}

/**
 * `{"orderIdentifiers":[{"id":1}]}` → [1].
 * SOURCE: rels/orders/orderholder body sample; Rels/identifiers says id wins when supplied.
 */
function identifierIds(value: unknown, propertyName: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw modelValidation('Required', [{ Name: propertyName, Value: null }], `${propertyName} is required`);
  }
  return value.map((entry, idx) => {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw modelValidation('Required', [{ Name: `${propertyName}[${idx}].Id`, Value: null }], 'Each identifier needs an integer id');
    }
    return id;
  });
}

/**
 * GUESS: the `exceptions` member of a hold response is shown only as `{...}`. The mock uses the
 * documented ListException shape (SOURCE: Rels/exceptions ListException {Faults:[{EntryNumber,
 * EntryInfo, WmsException{ErrorCode, Hint, Message}}]}).
 */
function listException(faults: { entryNumber: number; entryInfo: string }[]): Record<string, unknown> {
  return {
    $type: 'WMS.V2.Generic.Models.Exceptions.ListException, WMS.V2.Generic.Models',
    Faults: faults.map((f) => ({
      EntryNumber: f.entryNumber,
      EntryInfo: f.entryInfo,
      WmsException: { ErrorCode: 'DoesNotExist', Hint: f.entryInfo, Message: f.entryInfo },
    })),
  };
}

/**
 * skulist / skucontains / upclist narrow the collection to orders containing a matching line.
 * SOURCE: rels/orders/orders — "skulist comma-delimited", "skucontains partial", "upclist".
 * GUESS: whether the real filters are case-insensitive is not stated; the mock matches rql and
 * compares case-insensitively.
 */
function skuFilter(state: MockState, c: Context<MockEnv>): (rec: OrderRecord) => boolean {
  const skus = listQuery(c, 'skulist');
  const upcs = listQuery(c, 'upclist');
  const contains = c.req.query('skucontains')?.trim().toLowerCase();
  if (skus.length === 0 && upcs.length === 0 && (contains === undefined || contains === '')) return () => true;
  return (rec) =>
    rec.items.some((item) => {
      if (skus.length > 0 && skus.some((s) => ci(s, item.itemIdentifier.sku))) return true;
      if (contains !== undefined && contains !== '' && item.itemIdentifier.sku.toLowerCase().includes(contains)) return true;
      if (upcs.length > 0) {
        const upc = state.items.find((i) => i.itemId === item.itemIdentifier.id)?.upc ?? null;
        if (upc !== null && upcs.some((u) => ci(u, upc))) return true;
      }
      return false;
    });
}
