import { UpstreamHttpError, WmsError } from '@mcp-3pl/core';
import type { CancelOrderInput, CreateOrderInput, MutationPlan, UpdateOrderInput } from '@mcp-3pl/core';
import { describe, expect, it } from 'vitest';
import { createExtensivAdapter, translateUpstreamError } from '../adapter.js';
import { REL } from '../hal.js';
import type { WireOrder, WireReceiver } from '../wire.js';
import { FakeClock, baseRoutes, createFakeApi, fixture, halCollection, route, testConfig, type Ctx, type Route } from './fake_api.js';

function mk(routes: Route[], clock: FakeClock = new FakeClock()) {
  const api = createFakeApi([...routes, ...baseRoutes()]);
  const adapter = createExtensivAdapter(testConfig(), { fetchImpl: api.fetchImpl, clock });
  return { api, adapter, clock };
}

const ETAG_1001 = 'W/"order-1001-v7"';

function ordersById(map: Record<string, { body: unknown; etag?: string }>): Route {
  return route('GET', /^\/orders\/\d+$/, (ctx) => {
    const id = ctx.path.split('/')[2] ?? '';
    const found = map[id];
    if (!found) return undefined;
    return { status: 200, body: found.body, headers: found.etag ? { etag: found.etag } : {} };
  });
}

function ordersList(rowsFor: (ctx: Ctx) => unknown[]): Route {
  return route('GET', '/orders', (ctx) => ({ status: 200, body: halCollection(REL.order, rowsFor(ctx)) }));
}

const openOrder = () => fixture<WireOrder>('order_open.json');
const closedOrder = () => fixture<WireOrder>('order_closed.json');
const cancelledOrder = () => fixture<WireOrder>('order_cancelled.json');

const SHIP_TO = { name: 'Dana Receiver', companyName: 'Widgets R Us', address1: '500 Market St', city: 'San Francisco', state: 'CA', zip: '94105', country: 'US' };

function createOrderInput(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    customerId: '143',
    facilityId: '10',
    referenceNum: 'PO-NEW-1',
    shipTo: SHIP_TO,
    lines: [{ sku: 'WIDGET-BLUE', qty: 5 }],
    carrier: 'FedEx',
    service: 'Ground',
    ...over,
  };
}

const stockRoute = () => route('GET', '/inventory/stocksummaries', () => ({ status: 200, body: fixture('stocksummaries.json') }));
const stockDetailRoute = () => route('GET', '/inventory/stockdetails', () => ({ status: 200, body: fixture('stockdetails.json') }));

// ---------------------------------------------------------------------------

describe('verifyConnection', () => {
  it('reports identity, counts, latency and no problems on a healthy connection', async () => {
    const { adapter } = mk([]);
    const status = await adapter.verifyConnection();
    expect(status).toMatchObject({
      ok: true,
      system: 'extensiv-3pl-warehouse-manager',
      baseUrl: 'https://secure-wms.test',
      authenticated: true,
      reachableCustomers: 2,
      reachableFacilities: 2,
      problems: [],
    });
    expect(status.identity).toMatchObject({ clientIdMasked: 'cid-…', userLogin: 'integration-user' });
    expect(status.tokenExpiresInSeconds).toBe(3300);
  });

  it('turns a 403 into a named-role problem instead of throwing', async () => {
    const { adapter } = mk([
      route('GET', '/customers', () => ({
        status: 403,
        body: { $type: 'WMS.V2.Generic.Models.Exceptions.AuthorizationException, WMS.V2.Generic.Models', ErrorCode: 'Forbidden', Hint: 'CustomerView is required' },
      })),
    ]);
    const status = await adapter.verifyConnection();
    expect(status.ok).toBe(false);
    expect(status.authenticated).toBe(true);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toContain('CustomerView');
    expect(status.reachableFacilities).toBe(2);
  });
});

describe('reference data caching', () => {
  it('caches customers and facilities for 60 seconds', async () => {
    const { adapter, api, clock } = mk([]);
    await adapter.listCustomers();
    await adapter.listCustomers();
    await adapter.listFacilities();
    expect(api.calls.filter((c) => c.path === '/customers')).toHaveLength(1);
    clock.advance(61);
    await adapter.listCustomers();
    expect(api.calls.filter((c) => c.path === '/customers')).toHaveLength(2);
  });
});

