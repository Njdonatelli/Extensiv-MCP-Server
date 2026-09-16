/**
 * Inventory views, receivers and the inventory-hold operator.
 * SOURCE: https://3w.extensiv.com/rels/inventory/stocksummaries ; /stockdetails ; /inventory ;
 * /receivers ; /receiver ; /receiverconfirm ; /receivercancel ; /inventoryhold.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MockEnv } from '../env.js';
import { modelValidation, notFound, queryParameter } from '../errors.js';
import { collection, hal, listPipeline, parsePaging, REL } from '../hal.js';
import type { InventoryRow, ReceiverCreateInput, StockDetailRow } from '../models.js';
import { ReceiverType } from '../models.js';
import { compileRql, compileSort } from '../rql.js';
import type { MockState, ReceiverRecord } from '../state.js';
import { jsonBody, optionalIntQuery, PAGING, parseEnumList, pathId, requireIfMatch, requiredIntQuery } from './common.js';
import { INVENTORY_SHAPE, RECEIVER_SHAPE, STOCK_DETAIL_SHAPE, STOCK_SUMMARY_SHAPE } from './shapes.js';

/** SOURCE: rels/inventory/receivers — detail: None, ReceiveItems, BillingDetails, SavedElements, All, ProposedBilling. */
const RECEIVER_DETAIL = ['None', 'ReceiveItems', 'BillingDetails', 'SavedElements', 'All', 'ProposedBilling'] as const;
/** GUESS: the receivers rel names an `itemdetail` parameter but never lists its values; the mock accepts the order-side enum and ignores it. */
const RECEIVER_ITEM_DETAIL = ['None', 'SavedElements', 'Allocations', 'All', 'AllocationsWithDetail'] as const;

export function inventoryRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  // SOURCE: rels/inventory/stocksummaries — `{ "totalResults": 1, "summaries": [...] }`; this rel does
  // NOT use _embedded, has no `sort` parameter, and its page-size limit is 500 (default 100).
  app.get('/inventory/stocksummaries', (c) => {
    const paging = parsePaging(c, PAGING.stockSummaries);
    const filter = compileRql<ReturnType<MockState['stockSummaries']>[number]>(c.req.query('rql'), STOCK_SUMMARY_SHAPE);
    // GUESS: `orderednotallocated` is listed as a query parameter but its semantics are not described;
    // the mock treats it as a switch for computing the orderedNotAllocated member, on by default.
    const wantOrdered = !/^(false|0)$/i.test((c.req.query('orderednotallocated') ?? '').trim());
    const { page, totalResults } = listPipeline(c, state.stockSummaries(), filter, null, paging);
    const summaries = page.map(({ customerIdentifier: _customerIdentifier, ...row }) => ({
      ...row,
      orderedNotAllocated: wantOrdered ? row.orderedNotAllocated : null,
    }));
    return hal(c, { totalResults, summaries });
  });

  // SOURCE: rels/inventory/stockdetails — customerid and facilityid are required; `_embedded.item`.
  app.get('/inventory/stockdetails', (c) => {
    const missing = ['customerid', 'facilityid'].filter((p) => (c.req.query(p) ?? '').trim() === '');
    if (missing.length > 0) throw queryParameter('Required', missing, `Required query parameters: ${missing.join(', ')}`);
    const customerId = requiredIntQuery(c, 'customerid');
    const facilityId = requiredIntQuery(c, 'facilityid');
    const paging = parsePaging(c, PAGING.stockDetails);
    const filter = compileRql<StockDetailRow>(c.req.query('rql'), STOCK_DETAIL_SHAPE);
    const sort = compileSort<StockDetailRow>(c.req.query('sort'), STOCK_DETAIL_SHAPE);
    const { page, totalResults, links } = listPipeline(c, state.stockDetails(customerId, facilityId), filter, sort, paging);
    return hal(c, collection('item', page, totalResults, links));
  });

  // SOURCE: rels/inventory/receivers — GET limit 500 (default 100); detail/itemdetail/receivertype/rql/sort.
  app.get('/inventory/receivers', (c) => {
    const paging = parsePaging(c, PAGING.receivers);
    const detail = receiverDetailFlags(c);
    const filter = compileRql<Record<string, unknown>>(c.req.query('rql'), RECEIVER_SHAPE);
    const sort = compileSort<Record<string, unknown>>(c.req.query('sort'), RECEIVER_SHAPE);
    const typeMatch = receiverTypeFilter(c);
    const pairs = state.receivers.map((rec) => ({ rec, view: receiverView(rec) }));
    const { page, totalResults, links } = listPipeline(
      c,
      pairs,
      (p) => typeMatch(p.rec) && filter(p.view),
      sort ? (a, b) => sort(a.view, b.view) : null,
      paging,
    );
    return hal(c, collection(REL.receiver, page.map((p) => state.renderReceiver(p.rec, detail)), totalResults, links));
  });

  // SOURCE: rels/inventory/receivers — POST /inventory/receivers → 201 + ETag.
  app.post('/inventory/receivers', async (c) => {
    const body = (await jsonBody(c)) as ReceiverCreateInput;
    const rec = state.createReceiver(body);
    // GUESS: as with orders, the create response's default detail is undocumented; the mock echoes items.
    return hal(c, state.renderReceiver(rec, { items: true }), 201, { ETag: state.etagOfReceiver(rec) });
  });

  // SOURCE: rels/inventory/inventoryhold — PUT /inventory/holder{?holdReason,release};
  // body {"receiveItemIdentifiers":[{"id":1}]}. Registered before /inventory/:anything-else.
  app.put('/inventory/holder', async (c) => {
    const body = await jsonBody(c);
    const ids = receiveItemIds(body.receiveItemIdentifiers);
    const release = /^(true|1)$/i.test((c.req.query('release') ?? '').trim());
    const holdReason = c.req.query('holdReason') ?? null;
    const done = state.holdLots(ids, holdReason, release);
    const missed = ids.filter((id) => !done.includes(id));
    // GUESS: the response body of the hold operator is not documented; the mock mirrors the documented
    // orderholder response ({heldOrderIds, exceptions}) with receive-item ids.
    return hal(c, {
      heldReceiveItemIds: done,
      exceptions: {
        $type: 'WMS.V2.Generic.Models.Exceptions.ListException, WMS.V2.Generic.Models',
        Faults: missed.map((id, idx) => ({
          EntryNumber: idx + 1,
          EntryInfo: `ReceiveItem ${id} does not exist`,
          WmsException: { ErrorCode: 'DoesNotExist', Hint: `ReceiveItem ${id} does not exist`, Message: `ReceiveItem ${id} does not exist` },
        })),
      },
    });
  });

  // SOURCE: rels/inventory/receiver — GET /inventory/receivers/{id}{?detail,itemdetail} → 200 + ETag.
  app.get('/inventory/receivers/:id', (c) => {
    const rec = requireReceiver(state, c);
    return hal(c, state.renderReceiver(rec, receiverDetailFlags(c)), 200, { ETag: state.etagOfReceiver(rec) });
  });

  // SOURCE: rels/inventory/receiver — PUT "Updates an unconfirmed receiver"; If-Match required; 200 + ETag.
  app.put('/inventory/receivers/:id', async (c) => {
    const rec = requireReceiver(state, c);
    requireIfMatch(c, state.etagOfReceiver(rec));
    const body = (await jsonBody(c)) as ReceiverCreateInput;
    state.updateReceiver(rec, body, Array.isArray(body.receiveItems), {});
    return hal(c, state.renderReceiver(rec, { items: true }), 200, { ETag: state.etagOfReceiver(rec) });
  });

  // SOURCE: rels/inventory/receiverconfirm — If-Match required, 204.
  app.post('/inventory/receivers/:id/confirmer', async (c) => {
    const rec = requireReceiver(state, c);
    requireIfMatch(c, state.etagOfReceiver(rec));
    const body = await jsonBody(c);
    state.confirmReceiver(rec, body as Parameters<MockState['confirmReceiver']>[1]);
    return new Response(null, { status: 204 });
  });

  // SOURCE: rels/inventory/receivercancel — If-Match required, body {"reason": "..."} required, 204.
  app.post('/inventory/receivers/:id/canceler', async (c) => {
    const rec = requireReceiver(state, c);
    requireIfMatch(c, state.etagOfReceiver(rec));
    const body = await jsonBody(c);
    state.cancelReceiver(rec, typeof body.reason === 'string' ? body.reason : null);
    return new Response(null, { status: 204 });
  });

  // SOURCE: rels/inventory/inventory — GET /inventory{?pgsiz,pgnum,rql,sort}, limit 1000 (default 100),
  // `_embedded.item`.
  app.get('/inventory', (c) => {
    const paging = parsePaging(c, PAGING.inventory);
    const filter = compileRql<InventoryRow>(c.req.query('rql'), INVENTORY_SHAPE);
    const sort = compileSort<InventoryRow>(c.req.query('sort'), INVENTORY_SHAPE);
    const { page, totalResults, links } = listPipeline(c, state.inventoryRows(), filter, sort, paging);
    return hal(c, collection('item', page, totalResults, links));
  });

  return app;
}

