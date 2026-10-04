// Must run before any Date is built: the host zone is what this file tests. vitest forks one
// process per file (pool: 'forks'), so the override does not leak into other suites.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { parseDate, parseWireMs, wireDate } from '../util.js';
import { harness } from './helpers.js';

describe('zoneless wire dates on a host west of UTC', () => {
  it('runs with a non-UTC local zone', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480);
  });

  it('parseDate reads what wireDate wrote as the same instant', () => {
    const d = new Date('2026-10-03T22:09:13.000Z');
    expect(wireDate(d)).toBe('2026-10-03T22:09:13');
    expect(parseDate(wireDate(d))?.getTime()).toBe(d.getTime());
  });

  it('honours an explicit zone or offset and leaves date-only values at UTC midnight', () => {
    const utc = Date.parse('2026-10-03T22:09:13Z');
    expect(parseWireMs('2026-10-03T22:09:13Z')).toBe(utc);
    expect(parseWireMs('2026-10-03T15:09:13-07:00')).toBe(utc);
    expect(parseWireMs('2026-10-03T15:09:13.4770000')).toBe(Date.parse('2026-10-03T15:09:13.477Z'));
    expect(parseWireMs('2026-10-03')).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(parseDate('not a date')).toBeNull();
  });

  it('seeds without DateInFuture (a same-day shipment is confirmed one hour ago)', async () => {
    await expect(harness()).resolves.toBeDefined();
  });

  it('accepts a zoneless confirmDate one hour in the past and rejects one an hour ahead', async () => {
    const h = await harness();
    const open = [...h.state.orders.values()].filter((r) => !r.order.readOnly.isClosed && r.order.readOnly.fullyAllocated && r.order.readOnly.onHoldDate === null);
    expect(open.length).toBeGreaterThan(0);
    const rec = open[0]!;
    const ahead = wireDate(new Date(Date.now() + 3_600_000));
    expect(() => h.state.confirmOrder(rec, { confirmDate: ahead })).toThrow(expect.objectContaining({ body: expect.objectContaining({ ErrorCode: 'DateInFuture' }) }));
    const past = wireDate(new Date(Date.now() - 3_600_000));
    h.state.confirmOrder(rec, { confirmDate: past });
    expect(rec.order.readOnly.shipDate).toBe(past);
  });

  it('compares a zoneless row date against a Z-qualified rql value as UTC', async () => {
    const h = await harness();
    const all = [...h.state.orders.values()].map((r) => r.order.readOnly.creationDate);
    const pivot = [...all].sort()[Math.floor(all.length / 2)]!;
    const expected = all.filter((c) => c <= pivot).length;
    const body = await h.getJson<{ totalResults: number }>('/orders?pgsiz=1&rql=' + encodeURIComponent(`readonly.creationdate=le=${pivot}Z`));
    expect(body.totalResults).toBe(expected);
  });
});