describe('findOrders', () => {
  it('sends the documented detail/sort/paging parameters and the rql conjunction', async () => {
    const { adapter, api } = mk([ordersList(() => fixture<{ _embedded: Record<string, unknown[]> }>('orders_page.json')._embedded[REL.order] ?? [])]);
    const page = await adapter.findOrders({ customerId: '143', statuses: ['open'], onHold: true, limit: 25, page: 2 });
    const call = api.calls.find((c) => c.path === '/orders')!;
    expect(call.query.get('detail')).toBe('OrderItems');
    expect(call.query.get('sort')).toBe('-readonly.creationdate');
    expect(call.query.get('pgsiz')).toBe('25');
    expect(call.query.get('pgnum')).toBe('2');
    expect(call.query.get('rql')).toBe('readonly.customeridentifier.id==143;readonly.onholddate=hv=true;(readonly.isclosed==false;readonly.status!=2)');
    expect(page.pageSize).toBe(25);
    expect(page.items.map((o) => o.id)).toEqual(['1001', '1002']);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it('passes a SKU filter as the documented skulist parameter, not as rql', async () => {
    const { adapter, api } = mk([ordersList(() => [])]);
    await adapter.findOrders({ sku: 'WIDGET-BLUE' });
    const call = api.calls.find((c) => c.path === '/orders')!;
    expect(call.query.get('skulist')).toBe('WIDGET-BLUE');
    expect(call.query.get('rql')).toBeNull();
  });
});

describe('getOrder', () => {
  it('captures the ETag as the version when fetching by id', async () => {
    const { adapter, api } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const order = await adapter.getOrder({ id: '1001' });
    expect(order?.version).toBe(ETAG_1001);
    expect(order?.status).toBe('open');
    const call = api.calls.find((c) => c.path === '/orders/1001')!;
    expect(call.query.get('detail')).toBe('All');
    expect(call.query.get('itemdetail')).toBe('All');
  });

  it('returns null for an unknown id and for a reference number with no hits', async () => {
    const { adapter } = mk([ordersList(() => [])]);
    expect(await adapter.getOrder({ id: '999999' })).toBeNull();
    expect(await adapter.getOrder({ referenceNum: 'NOPE' })).toBeNull();
  });

  it('resolves a reference number to an id and re-reads it so the ETag is real', async () => {
    const { adapter, api } = mk([ordersList(() => [{ readOnly: { orderId: 1001 } }]), ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const order = await adapter.getOrder({ referenceNum: 'PO-1001', customerId: '143' });
    expect(order?.id).toBe('1001');
    expect(order?.version).toBe(ETAG_1001);
    const list = api.calls.find((c) => c.path === '/orders')!;
    expect(list.query.get('rql')).toBe('referencenum==PO-1001;readonly.customeridentifier.id==143');
  });

  it('refuses an ambiguous reference number and names the candidate customers', async () => {
    const { adapter } = mk([
      ordersList(() => [
        { readOnly: { orderId: 1001, customerIdentifier: { id: 143, name: 'Acme Distribution' } } },
        { readOnly: { orderId: 2002, customerIdentifier: { id: 144, name: 'Old Client LLC' } } },
      ]),
    ]);
    await expect(adapter.getOrder({ referenceNum: 'SHARED-REF' })).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    await adapter.getOrder({ referenceNum: 'SHARED-REF' }).catch((e: WmsError) => {
      expect(e.message).toContain('Acme Distribution');
      expect(e.message).toContain('Old Client LLC');
    });
  });
});

describe('findReceipts / getReceipt', () => {
  it('queries /inventory/receivers with detail=ReceiveItems and maps variances', async () => {
    const { adapter, api } = mk([route('GET', '/inventory/receivers', () => ({ status: 200, body: fixture('receivers_page.json') }))]);
    const page = await adapter.findReceipts({ customerId: '143', statuses: ['open'], poNum: 'PO-88' });
    const call = api.calls.find((c) => c.path === '/inventory/receivers')!;
    expect(call.query.get('detail')).toBe('ReceiveItems');
    expect(call.query.get('rql')).toBe('readonly.customeridentifier.id==143;ponum==PO-88;readonly.status==0');
    expect(page.items[0]).toMatchObject({ id: '3001', totalExpectedQty: 150, totalReceivedQty: 0 });
  });

  it('reads a single receipt with detail=All and the ETag as version', async () => {
    const { adapter } = mk([route('GET', '/inventory/receivers/3001', () => ({ status: 200, body: fixture<WireReceiver>('receiver_open.json'), headers: { etag: 'rcv-etag' } }))]);
    const receipt = await adapter.getReceipt({ id: '3001' });
    expect(receipt).toMatchObject({ id: '3001', status: 'open', version: 'rcv-etag' });
  });
});

describe('getInventory', () => {
  it('drops zero rows, resolves refs from the cached lists and skips lots by default', async () => {
    const { adapter, api } = mk([stockRoute(), stockDetailRoute()]);
    const positions = await adapter.getInventory({ customerId: '143', facilityId: '10' });
    expect(positions.map((p) => p.sku)).toEqual(['WIDGET-BLUE', 'WIDGET-RED']);
    expect(positions[0]).toMatchObject({ customer: { id: '143', name: 'Acme Distribution' }, facility: { id: '10', name: 'LAX-1' }, onHand: 200, available: 174 });
    expect(api.calls.some((c) => c.path === '/inventory/stockdetails')).toBe(false);
    const call = api.calls.find((c) => c.path === '/inventory/stocksummaries')!;
    expect(call.query.get('rql')).toBe('customeridentifier.id==143;facilityid==10');
  });

  it('keeps zero rows when asked and filters client-side on skuContains', async () => {
    const { adapter } = mk([stockRoute()]);
    const all = await adapter.getInventory({ customerId: '143', includeZero: true });
    expect(all.map((p) => p.sku)).toEqual(['WIDGET-BLUE', 'WIDGET-RED', 'WIDGET-GONE']);
    const filtered = await adapter.getInventory({ customerId: '143', includeZero: true, skuContains: 'gone' });
    expect(filtered.map((p) => p.sku)).toEqual(['WIDGET-GONE']);
  });

  it('fetches lots with the required customerid + facilityid and attaches them', async () => {
    const { adapter, api } = mk([stockRoute(), stockDetailRoute()]);
    const positions = await adapter.getInventory({ customerId: '143', facilityId: '10', includeLots: true });
    const call = api.calls.find((c) => c.path === '/inventory/stockdetails')!;
    expect(call.query.get('customerid')).toBe('143');
    expect(call.query.get('facilityid')).toBe('10');
    expect(positions[0]!.lots?.map((l) => l.lotNumber)).toEqual(['L-77', 'L-90']);
  });

  it('walks the customer facilities when no facility was given, because both ids are required', async () => {
    const { adapter, api } = mk([stockRoute(), stockDetailRoute()]);
    await adapter.getInventory({ customerId: '143', includeLots: true });
    expect(api.calls.filter((c) => c.path === '/inventory/stockdetails').map((c) => c.query.get('facilityid'))).toEqual(['10', '11']);
  });
});

describe('findItems', () => {
  it('requires a customer id because the item master is per customer', async () => {
    const { adapter } = mk([]);
    await expect(adapter.findItems({})).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('builds sku / upc / text / active rql against /customers/{id}/items', async () => {
    const { adapter, api } = mk([]);
    const items = await adapter.findItems({ customerId: '143', textSearch: 'widget', activeOnly: true });
    const call = api.calls.find((c) => c.path === '/customers/143/items')!;
    expect(call.query.get('pgsiz')).toBe('100');
    expect(call.query.get('rql')).toBe('(sku==*widget*,description==*widget*);readonly.deactivated==false');
    expect(items.map((i) => i.sku)).toEqual(['WIDGET-BLUE', 'WIDGET-RED']);
  });
});

describe('planMutation: create_order', () => {
  it('previews the resolved names, the lines with availability and a natural key, writing nothing', async () => {
    const { adapter, api } = mk([stockRoute()]);
    const plan = await adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'WIDGET-BLUE', qty: 5 }, { sku: 'WIDGET-RED', qty: 2 }] }));
    expect(plan.summary).toBe('Create order PO-NEW-1 for Acme Distribution at LAX-1 with 2 lines (7 units)');
    expect(plan.scope).toEqual({ customerId: '143', customerName: 'Acme Distribution', facilityId: '10', facilityName: 'LAX-1' });
    expect(plan.naturalKey).toEqual({ type: 'order.referenceNum', value: '143:PO-NEW-1' });
    expect(plan.preconditions).toEqual([{ type: 'absent', resource: 'order.referenceNum/143:PO-NEW-1', description: 'no order with reference number PO-NEW-1 exists for Acme Distribution yet' }]);
    expect(plan.risk).toBe('medium');
    expect(plan.upstreamIdempotent).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(plan.preview.lines).toEqual([
      { sku: 'WIDGET-BLUE', description: 'Blue widget, 6 inch', qty: 5, qualifier: undefined, lotNumber: undefined, availableAtFacility: 174, short: 0 },
      { sku: 'WIDGET-RED', description: 'Red widget, 6 inch', qty: 2, qualifier: undefined, lotNumber: undefined, availableAtFacility: 180, short: 0 },
    ]);
    expect(plan.upstream).toEqual([
      {
        method: 'POST',
        path: '/orders',
        body: {
          customerIdentifier: { id: 143 },
          facilityIdentifier: { id: 10 },
          referenceNum: 'PO-NEW-1',
          poNum: undefined,
          notes: undefined,
          earliestShipDate: undefined,
          routingInfo: { carrier: 'FedEx', mode: 'Ground' },
          shipTo: { companyName: 'Widgets R Us', name: 'Dana Receiver', address1: '500 Market St', address2: undefined, city: 'San Francisco', state: 'CA', zip: '94105', country: 'US', phoneNumber: undefined, emailAddress: undefined },
          orderItems: [
            { itemIdentifier: { sku: 'WIDGET-BLUE' }, qty: 5, qualifier: undefined, lotNumber: undefined },
            { itemIdentifier: { sku: 'WIDGET-RED' }, qty: 2, qualifier: undefined, lotNumber: undefined },
          ],
        },
      },
    ]);
    // Planning is read-only.
    expect(api.calls.filter((c) => c.method !== 'GET' && c.path !== '/AuthServer/api/Token')).toEqual([]);
  });

  it('warns but does not refuse when a line is short on stock', async () => {
    const { adapter } = mk([stockRoute()]);
    const plan = await adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'WIDGET-BLUE', qty: 200 }] }));
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('short 26');
    expect(plan.preview.lines).toMatchObject([{ short: 26, availableAtFacility: 174 }]);
  });

  it('refuses an unknown SKU by name', async () => {
    const { adapter } = mk([stockRoute()]);
    await expect(adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'NOT-A-SKU', qty: 1 }] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { missingSkus: ['NOT-A-SKU'] },
    });
  });

  it('refuses a deactivated SKU', async () => {
    const { adapter } = mk([stockRoute()]);
    await expect(adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'WIDGET-LEGACY', qty: 1 }] }))).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { inactiveSkus: ['WIDGET-LEGACY'] },
    });
  });

  it('refuses an unknown customer and a facility that is not on the customer', async () => {
    const { adapter } = mk([stockRoute()]);
    await expect(adapter.planMutation('create_order', createOrderInput({ customerId: '999' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Facility 10 exists but is not on customer 144's facility list.
    const err = await adapter.planMutation('create_order', createOrderInput({ customerId: '144', facilityId: '10' })).catch((e: WmsError) => e);
    expect((err as WmsError).code).toBe('VALIDATION');
    expect((err as WmsError).message).toContain('not enabled for customer 144');
    await expect(adapter.planMutation('create_order', createOrderInput({ facilityId: '99' }))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('requires the ship-to essentials', async () => {
    const { adapter } = mk([stockRoute()]);
    await expect(adapter.planMutation('create_order', createOrderInput({ shipTo: { name: 'Dana' } }))).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { missing: ['address1', 'city', 'state', 'zip'] },
    });
  });
});

describe('planMutation: update_order and cancel_order', () => {
  it('refuses to update a cancelled order', async () => {
    const { adapter } = mk([ordersById({ '1003': { body: cancelledOrder(), etag: 'etag-1003' } })]);
    await expect(adapter.planMutation('update_order', { orderId: '1003', notes: 'x' } satisfies UpdateOrderInput)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to update a closed order with a hint about reopening', async () => {
    const { adapter } = mk([ordersById({ '1002': { body: closedOrder(), etag: 'etag-1002' } })]);
    const err = await adapter.planMutation('update_order', { orderId: '1002', notes: 'x' }).catch((e: WmsError) => e);
    expect(err).toBeInstanceOf(WmsError);
    expect((err as WmsError).code).toBe('VALIDATION');
    expect((err as WmsError).hint).toContain('reopened');
  });

  it('builds a before/after diff, strips readOnly and sends If-Match', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await adapter.planMutation('update_order', { orderId: '1001', carrier: 'UPS', shipTo: { city: 'Oakland' } });
    expect(plan.preview.changedFields).toEqual(['carrier', 'shipTo']);
    expect(plan.preview.before).toMatchObject({ carrier: 'FedEx' });
    expect((plan.preview.after as { shipTo: { city: string } }).shipTo.city).toBe('Oakland');
    const req = plan.upstream[0]!;
    expect(req.method).toBe('PUT');
    expect(req.path).toBe('/orders/1001?detail=None');
    expect(req.headers).toEqual({ 'If-Match': ETAG_1001 });
    const body = req.body as Record<string, unknown>;
    expect(body.readOnly).toBeUndefined();
    expect(body._embedded).toBeUndefined();
    expect(body.orderItems).toBeUndefined();
    expect(body.referenceNum).toBe('PO-1001');
    expect(body.routingInfo).toMatchObject({ carrier: 'UPS', mode: 'Ground' });
    expect(body.shipTo).toMatchObject({ city: 'Oakland', address1: '500 Market St' });
    expect(plan.preconditions).toEqual([
      { type: 'version', resource: 'order/1001', expected: ETAG_1001, description: 'order 1001 is still at the version that was previewed' },
      { type: 'status', resource: 'order/1001', expected: ['open'], description: 'order 1001 is still open' },
    ]);
    expect(plan.warnings[0]).toContain('on hold');
  });

  it('refuses an update that would change nothing', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    await expect(adapter.planMutation('update_order', { orderId: '1001', carrier: 'FedEx' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to cancel a closed (shipped) order', async () => {
    const { adapter } = mk([ordersById({ '1002': { body: closedOrder(), etag: 'etag-1002' } })]);
    const err = await adapter.planMutation('cancel_order', { orderId: '1002', reason: 'customer changed mind' }).catch((e: WmsError) => e);
    expect((err as WmsError).code).toBe('VALIDATION');
    expect((err as WmsError).message).toContain('shipped orders cannot be cancelled here');
  });

  it('plans a cancel as high risk with If-Match and a status precondition', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await adapter.planMutation('cancel_order', { orderId: '1001', reason: 'duplicate order' });
    expect(plan.risk).toBe('high');
    expect(plan.upstreamIdempotent).toBe(false);
    expect(plan.upstream).toEqual([{ method: 'POST', path: '/orders/1001/canceler', body: { reason: 'duplicate order' }, headers: { 'If-Match': ETAG_1001 } }]);
    expect(plan.preconditions[0]).toMatchObject({ type: 'status', expected: ['open'] });
  });

  it('marks a cancel of an already-cancelled order idempotent and warns', async () => {
    const { adapter } = mk([ordersById({ '1003': { body: cancelledOrder(), etag: 'etag-1003' } })]);
    const plan = await adapter.planMutation('cancel_order', { orderId: '1003', reason: 'cleanup' });
    expect(plan.upstreamIdempotent).toBe(true);
    expect(plan.warnings[0]).toContain('already cancelled');
    expect(plan.preconditions[0]).toMatchObject({ type: 'status', expected: ['open', 'cancelled'] });
  });

  it('requires a cancellation reason', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    await expect(adapter.planMutation('cancel_order', { orderId: '1001', reason: '  ' } satisfies CancelOrderInput)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('planMutation: create_receipt', () => {
  it('validates the SKUs and builds the receiveItems body', async () => {
    const { adapter } = mk([]);
    const plan = await adapter.planMutation('create_receipt', {
      customerId: '143',
      facilityId: '10',
      referenceNum: 'ASN-NEW-1',
      poNum: 'PO-99',
      expectedDate: '2026-09-20T00:00:00Z',
      lines: [{ sku: 'WIDGET-BLUE', qty: 100 }],
    });
    expect(plan.summary).toBe('Create receipt ASN-NEW-1 for Acme Distribution at LAX-1 with 1 line (100 units)');
    expect(plan.naturalKey).toEqual({ type: 'receipt.referenceNum', value: '143:ASN-NEW-1' });
    expect(plan.upstream[0]).toMatchObject({ method: 'POST', path: '/inventory/receivers' });
    expect((plan.upstream[0]!.body as { receiveItems: unknown[] }).receiveItems).toEqual([
      { itemIdentifier: { sku: 'WIDGET-BLUE' }, qty: 100, qualifier: undefined, lotNumber: undefined, expirationDate: undefined },
    ]);
    // WIDGET-BLUE is lot- and expiration-tracked in the fixture.
    expect(plan.warnings).toHaveLength(2);
  });
});

describe('checkPreconditions', () => {
  it('passes an absent check only when nothing is found', async () => {
    const empty = mk([ordersList(() => [])]);
    const plan = await empty.adapter.planMutation('create_order', createOrderInput());
    const okResults = await empty.adapter.checkPreconditions(plan);
    expect(okResults.map((r) => r.ok)).toEqual([true]);

    const taken = mk([ordersList(() => [{ readOnly: { orderId: 1001 } }])]);
    const failed = await taken.adapter.checkPreconditions(plan);
    expect(failed[0]!.ok).toBe(false);
    expect(failed[0]!.actual).toBe('1001');
  });

  it('compares the current ETag and status against the plan', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await adapter.planMutation('update_order', { orderId: '1001', notes: 'new note' });
    const ok = await adapter.checkPreconditions(plan);
    expect(ok.map((r) => r.ok)).toEqual([true, true]);

    const moved = mk([ordersById({ '1001': { body: openOrder(), etag: 'W/"order-1001-v8"' } })]);
    const stale = await moved.adapter.checkPreconditions(plan);
    expect(stale[0]).toMatchObject({ ok: false, actual: 'W/"order-1001-v8"' });
    expect(stale[1]!.ok).toBe(true);
  });

  it('fails a status precondition when the order was cancelled meanwhile', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await adapter.planMutation('cancel_order', { orderId: '1001', reason: 'x' });
    const gone = mk([ordersById({ '1001': { body: { ...cancelledOrder(), readOnly: { ...cancelledOrder().readOnly, orderId: 1001 } }, etag: ETAG_1001 } })]);
    const results = await gone.adapter.checkPreconditions(plan);
    expect(results[0]).toMatchObject({ ok: false, actual: 'cancelled' });
  });
});

describe('findApplied', () => {
  it('reports an existing order for a create plan whose reference number is already taken AND whose lines match', async () => {
    const { adapter } = mk([ordersList(() => [{ readOnly: { orderId: 1001 } }]), ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } }), stockRoute()]);
    const plan = await adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'WIDGET-BLUE', qty: 10 }, { sku: 'WIDGET-RED', qty: 20 }] }));
    const applied = await adapter.findApplied(plan);
    expect(applied).toMatchObject({ resourceType: 'order', resourceId: '1001', referenceNum: 'PO-NEW-1', status: 'open', version: ETAG_1001, via: 'found_existing' });
  });

  it('refuses to claim an order that holds the reference number but different lines', async () => {
    // Reference numbers are unique per customer, so this is someone else's order. Calling
    // it "already applied" would tell the operator their order exists when it does not.
    const { adapter } = mk([ordersList(() => [{ readOnly: { orderId: 1001 } }]), ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } }), stockRoute()]);
    const plan = await adapter.planMutation('create_order', createOrderInput());
    await expect(adapter.findApplied(plan)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('returns null when the reference number is free', async () => {
    const { adapter } = mk([ordersList(() => []), stockRoute()]);
    const plan = await adapter.planMutation('create_order', createOrderInput());
    expect(await adapter.findApplied(plan)).toBeNull();
  });

  it('reports an already-cancelled order for a cancel plan, and null while it is still open', async () => {
    const open = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await open.adapter.planMutation('cancel_order', { orderId: '1001', reason: 'dupe' });
    expect(await open.adapter.findApplied(plan)).toBeNull();

    const done = mk([ordersById({ '1001': { body: { ...cancelledOrder(), readOnly: { ...cancelledOrder().readOnly, orderId: 1001 } }, etag: 'etag-x' } })]);
    expect(await done.adapter.findApplied(plan)).toMatchObject({ resourceId: '1001', status: 'cancelled', via: 'found_existing' });
  });

  it('cannot prove an update was applied', async () => {
    const { adapter } = mk([ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } })]);
    const plan = await adapter.planMutation('update_order', { orderId: '1001', notes: 'note' });
    expect(await adapter.findApplied(plan)).toBeNull();
  });
});

