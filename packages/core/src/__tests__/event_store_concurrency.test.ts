import { promises as fsp, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../stores/event_store.js';
import type { WmsEvent } from '../domain.js';

function ev(id: string, t = '2026-09-16T10:00:00.000Z'): WmsEvent {
  return { id, receivedAt: t, occurredAt: t, eventType: 'OrderConfirm', summary: 'x', verified: true, customerId: '1' };
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
}

function newFile(prefix: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'events.jsonl');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JsonlEventStore concurrent append of one id', () => {
  it('stores exactly one line and reports inserted once', async () => {
    // A webhook sender retrying while its first delivery is still in flight lands N
    // concurrent appends of one id. Each extra line corrupts the append-only archive and
    // tells the sender `duplicate: false` for a delivery we already have.
    const file = newFile('ev-race-');
    const store = new JsonlEventStore(file);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.append(ev('e1'))));
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(results.filter((r) => !r.inserted)).toHaveLength(11);
    expect(lines(file)).toHaveLength(1);
    expect(await store.count()).toBe(1);
    expect((await store.query()).map((e) => e.id)).toEqual(['e1']);
  });

  it('keeps distinct ids while deduping repeats in the same burst', async () => {
    const file = newFile('ev-race-mixed-');
    const store = new JsonlEventStore(file);
    const ids = ['a', 'a', 'b', 'a', 'c', 'b', 'c', 'c'];
    const results = await Promise.all(ids.map((id) => store.append(ev(id))));
    expect(results.filter((r) => r.inserted)).toHaveLength(3);
    expect(lines(file)).toHaveLength(3);
    expect(await store.count()).toBe(3);
  });

  it('dedupes against a line another instance already wrote', async () => {
    const file = newFile('ev-race-shared-');
    const writer = new JsonlEventStore(file);
    const other = new JsonlEventStore(file);
    await writer.append(ev('e1'));
    const results = await Promise.all(Array.from({ length: 4 }, () => other.append(ev('e1'))));
    expect(results.every((r) => !r.inserted)).toBe(true);
    expect(lines(file)).toHaveLength(1);
  });
});

describe('JsonlEventStore failed write', () => {
  it('leaves the id unclaimed so a retried delivery is still stored', async () => {
    // Durability before memory: claiming the id on a failed append would lose the event
    // from disk while the sender's retry came back as a duplicate and was acknowledged.
    const file = newFile('ev-fail-');
    const store = new JsonlEventStore(file);
    const append = vi.spyOn(fsp, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(store.append(ev('e1'))).rejects.toThrow('ENOSPC');
    expect(append).toHaveBeenCalledTimes(1);
    expect(await store.count()).toBe(0);

    expect(await store.append(ev('e1'))).toEqual({ inserted: true });
    expect(lines(file)).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });

  it('does not poison the queue for later appends', async () => {
    const file = newFile('ev-fail-queue-');
    const store = new JsonlEventStore(file);
    vi.spyOn(fsp, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
    const [failed, ...rest] = await Promise.allSettled([
      store.append(ev('e1')),
      store.append(ev('e2')),
      store.append(ev('e3')),
    ]);
    expect(failed?.status).toBe('rejected');
    expect(rest.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(lines(file)).toHaveLength(2);
    expect((await store.query({ limit: 10 })).map((e) => e.id).sort()).toEqual(['e2', 'e3']);
  });
});
