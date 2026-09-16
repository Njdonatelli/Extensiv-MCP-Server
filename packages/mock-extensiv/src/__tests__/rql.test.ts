import { beforeAll, describe, expect, it } from 'vitest';
import { embedded, harness, ITEM_REL, ORDER_REL, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

async function itemCount(rql: string): Promise<number> {
  const res = await h.get(`/customers/1/items?rql=${encodeURIComponent(rql)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { totalResults: number }).totalResults;
}

describe('RQL operator matrix (against the 20 seeded Acme items)', () => {
  it('== and != on a string', async () => {
    expect(await itemCount('sku==ACME-TENT-2P')).toBe(1);
    expect(await itemCount('sku!=ACME-TENT-2P')).toBe(19);
  });

  it('is case-insensitive in both property names and values', async () => {
    expect(await itemCount('SKU==acme-tent-2p')).toBe(1);
  });

  it('=gt= =ge= =lt= =le= on a number', async () => {
    expect(await itemCount('cost=gt=100')).toBe(4);
    expect(await itemCount('cost=ge=110')).toBe(4);
    expect(await itemCount('cost=lt=5')).toBe(3);
    expect(await itemCount('cost=le=4')).toBe(2);
  });

  it('=in= and =out=', async () => {
    expect(await itemCount('sku=in=(ACME-TENT-2P,ACME-TENT-4P)')).toBe(2);
    expect(await itemCount('sku=out=(ACME-TENT-2P,ACME-TENT-4P)')).toBe(18);
  });

  it('=hv= true/false', async () => {
    expect(await itemCount('upc=hv=true')).toBe(20);
    expect(await itemCount('harmonizedCode=hv=false')).toBe(20);
    expect(await itemCount('harmonizedCode=hv=true')).toBe(0);
  });

  it('leading, trailing and surrounding wildcards', async () => {
    expect(await itemCount('sku==ACME-TENT*')).toBe(2);
    expect(await itemCount('sku==*TENT-2P')).toBe(1);
    expect(await itemCount('sku==*TENT*')).toBe(2);
    expect(await itemCount('sku!=*TENT*')).toBe(18);
  });

  it('booleans and dotted readOnly paths', async () => {
    expect(await itemCount('readonly.deactivated==true')).toBe(1);
    expect(await itemCount('readonly.deactivated==false')).toBe(19);
  });

  it('gives ";" (and) precedence over "," (or), overridable with parentheses', async () => {
    expect(await itemCount('inventoryCategory==Sleep')).toBe(4);
    expect(await itemCount('inventoryCategory==Shelter')).toBe(3);
    // (Sleep AND cost>100) -> 2
    expect(await itemCount('inventoryCategory==Sleep;cost=gt=100')).toBe(2);
    // (Sleep AND cost>100) OR Shelter -> 2 + 3
    expect(await itemCount('inventoryCategory==Sleep;cost=gt=100,inventoryCategory==Shelter')).toBe(5);
    // Sleep AND (cost>100 OR cost<50) -> 3
    expect(await itemCount('inventoryCategory==Sleep;(cost=gt=100,cost=lt=50)')).toBe(3);
  });

  it('rejects an unsupported property with 400 QueryParameterException NotParsable', async () => {
    const res = await h.get('/orders?rql=gorp==1');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      $type: 'WMS.V2.Generic.Models.Exceptions.QueryParameterException, WMS.V2.Generic.Models',
      Parameters: ['rql'],
      ErrorCode: 'NotParsable',
      Hint: 'Properties not supported: gorp',
    });
  });

  it('rejects unparsable syntax with 400 NotParsable', async () => {
    const res = await h.get('/orders?rql=' + encodeURIComponent('referencenum=='));
    // An empty value is legal with ==; an unterminated group is not.
    expect(res.status).toBe(200);
    const bad = await h.get('/orders?rql=' + encodeURIComponent('(referencenum==A'));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { ErrorCode: string }).ErrorCode).toBe('NotParsable');
  });
});

describe('RQL on orders', () => {
  it('filters on the documented readonly.isclosed path', async () => {
    const open = (await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('readonly.isclosed==false'))).totalResults;
    const closed = (await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('readonly.isclosed==true'))).totalResults;
    expect(open).toBe(18);
    expect(closed).toBe(24);
    expect(open + closed).toBe(42);
  });

  it('accepts customeridentifier.id with and without the readonly. prefix', async () => {
    const bare = (await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('customeridentifier.id==1'))).totalResults;
    const prefixed = (await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('readonly.customeridentifier.id==1')))
      .totalResults;
    expect(bare).toBe(31);
    expect(prefixed).toBe(31);
  });

  it('filters canceled orders on status (the one status value the docs call reliable)', async () => {
    const res = await h.getJson<{ totalResults: number }>('/orders?rql=' + encodeURIComponent('readonly.status==2'));
    expect(res.totalResults).toBe(3);
  });

  it('supports skulist, skucontains and upclist', async () => {
    expect((await h.getJson<{ totalResults: number }>('/orders?skulist=ACME-COOLER-45')).totalResults).toBe(5);
    expect((await h.getJson<{ totalResults: number }>('/orders?skucontains=COOLER')).totalResults).toBe(7);
    expect((await h.getJson<{ totalResults: number }>('/orders?upclist=810001230134')).totalResults).toBe(5);
  });
});

describe('sort', () => {
  it('sorts ascending and descending', async () => {
    const asc = embedded<{ cost: number }>(await h.getJson('/customers/1/items?sort=cost&pgsiz=100'), ITEM_REL).map((i) => i.cost);
    const desc = embedded<{ cost: number }>(await h.getJson('/customers/1/items?sort=-cost&pgsiz=100'), ITEM_REL).map((i) => i.cost);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(desc).toEqual([...asc].reverse());
  });

  it('sorts orders on a dotted path', async () => {
    const rows = embedded<{ readOnly: { orderId: number } }>(await h.getJson('/orders?sort=-readonly.orderid&pgsiz=5'), ORDER_REL);
    expect(rows.map((r) => r.readOnly.orderId)).toEqual([41042, 41041, 41040, 41039, 41038]);
  });

  it('rejects an unknown sort property against the sort parameter', async () => {
    const res = await h.get('/orders?sort=nope');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ Parameters: ['sort'], ErrorCode: 'NotParsable' });
  });
});
