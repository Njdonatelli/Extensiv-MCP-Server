import { describe, expect, it } from 'vitest';
import { loadCoreConfig } from '../config.js';
import { MutationEngine } from '../engine/mutation_engine.js';
import { WmsError } from '../errors.js';
import { ScopePolicy } from '../policy.js';
import { MemoryAuditLog } from '../stores/audit_log.js';
import { MemoryChangeStore } from '../stores/change_store.js';
import { FakeAdapter } from './fake_adapter.js';

function setup(env: Record<string, string> = { EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' }) {
  const adapter = new FakeAdapter();
  const config = loadCoreConfig(env);
  const policy = new ScopePolicy(config);
  const store = new MemoryChangeStore();
  const audit = new MemoryAuditLog();
  let now = Date.parse('2026-09-16T12:00:00Z');
  const clock = { now: () => new Date(now), advance: (ms: number) => (now += ms) };
  const engine = new MutationEngine({ adapter, store, policy, config, audit, clock });
  return { adapter, engine, store, audit, clock, policy };
}

const createInput = { customerId: '1', facilityId: '1', referenceNum: 'REF-1', shipTo: { name: 'A' }, lines: [{ sku: 'SKU-1', qty: 2 }] };

describe('MutationEngine prepare', () => {
  it('prepares without writing and returns a preview', async () => {
    const { adapter, engine } = setup();
    const r = await engine.prepare('create_order', createInput);
    expect(r.status).toBe('prepared');
    expect(r.changeId).toMatch(/^chg_/);
    expect(adapter.executeCalls).toHaveLength(0);
    expect(adapter.orders.size).toBe(0);
    expect(r.nextStep).toContain('commit_change');
  });

  it('dedupes identical intents into the same change id', async () => {
    const { engine } = setup();
    const a = await engine.prepare('create_order', createInput);
    const b = await engine.prepare('create_order', { ...createInput, lines: [{ qty: 2, sku: 'SKU-1' }] });
    expect(b.changeId).toBe(a.changeId);
    expect(b.status).toBe('already_prepared');
  });

  it('returns the same change for the same key and the same intent', async () => {
    const { engine } = setup();
    const a = await engine.prepare('create_order', createInput, { idempotencyKey: 'key-123456' });
    const b = await engine.prepare('create_order', { ...createInput }, { idempotencyKey: 'key-123456' });
    expect(b.changeId).toBe(a.changeId);
    expect(b.status).toBe('already_prepared');
  });

  it('refuses a reused idempotency key that carries a different intent', async () => {
    const { engine } = setup();
    await engine.prepare('create_order', createInput, { idempotencyKey: 'key-123456' });
    await expect(engine.prepare('create_order', { ...createInput, referenceNum: 'REF-OTHER' }, { idempotencyKey: 'key-123456' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('lets the same intent be prepared again once the reuse window has passed', async () => {
    // An order created and later cancelled must be creatable again under the same
    // reference; the dedupe window exists to catch double-submits, not to block forever.
    const { engine, clock, adapter } = setup();
    const first = await engine.prepare('create_order', createInput);
    await engine.commit(first.changeId);
    adapter.orders.clear();
    clock.advance(901_000);
    const again = await engine.prepare('create_order', createInput);
    expect(again.changeId).not.toBe(first.changeId);
    expect(again.status).toBe('prepared');
  });

  it('refuses out-of-scope customers before any planning', async () => {
    const { engine, adapter, audit } = setup();
    await expect(engine.prepare('create_order', { ...createInput, customerId: '9' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(adapter.executeCalls).toHaveLength(0);
    expect(audit.entries.some((e) => e.kind === 'policy_refusal')).toBe(true);
  });

  it('refuses when the resolved scope is out of the write allowlist even if input omitted the customer', async () => {
    const { engine, adapter } = setup();
    adapter.seedOrder({ id: '7', referenceNum: 'X', customer: { id: '9', name: 'Out' } });
    await expect(engine.prepare('cancel_order', { orderId: '7', reason: 'test reason' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('refuses everything when writes are disabled', async () => {
    const { engine } = setup({});
    await expect(engine.prepare('create_order', createInput)).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
  });

  it('enforces blast-radius caps', async () => {
    const { engine } = setup({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1', EXTENSIV_MCP_MAX_UNITS_PER_MUTATION: '5' });
    await expect(engine.prepare('create_order', { ...createInput, lines: [{ sku: 'SKU-1', qty: 6 }] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('MutationEngine commit', () => {
  it('commits exactly once and replays as a no-op', async () => {
    const { adapter, engine, audit } = setup();
    const p = await engine.prepare('create_order', createInput);
    const c1 = await engine.commit(p.changeId);
    expect(c1.status).toBe('committed');
    expect(c1.outcome.via).toBe('executed');
    const c2 = await engine.commit(p.changeId);
    expect(c2.status).toBe('replayed');
    expect(c2.outcome.resourceId).toBe(c1.outcome.resourceId);
    expect(adapter.executeCalls).toHaveLength(1);
    expect(adapter.orders.size).toBe(1);
    expect(audit.entries.filter((e) => e.kind === 'commit' && e.outcome === 'replayed')).toHaveLength(1);
  });

  it('coalesces concurrent commits of the same change', async () => {
    const { adapter, engine } = setup();
    const p = await engine.prepare('create_order', createInput);
    const [a, b, c] = await Promise.all([engine.commit(p.changeId), engine.commit(p.changeId), engine.commit(p.changeId)]);
    expect(adapter.executeCalls).toHaveLength(1);
    expect(new Set([a.outcome.resourceId, b.outcome.resourceId, c.outcome.resourceId]).size).toBe(1);
  });

  it('re-preparing after commit reports already_committed', async () => {
    const { engine } = setup();
    const p = await engine.prepare('create_order', createInput);
    await engine.commit(p.changeId);
    const again = await engine.prepare('create_order', createInput);
    expect(again.status).toBe('already_committed');
    expect(again.outcome?.resourceId).toBeDefined();
  });

  it('does not double-create when the effect already exists upstream (natural key)', async () => {
    const { adapter, engine } = setup();
    const p = await engine.prepare('create_order', createInput);
    adapter.seedOrder({ id: '55', referenceNum: 'REF-1' }); // someone created it out-of-band between prepare and commit
    const c = await engine.commit(p.changeId);
    expect(c.status).toBe('committed');
    expect(c.outcome.via).toBe('found_existing');
    expect(c.outcome.resourceId).toBe('55');
    expect(adapter.executeCalls).toHaveLength(0);
  });

  it('reconciles a lost response on retry instead of re-posting', async () => {
    const { adapter, engine } = setup();
    const p = await engine.prepare('create_order', createInput);
    adapter.failExecuteWith = new WmsError('OUTCOME_UNKNOWN', 'socket closed');
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await engine.get(p.changeId))?.status).toBe('outcome_unknown');
    const c = await engine.commit(p.changeId);
    expect(c.outcome.via).toBe('found_existing');
    expect(adapter.executeCalls).toHaveLength(1);
    expect(adapter.orders.size).toBe(1);
  });

  it('fails loudly when a version precondition no longer holds', async () => {
    const { adapter, engine } = setup();
    adapter.seedOrder({ id: '1', referenceNum: 'R', version: 'v1' });
    const p = await engine.prepare('update_order', { orderId: '1', notes: 'new' });
    adapter.orders.get('1')!.version = 'v2';
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(adapter.executeCalls).toHaveLength(0);
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'CHANGE_NOT_COMMITTABLE' });
  });

  it('refuses expired changes', async () => {
    const { engine, clock } = setup();
    const p = await engine.prepare('create_order', createInput);
    clock.advance(901_000);
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'CHANGE_EXPIRED' });
  });

  it('refuses unknown and discarded changes', async () => {
    const { engine } = setup();
    await expect(engine.commit('chg_nope')).rejects.toMatchObject({ code: 'CHANGE_UNKNOWN' });
    const p = await engine.prepare('create_order', createInput);
    await engine.discard(p.changeId);
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'CHANGE_NOT_COMMITTABLE' });
  });

  it('re-checks scope at commit time so a narrowed policy takes effect', async () => {
    const shared = new MemoryChangeStore();
    const adapter = new FakeAdapter();
    const cfgOpen = loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const engineOpen = new MutationEngine({ adapter, store: shared, policy: new ScopePolicy(cfgOpen), config: cfgOpen });
    const p = await engineOpen.prepare('create_order', createInput);
    const cfgClosed = loadCoreConfig({});
    const engineClosed = new MutationEngine({ adapter, store: shared, policy: new ScopePolicy(cfgClosed), config: cfgClosed });
    await expect(engineClosed.commit(p.changeId)).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(adapter.executeCalls).toHaveLength(0);
  });

  it('refuses to commit a change prepared against another environment', async () => {
    const { engine, adapter } = setup();
    const p = await engine.prepare('create_order', createInput);
    adapter.info = { ...adapter.info, baseUrl: 'https://secure-wms.com', environmentLabel: 'production' };
    await expect(engine.commit(p.changeId)).rejects.toMatchObject({ code: 'CHANGE_NOT_COMMITTABLE' });
  });

  it('cancelling an already-cancelled order is a no-op via found_existing', async () => {
    const { adapter, engine } = setup();
    adapter.seedOrder({ id: '3', referenceNum: 'C', status: 'cancelled' });
    const p = await engine.prepare('cancel_order', { orderId: '3', reason: 'duplicate order' });
    expect(p.warnings).toContain('already cancelled');
    const c = await engine.commit(p.changeId);
    expect(c.outcome.via).toBe('found_existing');
    expect(adapter.executeCalls).toHaveLength(0);
  });
});

describe('repeatable intents and tenant isolation', () => {
  const updateSetup = () => setup();

  it('lets an identical update_order be prepared and committed again', async () => {
    // A warehouse user changes the carrier back; the operator asks the agent to re-apply the
    // same value. The arguments are byte-identical to the first request, so a fingerprint
    // dedupe that never expires would report "already committed" and write nothing.
    const { adapter, engine } = updateSetup();
    adapter.seedOrder({ id: '1', referenceNum: 'R-1', version: 'v1' });
    const first = await engine.prepare('update_order', { orderId: '1', notes: 'gate code 4821' });
    await engine.commit(first.changeId);
    expect(adapter.executeCalls).toHaveLength(1);

    const second = await engine.prepare('update_order', { orderId: '1', notes: 'gate code 4821' });
    expect(second.changeId).not.toBe(first.changeId);
    expect(second.status).toBe('prepared');
    await engine.commit(second.changeId);
    expect(adapter.executeCalls).toHaveLength(2);
  });

  it('still absorbs a double-submitted create within the reuse window', async () => {
    const { engine } = setup();
    const a = await engine.prepare('create_order', createInput);
    const b = await engine.prepare('create_order', createInput);
    expect(b.changeId).toBe(a.changeId);
  });

  it('refuses to commit a change belonging to another tenant on the same base URL', async () => {
    // Two Extensiv tenants share https://secure-wms.com and differ only by credentials. If
    // both servers run from one directory they share changes.jsonl, so the target must carry
    // more than the base URL.
    const shared = new MemoryChangeStore();
    const adapterA = new FakeAdapter();
    adapterA.info = { ...adapterA.info, baseUrl: 'https://secure-wms.com', environmentLabel: 'production', tenantKey: 'tenant-acme' };
    const cfg = loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const engineA = new MutationEngine({ adapter: adapterA, store: shared, policy: new ScopePolicy(cfg), config: cfg });
    const prepared = await engineA.prepare('create_order', createInput);

    const adapterB = new FakeAdapter();
    adapterB.info = { ...adapterB.info, baseUrl: 'https://secure-wms.com', environmentLabel: 'production', tenantKey: 'tenant-globex' };
    const engineB = new MutationEngine({ adapter: adapterB, store: shared, policy: new ScopePolicy(cfg), config: cfg });
    await expect(engineB.commit(prepared.changeId)).rejects.toMatchObject({ code: 'CHANGE_NOT_COMMITTABLE' });
    expect(adapterB.executeCalls).toHaveLength(0);
  });

  it('refuses when only the environment label differs', async () => {
    const shared = new MemoryChangeStore();
    const cfg = loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const a = new FakeAdapter();
    a.info = { ...a.info, environmentLabel: 'sandbox' };
    const engineA = new MutationEngine({ adapter: a, store: shared, policy: new ScopePolicy(cfg), config: cfg });
    const prepared = await engineA.prepare('create_order', createInput);
    const b = new FakeAdapter();
    b.info = { ...b.info, environmentLabel: 'production' };
    const engineB = new MutationEngine({ adapter: b, store: shared, policy: new ScopePolicy(cfg), config: cfg });
    await expect(engineB.commit(prepared.changeId)).rejects.toMatchObject({ code: 'CHANGE_NOT_COMMITTABLE' });
  });
});