function requireReceiver(state: MockState, c: Context<MockEnv>): ReceiverRecord {
  const rec = state.receiverById(pathId(c, 'id'));
  if (!rec) throw notFound();
  return rec;
}

function receiverDetailFlags(c: Context<MockEnv>): { items: boolean } {
  const detail = parseEnumList(c, 'detail', RECEIVER_DETAIL, 'None');
  parseEnumList(c, 'itemdetail', RECEIVER_ITEM_DETAIL, 'None');
  return { items: detail.includes('All') || detail.includes('ReceiveItems') };
}

/** Same alias trick as orders: readOnly members are also reachable without the `readonly.` prefix. */
function receiverView(rec: ReceiverRecord): Record<string, unknown> {
  const r = rec.receiver;
  return {
    ...r,
    customerIdentifier: r.readOnly.customerIdentifier,
    facilityIdentifier: r.readOnly.facilityIdentifier,
    status: r.readOnly.status,
  };
}

/** SOURCE: rels/inventory/receivers — receivertype 0 Normal, 1 Return, 2 ReceiveAgainst (ASN), 3 OnlyASNs, 4 NoASNs. */
function receiverTypeFilter(c: Context<MockEnv>): (rec: ReceiverRecord) => boolean {
  const value = optionalIntQuery(c, 'receivertype');
  if (value === undefined) return () => true;
  switch (value) {
    case 0:
    case 1:
    case 2:
      return (rec) => rec.receiver.readOnly.receiverType === value;
    case 3:
      return (rec) => rec.receiver.readOnly.receiverType === ReceiverType.ReceiveAgainst;
    case 4:
      return (rec) => rec.receiver.readOnly.receiverType !== ReceiverType.ReceiveAgainst;
    default:
      throw queryParameter('NotParsable', ['receivertype'], 'receivertype must be 0..4');
  }
}

function receiveItemIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw modelValidation('Required', [{ Name: 'ReceiveItemIdentifiers', Value: null }], 'ReceiveItemIdentifiers is required');
  }
  return value.map((entry, idx) => {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw modelValidation('Required', [{ Name: `ReceiveItemIdentifiers[${idx}].Id`, Value: null }], 'Each identifier needs an integer id');
    }
    return id;
  });
}
