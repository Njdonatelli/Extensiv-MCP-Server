import { beforeAll, describe, expect, it } from 'vitest';
import { embedded, harness, ORDER_REL, RECEIVER_REL, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

describe('HAL envelopes and rel names', () => {
  it('serves application/hal+json with totalResults, _embedded and _links', async () => {
    const res = await h.get('/orders?pgsiz=1');
    expect(res.headers.get('Content-Type')).toBe('application/hal+json; charset=utf-8');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['totalResults', '_embedded', '_links']));
    expect(Object.keys(body._embedded as object)).toEqual([ORDER_REL]);
  });

  it('uses the literal http://api.3plCentral.com rel keys', async () => {
    const pairs: [string, string][] = [
      ['/customers?pgsiz=1', 'http://api.3plCentral.com/rels/customers/customer'],
      ['/customers/1/items?pgsiz=1', 'http://api.3plCentral.com/rels/customers/item'],
      ['/properties/facilities?pgsiz=1', 'http://api.3plCentral.com/rels/properties/facility'],
      ['/properties/facilities/1/locations?pgsiz=1', 'http://api.3plCentral.com/rels/properties/location'],
      ['/orders?pgsiz=1', 'http://api.3plCentral.com/rels/orders/order'],
      ['/orders/shipmentstrackinginfo?pgsiz=1', 'http://api.3plCentral.com/rels/orders/orderparceltrackpackageinfo'],
      ['/inventory/receivers?pgsiz=1', 'http://api.3plCentral.com/rels/inventory/receiver'],
    ];
    for (const [path, rel] of pairs) {
      const body = await h.getJson(path);
      expect(Object.keys(body._embedded as object), path).toContain(rel);
    }
  });

  it('uses the bare "item" key on /inventory, /inventory/stockdetails and /orders/summaries', async () => {
    for (const path of ['/inventory?pgsiz=1', '/inventory/stockdetails?customerid=1&facilityid=1&pgsiz=1', '/orders/summaries?pgsiz=1']) {
      const body = await h.getJson(path);
      expect(Object.keys(body._embedded as object), path).toEqual(['item']);
    }
  });

  it('serves the billboard entry point with rel links only', async () => {
    const body = await h.getJson<{ _links: Record<string, { href: string }> }>('/billboard');
    expect(body._links.self?.href).toBe('/billboard');
    expect(body._links['http://api.3plCentral.com/rels/orders/orders']?.href).toBe('/orders');
  });
});

describe('order detail / itemdetail', () => {
  it('omits order items unless detail asks for them', async () => {
    const plain = await h.getJson('/orders/41001');
    expect(plain._embedded).toBeUndefined();
    const withItems = await h.getJson('/orders/41001?detail=OrderItems');
    expect(embedded(withItems, 'http://api.3plCentral.com/rels/orders/item').length).toBeGreaterThan(0);
  });

  it('includes packages for detail=Packages and both for detail=All', async () => {
    const pkgs = await h.getJson('/orders/41001?detail=Packages');
    expect(embedded(pkgs, 'http://api.3plCentral.com/rels/orders/package')).toHaveLength(1);
    const all = await h.getJson('/orders/41001?detail=All');
    expect(Object.keys(all._embedded as object)).toEqual([
      'http://api.3plCentral.com/rels/orders/item',
      'http://api.3plCentral.com/rels/orders/package',
    ]);
  });

  it('nulls allocations unless itemdetail asks, and fills detail only for AllocationsWithDetail', async () => {
    type Line = { readOnly: { allocations: { receiveItemId: number; qty: number; detail: unknown }[] | null } };
    const none = embedded<Line>(await h.getJson('/orders/41029?detail=OrderItems'), 'http://api.3plCentral.com/rels/orders/item');
    expect(none[0]?.readOnly.allocations).toBeNull();

    const allocs = embedded<Line>(
      await h.getJson('/orders/41029?detail=OrderItems&itemdetail=Allocations'),
      'http://api.3plCentral.com/rels/orders/item',
    );
    expect(Array.isArray(allocs[0]?.readOnly.allocations)).toBe(true);

    const detailed = embedded<Line>(
      await h.getJson('/orders/41001?detail=OrderItems&itemdetail=AllocationsWithDetail'),
      'http://api.3plCentral.com/rels/orders/item',
    );
    const first = detailed[0]?.readOnly.allocations?.[0];
    expect(first?.detail).toBeTruthy();
  });

  it('rejects an unknown detail value with 400', async () => {
    const res = await h.get('/orders?detail=Everything');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ Parameters: ['detail'], ErrorCode: 'NotParsable' });
  });

  it('exposes state-conditional operator links', async () => {
    const open = await h.getJson<{ _links: Record<string, unknown> }>('/orders/41029');
    expect(open._links['http://api.3plCentral.com/rels/orders/ordercancel']).toBeTruthy();
    // 41029 is short, so confirm is not offered but allocate is.
    expect(open._links['http://api.3plCentral.com/rels/orders/orderconfirm']).toBeUndefined();
    expect(open._links['http://api.3plCentral.com/rels/orders/orderallocate']).toBeTruthy();

    const closed = await h.getJson<{ _links: Record<string, unknown> }>('/orders/41001');
    expect(closed._links['http://api.3plCentral.com/rels/orders/ordercancel']).toBeUndefined();
    expect(closed._links['http://api.3plCentral.com/rels/orders/orderunconfirm']).toBeTruthy();
  });
});

