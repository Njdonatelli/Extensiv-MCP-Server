import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlChangeStore } from '../stores/change_store.js';
import type { ChangeRecord } from '../mutation.js';

function rec(id: string, status: ChangeRecord['status'] = 'prepared', pad = ''): ChangeRecord {
  return {
    id,
    kind: 'create_order',
    status,
    fingerprint: 'fp-' + id,
    plan: { kind: 'create_order', summary: 's' + pad, scope: { customerId: '1' }, input: { customerId: '1', facilityId: '1', referenceNum: id, shipTo: {}, lines: [] }, preview: {}, warnings: [], preconditions: [], upstream: [], risk: 'low', upstreamIdempotent: false },
    target: { system: 't', baseUrl: 'http://x', environmentLabel: 'test' },
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T00:15:00Z',
    commitAttempts: 0,
  } as ChangeRecord;
}

describe('repro', () => {
  it('concurrent puts from two instances', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chg-repro-'));
    const file = path.join(dir, 'changes.jsonl');
    const a = new JsonlChangeStore(file);
    const b = new JsonlChangeStore(file);
    await a.put(rec('chg_seed'));
    expect(await b.get('chg_seed')).toBeDefined();

    // concurrent, different lengths
    await Promise.all([a.put(rec('chg_aaa', 'prepared', 'XXXXXXXXXXXXXXXX')), b.put(rec('chg_bbb'))]);

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    console.log('lines on disk:', lines.length, lines.map((l) => JSON.parse(l).id));

    console.log('B sees aaa?', await b.get('chg_aaa'));
    console.log('A sees bbb?', await a.get('chg_bbb'));
    console.log('B list', (await b.list()).map((r) => r.id));
    console.log('A list', (await a.list()).map((r) => r.id));
    // retry later
    await b.put(rec('chg_ccc'));
    console.log('B list after another put', (await b.list()).map((r) => r.id));
    console.log('B sees aaa (2nd)?', (await b.get('chg_aaa'))?.id);
  });

  it('commit status lost', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chg-repro2-'));
    const file = path.join(dir, 'changes.jsonl');
    const a = new JsonlChangeStore(file);
    const b = new JsonlChangeStore(file);
    await a.put(rec('chg_x'));
    expect((await b.get('chg_x'))?.status).toBe('prepared');
    await Promise.all([
      a.put({ ...rec('chg_x', 'committed'), commitAttempts: 1 }),
      b.put(rec('chg_other', 'prepared', 'YYYYYYYYYYYYYYYYYYYYYYYY')),
    ]);
    console.log('B status for chg_x:', (await b.get('chg_x'))?.status);
    console.log('disk statuses:', readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => { const r = JSON.parse(l); return r.id + '=' + r.status; }));
  });
});
