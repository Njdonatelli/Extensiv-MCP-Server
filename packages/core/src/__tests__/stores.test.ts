import { mkdtempSync } from 'node:fs';
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
