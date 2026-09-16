import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlChangeStore } from '../stores/change_store.js';
import { JsonlEventStore } from '../stores/event_store.js';
import type { ChangeRecord } from '../mutation.js';

function rec(id: string, status: ChangeRecord['status'] = 'prepared'): ChangeRecord {
  return {
    id,
    kind: 'create_order',
    status,
    fingerprint: 'fp-' + id,
    plan: { kind: 'create_order', summary: 's', scope: { customerId: '1' }, input: { customerId: '1', facilityId: '1', referenceNum: id, shipTo: {}, lines: [] }, preview: {}, warnings: [], preconditions: [], upstream: [], risk: 'low', upstreamIdempotent: false },
    target: { system: 't', baseUrl: 'http://x', environmentLabel: 'test' },
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T00:15:00Z',
    commitAttempts: 0,
  };
}

describe('JsonlChangeStore', () => {
  it('persists across instances with last-write-wins', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chg-'));
    const file = path.join(dir, 'changes.jsonl');
    const a = new JsonlChangeStore(file);
    await a.put(rec('chg_a'));
    await a.put({ ...rec('chg_a'), status: 'committed', commitAttempts: 1 });
    await a.put(rec('chg_b'));
    const b = new JsonlChangeStore(file);
    expect((await b.get('chg_a'))?.status).toBe('committed');
    expect((await b.list()).map((r) => r.id)).toEqual(['chg_a', 'chg_b']);
    expect(await b.findByFingerprint('fp-chg_b')).toBeDefined();
  });

  it('sees records appended by another instance of the same file', async () => {
    // Two MCP sessions, or two server processes, share one changes.jsonl. A store that
    // read the file once at startup would answer CHANGE_UNKNOWN for a change the other
    // one prepared.
    const dir = mkdtempSync(path.join(tmpdir(), 'chg-share-'));
    const file = path.join(dir, 'changes.jsonl');
    const a = new JsonlChangeStore(file);
    const b = new JsonlChangeStore(file);
    await a.put(rec('chg_one'));
    expect(await b.get('chg_one')).toBeDefined();
    await b.put(rec('chg_two'));
    expect(await a.get('chg_two')).toBeDefined();
    await a.put({ ...rec('chg_one'), status: 'committed' });
    expect((await b.get('chg_one'))?.status).toBe('committed');
    expect((await b.list()).map((r) => r.id).sort()).toEqual(['chg_one', 'chg_two']);
  });
});

describe('JsonlEventStore', () => {
  it('shares a file between a writer and an independent reader and dedupes ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ev-'));
    const file = path.join(dir, 'events.jsonl');
    const writer = new JsonlEventStore(file);
    const reader = new JsonlEventStore(file);
    const ev = (id: string, t: string) => ({ id, receivedAt: t, occurredAt: t, eventType: 'OrderConfirm', summary: 'x', verified: true, customerId: '1' });
    expect(await writer.append(ev('e1', '2026-09-16T10:00:00Z'))).toEqual({ inserted: true });
    expect(await writer.append(ev('e1', '2026-09-16T10:00:00Z'))).toEqual({ inserted: false });
    expect((await reader.query()).map((e) => e.id)).toEqual(['e1']);
    await writer.append(ev('e2', '2026-09-16T11:00:00Z'));
    expect((await reader.query({ limit: 10 })).map((e) => e.id)).toEqual(['e2', 'e1']);
    expect((await reader.query({ since: '2026-09-16T10:30:00Z' })).map((e) => e.id)).toEqual(['e2']);
    expect(await reader.count()).toBe(2);
  });
});

describe('torn final line', () => {
  it('separates a half-written record instead of gluing the next one onto it', async () => {
    // A SIGKILL mid-append leaves an unterminated line. Appending straight onto it would make
    // BOTH records unparseable, and the webhook sender would have been told 200 already.
    const dir = mkdtempSync(path.join(tmpdir(), 'torn-'));
    const file = path.join(dir, 'events.jsonl');
    const good = { id: 'e1', receivedAt: '2026-09-16T10:00:00.000Z', occurredAt: '2026-09-16T10:00:00.000Z', eventType: 'OrderConfirm', summary: 'x', verified: true };
    appendFileSync(file, JSON.stringify(good) + '\n' + '{"id":"e2","receiv', 'utf8');

    const store = new JsonlEventStore(file);
    const next = { ...good, id: 'e3', occurredAt: '2026-09-16T11:00:00.000Z' };
    expect(await store.append(next)).toEqual({ inserted: true });

    const reader = new JsonlEventStore(file);
    const ids = (await reader.query({ limit: 10 })).map((e) => e.id).sort();
    expect(ids).toEqual(['e1', 'e3']);
  });

  it('compares `since` as an instant, not as a string', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'since-'));
    const store = new JsonlEventStore(path.join(dir, 'events.jsonl'));
    await store.append({ id: 'a', receivedAt: '2026-09-16T04:00:00.000Z', occurredAt: '2026-09-16T04:00:00.000Z', eventType: 'X', summary: 's', verified: true });
    // Same instant, different spelling: a string comparison would drop the event.
    expect(await store.query({ since: '2026-09-16T04:00:00+00:00' })).toHaveLength(1);
    expect(await store.query({ since: '2026-09-16T05:00:00Z' })).toHaveLength(0);
  });
});
