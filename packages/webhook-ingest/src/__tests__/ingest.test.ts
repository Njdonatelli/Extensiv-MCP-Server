import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryEventStore, silentLogger } from '@mcp-3pl/core';
import { createIngestApp } from '../app.js';
import { loadIngestConfig } from '../config.js';
import { parseWebhook, toIsoUtc } from '../parse.js';
import { PinnedKeySource, RemoteKeySource } from '../signature.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function sign(body: string, key = privateKey): string {
  const s = createSign('SHA256');
  s.update(body);
  s.end();
  return s.sign(key).toString('base64');
}

const sample = {
  tplId: 2,
  wmsEventId: 2070354,
  dateTime: '2022-01-07T19:54:15.4770000',
  eventDateTimeUtc: '2025-01-07T19:54:15.4770000',
  warehouseTransactionEventId: 1,
  createDateTimeUtc: '2025-01-07T19:54:18.4770000',
  eventType: 'OrderConfirm',
  resource: { rel: 'orders/order', href: '/orders/206568?detail=OrderItems', body: JSON.stringify({ referenceNum: 'ACME-SO-10007' }) },
  links: JSON.stringify({ 'uiproperties/user': { LastModifiedBy: '/uiproperties/users/-1' }, 'customers/customer': '/customers/143', 'properties/facility': '/properties/facilities/10' }),
  data: JSON.stringify({ OrderId: '206568' }),
  tags: 'Shipped',
};

describe('parseWebhook', () => {
  it('extracts ids, customer, facility, reference and normalises the timestamp', () => {
    const raw = Buffer.from(JSON.stringify(sample));
    const ev = parseWebhook(raw, sample, '2026-09-16T00:00:00.000Z', true);
    expect(ev.id).toBe('2:2070354');
    expect(ev.occurredAt).toBe('2025-01-07T19:54:15.477Z');
    expect(ev.resourceType).toBe('order');
    expect(ev.resourceId).toBe('206568');
    expect(ev.customerId).toBe('143');
    expect(ev.facilityId).toBe('10');
    expect(ev.referenceNum).toBe('ACME-SO-10007');
    expect(ev.summary).toContain('OrderConfirm');
    expect(toIsoUtc('2025-01-07T19:54:15Z', 'x')).toBe('2025-01-07T19:54:15.000Z');
  });
});

describe('ingest app', () => {
  const config = loadIngestConfig({ EXTENSIV_WEBHOOK_PORT: '1', EXTENSIV_BASE_URL: 'http://mock' });

  it('stores a validly signed delivery once and flags the duplicate', async () => {
    const store = new MemoryEventStore();
    const { app, stats } = createIngestApp({ config, store, keySource: new PinnedKeySource(pem), logger: silentLogger });
    const body = JSON.stringify(sample);
    const post = () => app.request(config.path, { method: 'POST', headers: { 'content-type': 'application/json', Signature: sign(body) }, body });
    const r1 = await post();
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, duplicate: false });
    const r2 = await post();
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(stats).toMatchObject({ received: 2, stored: 1, duplicates: 1 });
    expect((await store.query())[0]?.verified).toBe(true);
  });

  it('rejects a bad or missing signature with 401 and stores nothing', async () => {
    const store = new MemoryEventStore();
    const { app } = createIngestApp({ config, store, keySource: new PinnedKeySource(pem), logger: silentLogger });
    const body = JSON.stringify(sample);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const bad = await app.request(config.path, { method: 'POST', headers: { Signature: sign(body, other) }, body });
    expect(bad.status).toBe(401);
    const missing = await app.request(config.path, { method: 'POST', body });
    expect(missing.status).toBe(401);
    expect(await store.count()).toBe(0);
  });

  it('re-fetches the key once on failure (rotation) using the remote key endpoint', async () => {
    const store = new MemoryEventStore();
    const newPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let served = pem;
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ publicKey: served, retrievalDateISO: new Date().toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const keySource = new RemoteKeySource('http://mock', 60_000, silentLogger, fetchImpl);
    const { app } = createIngestApp({ config, store, keySource, logger: silentLogger });
    const body = JSON.stringify(sample);
    expect((await app.request(config.path, { method: 'POST', headers: { Signature: sign(body) }, body })).status).toBe(200);
    served = newPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const rotated = await app.request(config.path, { method: 'POST', headers: { Signature: sign(JSON.stringify({ ...sample, wmsEventId: 2 }), newPair.privateKey) }, body: JSON.stringify({ ...sample, wmsEventId: 2 }) });
    expect(rotated.status).toBe(200);
    expect(fetches).toBe(2);
  });

  it('enforces the optional ingress token', async () => {
    const cfg = loadIngestConfig({ EXTENSIV_WEBHOOK_INGRESS_TOKEN: 'sekret', EXTENSIV_BASE_URL: 'http://mock' });
    const { app } = createIngestApp({ config: cfg, store: new MemoryEventStore(), keySource: new PinnedKeySource(pem), logger: silentLogger });
    const body = JSON.stringify(sample);
    expect((await app.request(cfg.path, { method: 'POST', headers: { Signature: sign(body) }, body })).status).toBe(401);
    expect((await app.request(cfg.path, { method: 'POST', headers: { Signature: sign(body), Authorization: 'Bearer sekret' }, body })).status).toBe(200);
  });
});
