import { beforeEach, describe, expect, it } from 'vitest';
import { createMockApp } from '../index.js';
import { harness, orderBody, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('POST /__mock/faults once', () => {
  it('returns a 429 with Retry-After exactly once', async () => {
    await h.control('/__mock/faults', 'POST', {
      once: [{ match: 'GET /orders', status: 429, retryAfterSeconds: 7, body: { error: 'too many requests' } }],
    });

    const throttled = await h.get('/orders?pgsiz=1');
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('7');
    expect((await throttled.json()) as Record<string, unknown>).toEqual({ error: 'too many requests' });

    // "once" means once: the next call goes through.
    expect((await h.get('/orders?pgsiz=1')).status).toBe(200);
  });

  it('matches on method and path prefix only', async () => {
    await h.control('/__mock/faults', 'POST', { once: [{ match: 'POST /orders', status: 503 }] });
    expect((await h.get('/orders?pgsiz=1')).status).toBe(200);
    expect((await h.post('/orders', orderBody('FAULT-MISS'))).status).toBe(503);
  });

  it('supports a wildcard method and a plain-text body', async () => {
    await h.control('/__mock/faults', 'POST', { once: [{ match: '* /customers', status: 500, body: 'boom' }] });
    const res = await h.get('/customers');
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe('boom');
  });

  it('never intercepts the control plane', async () => {
    await h.control('/__mock/faults', 'POST', { once: [{ match: '* /', status: 500 }] });
    expect((await h.control('/__mock/state', 'GET')).status).toBe(200);
  });

  it('applies latencyMs and can be cleared', async () => {
    await h.control('/__mock/faults', 'POST', { latencyMs: 60 });
    const started = Date.now();
    expect((await h.get('/customers')).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    await h.control('/__mock/faults', 'POST', { clear: true });
    const dump = (await (await h.control('/__mock/state', 'GET')).json()) as { faults: { latencyMs: number; once: unknown[] } };
    expect(dump.faults.latencyMs).toBe(0);
    expect(dump.faults.once).toEqual([]);
  });
});

describe('dropConnection', () => {
  it('applies the write and then abandons the response', async () => {
    await h.control('/__mock/faults', 'POST', { once: [{ match: 'POST /orders', status: 0, dropConnection: true }] });
    const res = await h.post('/orders', orderBody('DROPPED-IN-PROCESS'));
    // app.request() has no socket to destroy, so the mock signals the drop with a sentinel status
    // (599) plus X-Mock-Connection-Dropped. Real clients see a closed socket instead — see server.test.ts.
    expect(res.status).toBe(599);
    expect(res.headers.get('X-Mock-Connection-Dropped')).toBe('1');
    expect(await res.text()).toBe('');

    // The effect landed even though the caller learned nothing.
    const found = await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('referencenum==DROPPED-IN-PROCESS'));
    expect(found.totalResults).toBe(1);
  });

  it('records the drop in the request log', async () => {
    await h.control('/__mock/faults', 'POST', { once: [{ match: 'POST /orders', status: 0, dropConnection: true }] });
    await h.post('/orders', orderBody('DROPPED-LOGGED'));
    const log = (await (await h.control('/__mock/requests', 'GET')).json()) as {
      requests: { method: string; path: string; dropped?: boolean }[];
    };
    const entry = log.requests.find((r) => r.method === 'POST' && r.path === '/orders');
    expect(entry?.dropped).toBe(true);
  });
});

describe('request log', () => {
  it('redacts Authorization and records status, query and body', async () => {
    await h.get('/orders?pgsiz=2&detail=OrderItems');
    await h.post('/orders', orderBody('LOG-1'));
    const log = (await (await h.control('/__mock/requests', 'GET')).json()) as {
      totalResults: number;
      requests: { seq: number; method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; status: number; at: string }[];
    };

    const get = log.requests.find((r) => r.method === 'GET' && r.path === '/orders');
    expect(get?.query).toEqual({ pgsiz: '2', detail: 'OrderItems' });
    expect(get?.status).toBe(200);
    expect(get?.headers.authorization).toBe('Bearer <redacted>');
    expect(Number.isNaN(Date.parse(get?.at ?? ''))).toBe(false);

    const post = log.requests.find((r) => r.method === 'POST' && r.path === '/orders');
    expect(post?.status).toBe(201);
    expect((post?.body as { referenceNum: string }).referenceNum).toBe('LOG-1');

    // The token request's Basic header is redacted too.
    const token = log.requests.find((r) => r.path === '/AuthServer/api/Token');
    expect(token?.headers.authorization).toBe('Basic <redacted>');

    // Sequence numbers increase monotonically.
    const seqs = log.requests.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('records error statuses', async () => {
    await h.get('/orders/999999');
    const log = (await (await h.control('/__mock/requests', 'GET')).json()) as { requests: { path: string; status: number }[] };
    expect(log.requests.find((r) => r.path === '/orders/999999')?.status).toBe(404);
  });

  it('DELETE /__mock/requests clears it', async () => {
    await h.get('/customers');
    expect((await h.control('/__mock/requests', 'DELETE')).status).toBe(204);
    const log = (await (await h.control('/__mock/requests', 'GET')).json()) as { totalResults: number };
    expect(log.totalResults).toBe(1); // the GET that just read the log
  });
});

describe('control plane', () => {
  it('POST /__mock/reset rebuilds the seeded world', async () => {
    await h.post('/orders', orderBody('RESET-1'));
    expect((await h.getJson<{ totalResults: number }>('/orders')).totalResults).toBe(43);
    const reset = await h.control('/__mock/reset', 'POST', {});
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { orders: number }).orders).toBe(42);
    // Re-seeding clears tokens too, so the old bearer is dead.
    expect((await h.get('/orders')).status).toBe(401);
  });

  it('POST /__mock/reset with seed=empty empties the world', async () => {
    const reset = await h.control('/__mock/reset', 'POST', { seed: 'empty' });
    expect(((await reset.json()) as { orders: number; lots: number }).orders).toBe(0);
    const dump = (await (await h.control('/__mock/state', 'GET')).json()) as { customers: unknown[]; orders: unknown[] };
    expect(dump.customers).toEqual([]);
    expect(dump.orders).toEqual([]);
  });

  it('GET /__mock/state dumps counters, orders and lots', async () => {
    const dump = (await (await h.control('/__mock/state', 'GET')).json()) as {
      counters: Record<string, number>;
      orders: { orderId: number; etag: string }[];
      lots: unknown[];
    };
    expect(dump.orders).toHaveLength(42);
    expect(dump.orders[0]?.orderId).toBe(41001);
    expect(dump.orders[0]?.etag).toMatch(/^"/);
    expect(dump.lots).toHaveLength(38);
    expect(dump.counters.orderId).toBe(41042);
  });

  it('POST /__mock/stock rejects an unknown sku and an over-draw', async () => {
    const unknown = await h.control('/__mock/stock', 'POST', { customerId: 1, facilityId: 1, sku: 'NOPE', onHandDelta: 1 });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { ErrorCode: string }).ErrorCode).toBe('DoesNotExist');

    const overdraw = await h.control('/__mock/stock', 'POST', { customerId: 1, facilityId: 1, sku: 'ACME-STOVE-01', onHandDelta: -100_000 });
    expect(overdraw.status).toBe(400);
    expect(((await overdraw.json()) as { ErrorCode: string }).ErrorCode).toBe('ValueNotSupported');
  });

  it('POST /__mock/webhooks/emit forces a delivery attempt', async () => {
    const url = 'http://127.0.0.1:1/never';
    await h.control('/__mock/webhooks', 'POST', { url, resource: 'Order', eventTypes: ['OrderUpdate'] });
    const emitted = await h.control('/__mock/webhooks/emit', 'POST', { eventType: 'OrderUpdate', resourceRel: 'orders/order', resourceId: 41001 });
    expect(emitted.status).toBe(200);
    // Two subscriptions match: the one just added plus the seeded Acme "acme-order-events" one.
    expect(((await emitted.json()) as { emitted: number }).emitted).toBe(2);

    const deliveries = (await (await h.control('/__mock/webhooks/deliveries', 'GET')).json()) as {
      totalResults: number;
      deliveries: { url: string; eventType: string; signature: string; attempts: unknown[]; ok: boolean }[];
    };
    expect(deliveries.totalResults).toBe(2);
    const mine = deliveries.deliveries.find((d) => d.url === url);
    expect(mine?.eventType).toBe('OrderUpdate');
    expect(mine?.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Nothing is listening on port 1, so every attempt failed and the delivery is not ok.
    expect(mine?.ok).toBe(false);
    expect(mine?.attempts).toHaveLength(3);
  });
});

describe('error handler', () => {
  it('turns an unhandled error into a plain-text 500', async () => {
    // A fresh app: Hono freezes its matcher after the first request, so the extra route must be
    // registered before anything is dispatched. The control-plane prefix skips the bearer middleware.
    const { app } = createMockApp();
    app.get('/__mock/boom', () => {
      throw new Error('kaboom');
    });
    const res = await app.request('/__mock/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toContain('kaboom');
  });

  it('answers a malformed JSON body with 400', async () => {
    const res = await h.req('/orders', { method: 'POST', headers: { 'Content-Type': 'application/hal+json' }, body: '{not json' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ErrorCode: string }).ErrorCode).toBe('Required');
  });
});