describe('executeMutation', () => {
  it('creates an order and reports the new id, status and ETag', async () => {
    const created = { ...openOrder(), readOnly: { ...openOrder().readOnly, orderId: 4242 }, referenceNum: 'PO-NEW-1' };
    const { adapter } = mk([stockRoute(), route('POST', '/orders', () => ({ status: 201, body: created, headers: { etag: 'new-etag' } }))]);
    const plan = await adapter.planMutation('create_order', createOrderInput());
    const outcome = await adapter.executeMutation(plan);
    expect(outcome).toMatchObject({ resourceType: 'order', resourceId: '4242', referenceNum: 'PO-NEW-1', status: 'open', version: 'new-etag', via: 'executed' });
  });

  it('translates 412 into PRECONDITION_FAILED', async () => {
    const { adapter } = mk([
      ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } }),
      route('PUT', '/orders/1001', () => ({ status: 412, body: { $type: 'WMS.V2.Generic.Models.Exceptions.WmsException, WMS.V2.Generic.Models', ErrorCode: 'PreconditionFailed' } })),
    ]);
    const plan = await adapter.planMutation('update_order', { orderId: '1001', notes: 'changed' });
    const err = await adapter.executeMutation(plan).catch((e: WmsError) => e);
    expect((err as WmsError).code).toBe('PRECONDITION_FAILED');
    expect((err as WmsError).hint).toContain('Prepare the change again');
  });

  it('reconciles a 400 Duplicate against the natural key and reports the existing order', async () => {
    let created = false;
    const { adapter } = mk([
      stockRoute(),
      route('POST', '/orders', () => {
        created = true;
        return { status: 400, body: { $type: 'WMS.V2.Generic.Models.Exceptions.ModelValidationException, WMS.V2.Generic.Models', ModelType: 'Order', ErrorCode: 'Duplicate', Hint: 'ReferenceNum' } };
      }),
      // The first create did land upstream; its response was lost, so the retry sees a duplicate.
      ordersList((ctx) => (created && ctx.query.get('rql')?.includes('PO-NEW-1') ? [{ readOnly: { orderId: 7777 } }] : [])),
      ordersById({ '7777': { body: { ...openOrder(), readOnly: { ...openOrder().readOnly, orderId: 7777 }, referenceNum: 'PO-NEW-1' }, etag: 'etag-7777' } }),
    ]);
    const plan = await adapter.planMutation('create_order', createOrderInput({ lines: [{ sku: 'WIDGET-BLUE', qty: 10 }, { sku: 'WIDGET-RED', qty: 20 }] }));
    const outcome = await adapter.executeMutation(plan);
    expect(outcome).toMatchObject({ resourceType: 'order', resourceId: '7777', referenceNum: 'PO-NEW-1', via: 'found_existing', version: 'etag-7777' });
  });

  it('re-reads the order after a 204 operator so the outcome carries a real status', async () => {
    let cancelled = false;
    const { adapter, api } = mk([
      route('POST', '/orders/1001/canceler', () => {
        cancelled = true;
        return { status: 204 };
      }),
      route('GET', '/orders/1001', () => (cancelled ? { status: 200, body: { ...openOrder(), readOnly: { ...openOrder().readOnly, status: 2 } }, headers: { etag: 'etag-after' } } : undefined)),
      ordersById({ '1001': { body: openOrder(), etag: ETAG_1001 } }),
    ]);
    const plan = await adapter.planMutation('cancel_order', { orderId: '1001', reason: 'duplicate' });
    const outcome = await adapter.executeMutation(plan);
    expect(outcome).toMatchObject({ resourceType: 'order', resourceId: '1001', status: 'cancelled', version: 'etag-after', via: 'executed' });
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/orders/1001/canceler')!;
    expect(post.headers['if-match']).toBe(ETAG_1001);
    expect(post.body).toEqual({ reason: 'duplicate' });
  });
});

