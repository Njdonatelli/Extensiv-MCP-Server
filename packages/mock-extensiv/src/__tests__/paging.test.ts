import { beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMER_REL, embedded, harness, ITEM_REL, ORDER_REL, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

interface Collection {
  totalResults: number;
  _links: Record<string, { href: string }>;
}

describe('page-size defaults per rel', () => {
  it('/customers defaults to 20 (limit 100)', async () => {
    const body = await h.getJson<Collection>('/customers');
    expect(body.totalResults).toBe(4);
    expect(embedded(body as unknown as Record<string, unknown>, CUSTOMER_REL)).toHaveLength(4);
  });

  it('/customers/{id}/items defaults to 10 (limit 100)', async () => {
    const body = await h.getJson<Collection>('/customers/1/items');
    expect(body.totalResults).toBe(20);
    expect(embedded(body as unknown as Record<string, unknown>, ITEM_REL)).toHaveLength(10);
  });

  it('/orders defaults to 100 (limit 1000)', async () => {
    const body = await h.getJson<Collection>('/orders');
    expect(body.totalResults).toBe(42);
    expect(embedded(body as unknown as Record<string, unknown>, ORDER_REL)).toHaveLength(42);
  });

  it('/inventory/stocksummaries defaults to 100 (limit 500) and carries no _embedded', async () => {
    const body = await h.getJson<{ totalResults: number; summaries: unknown[]; _embedded?: unknown }>('/inventory/stocksummaries');
    expect(body.totalResults).toBe(36);
    expect(body.summaries).toHaveLength(36);
    expect(body._embedded).toBeUndefined();
  });
});

describe('page-size limits', () => {
  const cases: [string, number][] = [
    ['/customers?pgsiz=101', 101],
    ['/customers/1/items?pgsiz=101', 101],
    ['/orders?pgsiz=1001', 1001],
    ['/inventory?pgsiz=1001', 1001],
    ['/inventory/stocksummaries?pgsiz=501', 501],
    ['/inventory/stockdetails?customerid=1&facilityid=1&pgsiz=501', 501],
    ['/inventory/receivers?pgsiz=501', 501],
    ['/orders/shipmentstrackinginfo?pgsiz=4001', 4001],
  ];

  it.each(cases)('%s is rejected with 400 QueryParameterException', async (path) => {
    const res = await h.get(path);
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.QueryParameterException, WMS.V2.Generic.Models',
      Parameters: ['pgsiz'],
      ErrorCode: 'NotParsable',
    });
  });

  it('accepts a page size at the documented maximum', async () => {
    expect((await h.get('/customers?pgsiz=100')).status).toBe(200);
    expect((await h.get('/orders?pgsiz=1000')).status).toBe(200);
    expect((await h.get('/orders/shipmentstrackinginfo?pgsiz=4000')).status).toBe(200);
  });

  it('rejects a non-positive pgsiz or pgnum', async () => {
    expect((await h.get('/orders?pgsiz=0')).status).toBe(400);
    expect((await h.get('/orders?pgsiz=-1')).status).toBe(400);
    expect((await h.get('/orders?pgsiz=abc')).status).toBe(400);
    const res = await h.get('/orders?pgnum=0');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ Parameters: ['pgnum'] });
  });
});

describe('next / prev links', () => {
  it('omits prev on the first page and next on the last', async () => {
    const first = await h.getJson<Collection>('/orders?pgsiz=10&pgnum=1');
    expect(first._links.self?.href).toContain('pgnum=1');
    expect(first._links.next?.href).toContain('pgnum=2');
    expect(first._links.prev).toBeUndefined();

    const middle = await h.getJson<Collection>('/orders?pgsiz=10&pgnum=2');
    expect(middle._links.next?.href).toContain('pgnum=3');
    expect(middle._links.prev?.href).toContain('pgnum=1');

    const last = await h.getJson<Collection>('/orders?pgsiz=10&pgnum=5');
    expect(last._links.next).toBeUndefined();
    expect(last._links.prev?.href).toContain('pgnum=4');
    expect(embedded(last as unknown as Record<string, unknown>, ORDER_REL)).toHaveLength(2);
  });

  it('keeps other query parameters on the paging links', async () => {
    const body = await h.getJson<Collection>('/orders?pgsiz=10&pgnum=1&detail=OrderItems');
    expect(body._links.next?.href).toContain('detail=OrderItems');
  });

  it('pages past the end without error', async () => {
    const body = await h.getJson<Collection>('/orders?pgsiz=10&pgnum=99');
    expect(body.totalResults).toBe(42);
    expect(embedded(body as unknown as Record<string, unknown>, ORDER_REL)).toHaveLength(0);
  });
});
