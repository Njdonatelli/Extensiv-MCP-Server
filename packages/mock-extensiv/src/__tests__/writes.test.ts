import { beforeEach, describe, expect, it } from 'vitest';
import { harness, orderBody, receiverBody, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

interface Summary {
  itemIdentifier: { sku: string };
  facilityId: number;
  available: number;
  allocated: number;
  onHand: number;
  onHold: number;
}

async function summary(sku: string, facilityId = 1): Promise<Summary> {
  const body = await h.getJson<{ summaries: Summary[] }>('/inventory/stocksummaries?pgsiz=500');
  const row = body.summaries.find((s) => s.itemIdentifier.sku === sku && s.facilityId === facilityId);
  if (!row) throw new Error(`no stock summary for ${sku}@${facilityId}`);
  return row;
}

describe('POST /orders', () => {
  it('creates an order, allocates stock and returns 201 + ETag + the order body', async () => {
    const before = await summary('ACME-STOVE-01');
    const res = await h.post('/orders', orderBody('WRITE-1'));
    expect(res.status).toBe(201);
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Content-Type')).toBe('application/hal+json; charset=utf-8');

    const order = (await res.json()) as {
      readOnly: { orderId: number; status: number; fullyAllocated: boolean; warehouseTransactionSourceType: number };
      referenceNum: string;
      _embedded: Record<string, unknown[]>;
      _links: Record<string, unknown>;
    };
    expect(order.referenceNum).toBe('WRITE-1');
    expect(order.readOnly.status).toBe(0);
    expect(order.readOnly.fullyAllocated).toBe(true);
    // SOURCE: WarehouseTransactionSourceType 7 = RestApi.
    expect(order.readOnly.warehouseTransactionSourceType).toBe(7);
    expect(order._embedded['http://api.3plCentral.com/rels/orders/item']).toHaveLength(1);
    expect(order._links['http://api.3plCentral.com/rels/orders/ordercancel']).toBeTruthy();

    const after = await summary('ACME-STOVE-01');
    expect(after.allocated).toBe(before.allocated + 2);
    expect(after.available).toBe(before.available - 2);
    expect(after.onHand).toBe(before.onHand);
  });

  it('releases the allocation when the order is cancelled', async () => {
    const before = await summary('ACME-STOVE-01');
    const created = await h.post('/orders', orderBody('WRITE-2'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    expect((await summary('ACME-STOVE-01')).available).toBe(before.available - 2);

    const cancel = await h.post(`/orders/${id}/canceler`, { reason: 'test' }, { 'If-Match': created.headers.get('ETag') as string });
    expect(cancel.status).toBe(204);

    const after = await summary('ACME-STOVE-01');
    expect(after.available).toBe(before.available);
    expect(after.allocated).toBe(before.allocated);
  });

  it('consumes on-hand stock when the order is confirmed (shipped)', async () => {
    const before = await summary('ACME-STOVE-01');
    const created = await h.post('/orders', orderBody('WRITE-3'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const confirm = await h.post(`/orders/${id}/confirmer`, { trackingNumber: '1Z-TEST' }, { 'If-Match': created.headers.get('ETag') as string });
    expect(confirm.status).toBe(204);

    const after = await summary('ACME-STOVE-01');
    expect(after.onHand).toBe(before.onHand - 2);
    expect(after.allocated).toBe(before.allocated);
    const order = await h.getJson<{ readOnly: { status: number; isClosed: boolean } }>(`/orders/${id}`);
    expect(order.readOnly.status).toBe(1);
    expect(order.readOnly.isClosed).toBe(true);
    const packages = await h.getJson<{ totalResults: number }>(`/orders/${id}/packages`);
    expect(packages.totalResults).toBe(1);
  });

  it('rejects a duplicate referenceNum with 400 ModelValidationException Duplicate', async () => {
    expect((await h.post('/orders', orderBody('DUP-1'))).status).toBe(201);
    const res = await h.post('/orders', orderBody('DUP-1'));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.ModelValidationException, WMS.V2.Generic.Models',
      ErrorCode: 'Duplicate',
      Properties: [{ Name: 'ReferenceNum', Value: 'DUP-1' }],
    });
  });

  it('rejects a duplicate of a seeded referenceNum', async () => {
    const res = await h.post('/orders', orderBody('ACME-SO-10001'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('Duplicate');
  });

  it.each([
    [{ referenceNum: undefined }, 'ReferenceNum'],
    [{ shipTo: undefined }, 'ShipTo'],
    [{ orderItems: [] }, 'OrderItems'],
  ])('rejects a missing required field with Required', async (override, name) => {
    const body = orderBody('REQ-1', override as Record<string, unknown>);
    if ((override as Record<string, unknown>).referenceNum === undefined && 'referenceNum' in override) delete body.referenceNum;
    if ('shipTo' in override) delete body.shipTo;
    const res = await h.post('/orders', body);
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ErrorCode: 'Required', Properties: [{ Name: name }] });
  });

  it('rejects an unknown sku with DoesNotExist', async () => {
    const res = await h.post('/orders', orderBody('BAD-SKU', { orderItems: [{ itemIdentifier: { sku: 'NOPE' }, qty: 1 }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('DoesNotExist');
  });

  it('rejects an unsupported orderType with ValueNotSupported', async () => {
    const res = await h.post('/orders', orderBody('BAD-TYPE', { orderType: 'Wholesale' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('ValueNotSupported');
  });
});

describe('POST /orders/{id}/confirmer', () => {
  it('403 NotFullyAllocated when the order is short', async () => {
    // Seeded ACME-SO-10021 (order 41029) asks for a COOLER-45 that is out of stock.
    const short = await h.getJson<{ readOnly: { fullyAllocated: boolean } }>('/orders/41029');
    expect(short.readOnly.fullyAllocated).toBe(false);

    const res = await h.post('/orders/41029/confirmer', {}, { 'If-Match': await h.etagOf('/orders/41029') });
    expect(res.status).toBe(403);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.OperationException, WMS.V2.Generic.Models',
      ErrorCode: 'NotFullyAllocated',
      ActionName: 'orderconfirm',
    });
  });

  it('succeeds once /__mock/stock supplies the missing units', async () => {
    expect((await h.control('/__mock/stock', 'POST', { customerId: 1, facilityId: 1, sku: 'ACME-COOLER-45', onHandDelta: 5 })).status).toBe(200);
    const after = await h.getJson<{ readOnly: { fullyAllocated: boolean } }>('/orders/41029');
    expect(after.readOnly.fullyAllocated).toBe(true);
    const res = await h.post('/orders/41029/confirmer', {}, { 'If-Match': await h.etagOf('/orders/41029') });
    expect(res.status).toBe(204);
  });

  it('403 DateInFuture for a confirmDate in the future', async () => {
    const created = await h.post('/orders', orderBody('FUTURE-1'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19);
    const res = await h.post(`/orders/${id}/confirmer`, { confirmDate: tomorrow }, { 'If-Match': created.headers.get('ETag') as string });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('DateInFuture');
  });
});

describe('PUT /orders/orderholder', () => {
  it('holds and releases orders and reports per-entry faults', async () => {
    const created = await h.post('/orders', orderBody('HOLD-1'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;

    const held = await h.put('/orders/orderholder?holdReason=Address%20verification', { orderIdentifiers: [{ id }, { id: 999_999 }] });
    expect(held.status).toBe(200);
    const body = (await held.json()) as { heldOrderIds: number[]; exceptions: { Faults: { EntryNumber: number }[] } };
    expect(body.heldOrderIds).toEqual([id]);
    expect(body.exceptions.Faults).toHaveLength(1);
    expect(body.exceptions.Faults[0]?.EntryNumber).toBe(2);

    const onHold = await h.getJson<{ readOnly: { onHoldReason: string | null } }>(`/orders/${id}`);
    expect(onHold.readOnly.onHoldReason).toBe('Address verification');

    // An order on hold cannot be confirmed.
    const blocked = await h.post(`/orders/${id}/confirmer`, {}, { 'If-Match': await h.etagOf(`/orders/${id}`) });
    expect(blocked.status).toBe(403);

    const released = await h.put('/orders/orderholder?release=true', { orderIdentifiers: [{ id }] });
    expect(released.status).toBe(200);
    const off = await h.getJson<{ readOnly: { onHoldReason: string | null } }>(`/orders/${id}`);
    expect(off.readOnly.onHoldReason).toBeNull();
  });

  it('deallocate=true releases the allocations as well', async () => {
    const created = await h.post('/orders', orderBody('HOLD-2'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    await h.put('/orders/orderholder?holdReason=QA&deallocate=true', { orderIdentifiers: [{ id }] });
    const after = await h.getJson<{ readOnly: { fullyAllocated: boolean } }>(`/orders/${id}`);
    expect(after.readOnly.fullyAllocated).toBe(false);
  });

  it('requires orderIdentifiers', async () => {
    const res = await h.put('/orders/orderholder', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('Required');
  });
});

describe('receivers', () => {
  it('creates, confirms and lands stock', async () => {
    const before = await summary('ACME-STOVE-01');
    const created = await h.post('/inventory/receivers', receiverBody('RCV-WRITE-1'));
    expect(created.status).toBe(201);
    const rec = (await created.json()) as { readOnly: { receiverId: number; status: number; receiverType: number } };
    // Acme is configured for Receive Against ASNs, so a new receipt is receiverType 2.
    expect(rec.readOnly.receiverType).toBe(2);
    expect(rec.readOnly.status).toBe(0);

    const confirm = await h.post(
      `/inventory/receivers/${rec.readOnly.receiverId}/confirmer`,
      {},
      { 'If-Match': created.headers.get('ETag') as string },
    );
    expect(confirm.status).toBe(204);

    const after = await summary('ACME-STOVE-01');
    expect(after.onHand).toBe(before.onHand + 5);
    expect(after.available).toBe(before.available + 5);
    const reloaded = await h.getJson<{ readOnly: { status: number } }>(`/inventory/receivers/${rec.readOnly.receiverId}`);
    expect(reloaded.readOnly.status).toBe(1);
  });

  it('rejects a duplicate referenceNum with 400 Duplicate', async () => {
    expect((await h.post('/inventory/receivers', receiverBody('RCV-DUP'))).status).toBe(201);
    const res = await h.post('/inventory/receivers', receiverBody('RCV-DUP'));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ErrorCode: 'Duplicate',
      Properties: [{ Name: 'ReferenceNum', Value: 'RCV-DUP' }],
    });
  });

  it('cancels with a reason and refuses a second cancel', async () => {
    const created = await h.post('/inventory/receivers', receiverBody('RCV-CANCEL'));
    const id = ((await created.json()) as { readOnly: { receiverId: number } }).readOnly.receiverId;
    const etag = created.headers.get('ETag') as string;
    expect((await h.post(`/inventory/receivers/${id}/canceler`, {}, { 'If-Match': etag })).status).toBe(400);
    expect((await h.post(`/inventory/receivers/${id}/canceler`, { reason: 'supplier cancelled' }, { 'If-Match': etag })).status).toBe(204);
    const again = await h.post(`/inventory/receivers/${id}/canceler`, { reason: 'x' }, { 'If-Match': await h.etagOf(`/inventory/receivers/${id}`) });
    expect(again.status).toBe(403);
  });

  it('requires a lot number for a lot-tracked sku', async () => {
    const res = await h.post(
      '/inventory/receivers',
      receiverBody('RCV-LOT', { receiveItems: [{ itemIdentifier: { sku: 'ACME-FILTER-SQZ' }, qty: 5 }] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ErrorCode: 'Required' });
  });
});

describe('PUT /inventory/holder', () => {
  it('places a lot on hold and releases it again', async () => {
    const detail = await h.getJson<{ _embedded: { item: { receiveItemId: number; available: number; isOnHold: boolean }[] } }>(
      '/inventory/stockdetails?customerid=1&facilityid=1&pgsiz=500',
    );
    const lot = detail._embedded.item[0] as { receiveItemId: number; available: number; isOnHold: boolean };
    expect(lot.isOnHold).toBe(false);

    const held = await h.put(`/inventory/holder?holdReason=Damaged`, { receiveItemIdentifiers: [{ id: lot.receiveItemId }] });
    expect(held.status).toBe(200);
    expect(((await held.json()) as { heldReceiveItemIds: number[] }).heldReceiveItemIds).toEqual([lot.receiveItemId]);

    const afterHold = await h.getJson<{ _embedded: { item: { receiveItemId: number; isOnHold: boolean; available: number }[] } }>(
      '/inventory/stockdetails?customerid=1&facilityid=1&pgsiz=500',
    );
    const heldLot = afterHold._embedded.item.find((r) => r.receiveItemId === lot.receiveItemId);
    expect(heldLot?.isOnHold).toBe(true);
    expect(heldLot?.available).toBe(0);

    await h.put(`/inventory/holder?release=true`, { receiveItemIdentifiers: [{ id: lot.receiveItemId }] });
    const afterRelease = await h.getJson<{ _embedded: { item: { receiveItemId: number; isOnHold: boolean; available: number }[] } }>(
      '/inventory/stockdetails?customerid=1&facilityid=1&pgsiz=500',
    );
    const released = afterRelease._embedded.item.find((r) => r.receiveItemId === lot.receiveItemId);
    expect(released?.isOnHold).toBe(false);
    expect(released?.available).toBe(lot.available);
  });
});
