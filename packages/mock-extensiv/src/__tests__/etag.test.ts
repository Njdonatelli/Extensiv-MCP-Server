import { beforeEach, describe, expect, it } from 'vitest';
import { harness, orderBody, receiverBody, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('ETag / If-Match on PUT /orders/{id}', () => {
  it('returns an ETag on create and on single GET', async () => {
    const created = await h.post('/orders', orderBody('ETAG-1'));
    expect(created.status).toBe(201);
    const etag = created.headers.get('ETag');
    expect(etag).toMatch(/^"[A-Za-z0-9+/=]+"$/);
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const fetched = await h.get(`/orders/${id}`);
    expect(fetched.headers.get('ETag')).toBe(etag);
  });

  it('428 when If-Match is missing', async () => {
    const created = await h.post('/orders', orderBody('ETAG-2'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const res = await h.put(`/orders/${id}`, { description: 'no precondition' });
    expect(res.status).toBe(428);
    expect(await res.text()).toBe('');
  });

  it('412 when If-Match is stale', async () => {
    const created = await h.post('/orders', orderBody('ETAG-3'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const res = await h.put(`/orders/${id}`, { description: 'stale' }, { 'If-Match': '"AAAAAAAAAAA="' });
    expect(res.status).toBe(412);
    expect(await res.text()).toBe('');
  });

  it('200 with a fresh ETag when If-Match matches, and the old ETag then goes stale', async () => {
    const created = await h.post('/orders', orderBody('ETAG-4'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const first = created.headers.get('ETag') as string;

    const ok = await h.put(`/orders/${id}`, { description: 'updated' }, { 'If-Match': first });
    expect(ok.status).toBe(200);
    const second = ok.headers.get('ETag') as string;
    expect(second).not.toBe(first);
    expect(((await ok.json()) as { description: string }).description).toBe('updated');

    const replay = await h.put(`/orders/${id}`, { description: 'again' }, { 'If-Match': first });
    expect(replay.status).toBe(412);
  });

  it('accepts If-Match: * and a comma-separated list containing the current tag', async () => {
    const created = await h.post('/orders', orderBody('ETAG-5'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const etag = created.headers.get('ETag') as string;
    expect((await h.put(`/orders/${id}`, { description: 'a' }, { 'If-Match': '*' })).status).toBe(200);
    const current = await h.etagOf(`/orders/${id}`);
    expect((await h.put(`/orders/${id}`, { description: 'b' }, { 'If-Match': `"zzz", ${current}` })).status).toBe(200);
    expect(etag).not.toBe(current);
  });

  it('403 OperationException when the order is no longer Open', async () => {
    // Seeded order 41001 is closed (confirmed/shipped).
    const etag = await h.etagOf('/orders/41001');
    const res = await h.put('/orders/41001', { description: 'nope' }, { 'If-Match': etag });
    expect(res.status).toBe(403);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.OperationException, WMS.V2.Generic.Models',
      ErrorCode: 'OrderConfirmed',
    });
  });
});

describe('ETag / If-Match on the order operators', () => {
  it('canceler requires If-Match and a reason, then 204s', async () => {
    const created = await h.post('/orders', orderBody('CANCEL-1'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    const etag = created.headers.get('ETag') as string;

    expect((await h.post(`/orders/${id}/canceler`, { reason: 'x' })).status).toBe(428);
    expect((await h.post(`/orders/${id}/canceler`, { reason: 'x' }, { 'If-Match': '"AAAAAAAAAAA="' })).status).toBe(412);

    const noReason = await h.post(`/orders/${id}/canceler`, {}, { 'If-Match': etag });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()) as Record<string, unknown>).toMatchObject({ ErrorCode: 'Required', Properties: [{ Name: 'Reason' }] });

    const ok = await h.post(`/orders/${id}/canceler`, { reason: 'customer changed their mind' }, { 'If-Match': etag });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');

    const after = await h.getJson<{ readOnly: { status: number } }>(`/orders/${id}`);
    expect(after.readOnly.status).toBe(2);
  });

  it('completer requires If-Match and 204s once', async () => {
    const created = await h.post('/orders', orderBody('COMPLETE-1'));
    const id = ((await created.json()) as { readOnly: { orderId: number } }).readOnly.orderId;
    expect((await h.post(`/orders/${id}/completer`, {})).status).toBe(428);
    const etag = await h.etagOf(`/orders/${id}`);
    expect((await h.post(`/orders/${id}/completer`, {}, { 'If-Match': etag })).status).toBe(204);
    const again = await h.post(`/orders/${id}/completer`, {}, { 'If-Match': await h.etagOf(`/orders/${id}`) });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { ErrorCode: string }).ErrorCode).toBe('AlreadyCompleted');
  });
});

describe('ETag / If-Match on receivers', () => {
  it('PUT and the operators all demand If-Match', async () => {
    const created = await h.post('/inventory/receivers', receiverBody('RCV-ETAG-1'));
    expect(created.status).toBe(201);
    const etag = created.headers.get('ETag') as string;
    const id = ((await created.json()) as { readOnly: { receiverId: number } }).readOnly.receiverId;

    expect((await h.put(`/inventory/receivers/${id}`, { notes: 'x' })).status).toBe(428);
    expect((await h.put(`/inventory/receivers/${id}`, { notes: 'x' }, { 'If-Match': '"AAAAAAAAAAA="' })).status).toBe(412);
    const ok = await h.put(`/inventory/receivers/${id}`, { notes: 'updated' }, { 'If-Match': etag });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ETag')).not.toBe(etag);

    expect((await h.post(`/inventory/receivers/${id}/confirmer`, {})).status).toBe(428);
    expect((await h.post(`/inventory/receivers/${id}/canceler`, { reason: 'x' })).status).toBe(428);
  });
});

describe('ETag on read-only resources', () => {
  it('single customer and single item carry ETags', async () => {
    expect((await h.get('/customers/1')).headers.get('ETag')).toBeTruthy();
    expect((await h.get('/customers/1/items/1001')).headers.get('ETag')).toBeTruthy();
    expect((await h.get('/orders/41001/items')).headers.get('ETag')).toBeTruthy();
  });
});