describe('inventory reads', () => {
  it('requires customerid and facilityid on /inventory/stockdetails', async () => {
    const none = await h.get('/inventory/stockdetails');
    expect(none.status).toBe(400);
    expect((await none.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.QueryParameterException, WMS.V2.Generic.Models',
      Parameters: ['customerid', 'facilityid'],
      ErrorCode: 'Required',
    });

    const onlyCustomer = await h.get('/inventory/stockdetails?customerid=1');
    expect(onlyCustomer.status).toBe(400);
    expect(((await onlyCustomer.json()) as { Parameters: string[] }).Parameters).toEqual(['facilityid']);

    expect((await h.get('/inventory/stockdetails?customerid=1&facilityid=1')).status).toBe(200);
  });

  it('strips customerIdentifier from stock summary rows but still filters on it', async () => {
    const all = await h.getJson<{ totalResults: number; summaries: Record<string, unknown>[] }>('/inventory/stocksummaries?pgsiz=500');
    expect(all.summaries[0]).not.toHaveProperty('customerIdentifier');
    const scoped = await h.getJson<{ totalResults: number }>(
      '/inventory/stocksummaries?pgsiz=500&rql=' + encodeURIComponent('customeridentifier.id==2'),
    );
    expect(scoped.totalResults).toBeGreaterThan(0);
    expect(scoped.totalResults).toBeLessThan(all.totalResults);
  });

  it('rejects sort on /inventory/stocksummaries by ignoring it (no sort parameter is documented)', async () => {
    // The rel documents no `sort`; the mock does not implement one, so ordering is insertion order.
    const res = await h.get('/inventory/stocksummaries?sort=onHand');
    expect(res.status).toBe(200);
  });

  it('filters receivers by receivertype', async () => {
    expect((await h.getJson<{ totalResults: number }>('/inventory/receivers')).totalResults).toBe(9);
    expect((await h.getJson<{ totalResults: number }>('/inventory/receivers?receivertype=3')).totalResults).toBe(5);
    expect((await h.getJson<{ totalResults: number }>('/inventory/receivers?receivertype=4')).totalResults).toBe(4);
    const bad = await h.get('/inventory/receivers?receivertype=9');
    expect(bad.status).toBe(400);
  });

  it('embeds receive items only for detail=ReceiveItems or All', async () => {
    const plain = embedded(await h.getJson('/inventory/receivers?pgsiz=1'), RECEIVER_REL)[0] as Record<string, unknown>;
    expect(plain._embedded).toBeUndefined();
    const withItems = embedded(await h.getJson('/inventory/receivers?pgsiz=1&detail=ReceiveItems'), RECEIVER_REL)[0] as Record<string, unknown>;
    expect(Object.keys(withItems._embedded as object)).toEqual(['http://api.3plCentral.com/rels/inventory/receiveritem']);
  });
});

describe('properties', () => {
  it('returns carriers with defaults and an embedded carrier list', async () => {
    const body = await h.getJson<{ defaultBillingCodes: unknown[]; defaultShipmentServices: unknown[] }>('/properties/carriers');
    expect(body.defaultBillingCodes.length).toBeGreaterThan(0);
    expect(body.defaultShipmentServices.length).toBeGreaterThan(0);
    expect(embedded(body as unknown as Record<string, unknown>, 'http://api.3plCentral.com/rels/properties/carrier')).toHaveLength(4);
  });

  it('scopes customers by facilityId and facilities by customerId', async () => {
    expect((await h.getJson<{ totalResults: number }>('/customers?facilityId=2')).totalResults).toBe(2);
    expect((await h.getJson<{ totalResults: number }>('/properties/facilities?customerId=2')).totalResults).toBe(1);
  });

  it('marks read-only collections cacheable', async () => {
    expect((await h.get('/customers')).headers.get('Cache-Control')).toBeTruthy();
    expect((await h.get('/properties/facilities')).headers.get('Cache-Control')).toBeTruthy();
  });
});