describe('translateUpstreamError', () => {
  const ctx = { what: 'POST /orders/1/canceler' };
  const err = (status: number, body: unknown) => new UpstreamHttpError(status, body, { method: 'POST', path: '/orders/1/canceler' });

  it('maps 428 to INTERNAL because this adapter always sends If-Match', () => {
    expect(translateUpstreamError(err(428, {}), ctx).code).toBe('INTERNAL');
  });

  it('maps a 403 OperationException to VALIDATION carrying the upstream Hint', () => {
    const e = translateUpstreamError(
      err(403, { $type: 'WMS.V2.Generic.Models.Exceptions.OperationException, WMS.V2.Generic.Models', ActionName: 'Cancel', ErrorCode: 'OrderCanceled', Hint: 'The order is already canceled.' }),
      ctx,
    );
    expect(e.code).toBe('VALIDATION');
    expect(e.hint).toBe('The order is already canceled.');
    expect(e.message).toContain('OrderCanceled');
  });

  it('maps a plain 403 to SCOPE_DENIED and 404 to NOT_FOUND', () => {
    expect(translateUpstreamError(err(403, { $type: 'WMS.V2.Generic.Models.Exceptions.AuthorizationException, WMS.V2.Generic.Models', ErrorCode: 'Forbidden' }), ctx).code).toBe('SCOPE_DENIED');
    expect(translateUpstreamError(err(404, {}), ctx).code).toBe('NOT_FOUND');
  });

  it('reads an ErrorCode out of a ListException fault', () => {
    const e = translateUpstreamError(err(400, { $type: 'ListException', Faults: [{ EntryNumber: 1, WmsException: { ErrorCode: 'Required', Hint: 'ReferenceNum is required.' } }] }), ctx);
    expect(e.code).toBe('VALIDATION');
    expect(e.message).toContain('Required');
    expect(e.hint).toBe('ReferenceNum is required.');
  });

  it('keeps the rate-limit and server-error codes the HTTP client already assigned', () => {
    expect(translateUpstreamError(err(429, {}), ctx).code).toBe('RATE_LIMITED');
    expect(translateUpstreamError(err(503, {}), ctx).code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('plan type dispatch', () => {
  it('rejects an unknown mutation kind', async () => {
    const { adapter } = mk([]);
    await expect(adapter.planMutation('nope' as 'create_order', {} as CreateOrderInput)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to execute a plan with no upstream request', async () => {
    const { adapter } = mk([]);
    const plan = { kind: 'create_order', upstream: [], preconditions: [], warnings: [], preview: {}, summary: '', scope: { customerId: '1' }, input: createOrderInput(), risk: 'medium', upstreamIdempotent: false } as unknown as MutationPlan;
    await expect(adapter.executeMutation(plan)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