describe('webhook signing key', () => {
  it('returns a PEM public key and a stable retrieval date', async () => {
    const body = await h.getJson<{ publicKey: string; retrievalDateISO: string }>('/events/webhook/key');
    expect(body.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(Number.isNaN(Date.parse(body.retrievalDateISO))).toBe(false);
    const again = await h.getJson<{ retrievalDateISO: string }>('/events/webhook/key');
    expect(again.retrievalDateISO).toBe(body.retrievalDateISO);
  });

  it('304s when previousRetrievalDateISO matches', async () => {
    const body = await h.getJson<{ retrievalDateISO: string }>('/events/webhook/key');
    const res = await h.get(`/events/webhook/key?previousRetrievalDateISO=${encodeURIComponent(body.retrievalDateISO)}`);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    const stale = await h.get('/events/webhook/key?previousRetrievalDateISO=2000-01-01T00:00:00.000Z');
    expect(stale.status).toBe(200);
  });
});

describe('404s', () => {
  it.each([
    '/orders/999999',
    '/customers/999999',
    '/customers/1/items/999999',
    '/inventory/receivers/999999',
    '/properties/facilities/999999',
    '/properties/facilities/999999/locations',
  ])('%s is a 404 with an empty body', async (path) => {
    const res = await h.get(path);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('404s an unknown path', async () => {
    expect((await h.get('/nope')).status).toBe(404);
  });
});

describe('order sub-resources', () => {
  it('lists items and packages with an ETag', async () => {
    const items = await h.get('/orders/41001/items');
    expect(items.status).toBe(200);
    expect(items.headers.get('ETag')).toBeTruthy();
    const body = (await items.json()) as { totalResults: number };
    expect(body.totalResults).toBe(2);

    const packages = await h.getJson<{ totalResults: number; _embedded: Record<string, unknown[]> }>('/orders/41001/packages');
    expect(packages.totalResults).toBe(1);
    const pkg = packages._embedded['http://api.3plCentral.com/rels/orders/package']?.[0] as Record<string, unknown>;
    expect(Object.keys(pkg._embedded as object)).toEqual(['http://api.3plCentral.com/rels/orders/packagecontent']);
  });

  it('exposes order summaries and shipment tracking rows', async () => {
    const summaries = await h.getJson<{ totalResults: number; _embedded: { item: Record<string, unknown>[] } }>('/orders/summaries?pgsiz=1');
    expect(summaries.totalResults).toBe(42);
    expect(Object.keys(summaries._embedded.item[0] as object)).toEqual([
      'orderId',
      'referenceNum',
      'poNum',
      'fullyAllocated',
      'customerIdentifier',
      'facilityIdentifier',
      'creationDate',
      'isClosed',
    ]);

    const tracking = await h.getJson<{ totalResults: number }>('/orders/shipmentstrackinginfo?pgsiz=1');
    expect(tracking.totalResults).toBe(24);
  });
});

describe('the seeded world matches what MOCK_FIDELITY.md claims', () => {
  // The fidelity table is a deliverable: a reader re-verifying the real API against it must
  // be able to trust its counts. A drifting seed should fail here, not mislead them.
  it('has 9 receivers: 5 closed, 3 open, 1 cancelled', async () => {
    const res = await h.get('/inventory/receivers?pgsiz=100');
    const body = (await res.json()) as Record<string, unknown>;
    const rows = embedded<{ readOnly: { status: number } }>(body, RECEIVER_REL);
    expect(body.totalResults).toBe(9);
    const count = (status: number): number => rows.filter((r) => r.readOnly.status === status).length;
    expect({ open: count(0), closed: count(1), cancelled: count(2) }).toEqual({ open: 3, closed: 5, cancelled: 1 });
  });

  it('has 4 customers and 2 facilities', async () => {
    const customers = (await (await h.get('/customers?pgsiz=100')).json()) as { totalResults: number };
    const facilities = (await (await h.get('/properties/facilities?pgsiz=100')).json()) as { totalResults: number };
    expect(customers.totalResults).toBe(4);
    expect(facilities.totalResults).toBe(2);
  });
});
