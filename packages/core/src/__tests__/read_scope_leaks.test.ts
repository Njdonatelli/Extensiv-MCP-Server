import { describe, expect, it } from 'vitest';
import { loadCoreConfig } from '../config.js';
import type { InventoryPosition, WmsEvent } from '../domain.js';
import { silentLogger } from '../logger.js';
import { createWmsMcpServer } from '../server.js';
import { MemoryAuditLog } from '../stores/audit_log.js';
import { MemoryChangeStore } from '../stores/change_store.js';
import { MemoryEventStore } from '../stores/event_store.js';
import { runTool, type ToolCallResult, type ToolContext, type ToolDefinition } from '../tools/define.js';
import { checkInventory, describeScope, recentEvents } from '../tools/read_tools.js';
import { FakeAdapter } from './fake_adapter.js';

/** The fake adapter keeps every stock row in LAX-1; a second warehouse is needed to leak one. */
class TwoFacilityAdapter extends FakeAdapter {
  override async getInventory(): Promise<InventoryPosition[]> {
    return [
      ...(await super.getInventory()),
      { sku: 'SKU-9', customer: { id: '1', name: 'Acme' }, facility: { id: '2', name: 'DFW-2' }, onHand: 5, available: 5, allocated: 0, onHold: 0 },
    ];
  }
}

function event(o: Partial<WmsEvent> & { id: string }): WmsEvent {
  return { receivedAt: '2026-09-20T01:00:00Z', occurredAt: '2026-09-20T01:00:00Z', eventType: 'OrderConfirm', summary: 'order confirmed', verified: true, ...o };
}

async function context(env: Record<string, string>, opts: { events?: WmsEvent[]; adapter?: FakeAdapter } = {}): Promise<ToolContext> {
  const eventStore = new MemoryEventStore();
  for (const e of opts.events ?? []) await eventStore.append(e);
  return createWmsMcpServer({
    adapter: opts.adapter ?? new FakeAdapter(),
    config: loadCoreConfig(env),
    logger: silentLogger,
    changeStore: new MemoryChangeStore(),
    eventStore,
    audit: new MemoryAuditLog(),
  }).ctx;
}

const call = (def: unknown, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult> => runTool(def as ToolDefinition, args, ctx);
const text = (r: ToolCallResult): string => r.content[0]!.text;

describe('recent_events does not confirm out-of-scope events', () => {
  const oosEvent = event({ id: 'e-oos', customerId: '9', referenceNum: 'OOS-SO-2' });

  it('answers a probe for an out-of-scope reference exactly as it answers an unused one', async () => {
    const ctx = await context({ EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' }, { events: [oosEvent] });
    const hit = await call(recentEvents, { reference_num: 'OOS-SO-2' }, ctx);
    const miss = await call(recentEvents, { reference_num: 'NO-SUCH-REF' }, ctx);
    expect(text(hit)).toBe(text(miss));
    expect(text(hit)).not.toContain('OOS-SO-2');
    expect(hit.structuredContent).toMatchObject({ count: 0, withheldUnattributedInWindow: 0 });
    // The oracle contradicted this refusal, which the same tool still makes.
    const named = await call(recentEvents, { customer_id: '9' }, ctx);
    expect((named.structuredContent as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
  });

  it('keeps the two probes identical when unattributed events are also present', async () => {
    const events = [oosEvent, event({ id: 'e-unattributed', referenceNum: 'UNKNOWN-1' }), event({ id: 'e-mine', customerId: '1', referenceNum: 'ACME-SO-1' })];
    const ctx = await context({ EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' }, { events });
    const hit = await call(recentEvents, { reference_num: 'OOS-SO-2' }, ctx);
    const miss = await call(recentEvents, { reference_num: 'NO-SUCH-REF' }, ctx);
    expect(text(hit)).toBe(text(miss));
    // Honest and filter-independent: one event in the window carries no customer link.
    expect(hit.structuredContent).toMatchObject({ count: 0, withheldUnattributedInWindow: 1 });
    const byType = await call(recentEvents, { event_types: ['OrderCancel'] }, ctx);
    expect(byType.structuredContent).toMatchObject({ count: 0, withheldUnattributedInWindow: 1 });
    const all = await call(recentEvents, {}, ctx);
    expect(all.structuredContent).toMatchObject({ count: 1, withheldUnattributedInWindow: 1 });
    expect(text(all)).not.toContain('OOS-SO-2');
  });

  it('withholds nothing when no read allow-list is configured', async () => {
    const ctx = await context({}, { events: [event({ id: 'e-unattributed' }), event({ id: 'e-oos-2', customerId: '9' })] });
    const all = await call(recentEvents, {}, ctx);
    expect(all.structuredContent).toMatchObject({ count: 2, withheldUnattributedInWindow: 0 });
    expect(text(all)).not.toContain('withheldNote');
  });
});

describe('read tools never print a facility outside the read scope', () => {
  it('describe_scope filters the facility list inside each customer record', async () => {
    const ctx = await context({ EXTENSIV_MCP_ALLOWED_FACILITY_IDS: '1' });
    const res = await call(describeScope, {}, ctx);
    const body = res.structuredContent as {
      customers: { id: string; facilities: { id: string; name: string }[] }[];
      facilities: { id: string }[];
      hiddenByPolicy: { facilities: number };
    };
    expect(body.facilities.map((f) => f.id)).toEqual(['1']);
    expect(body.hiddenByPolicy.facilities).toBe(1);
    expect(body.customers.find((c) => c.id === '1')!.facilities.map((f) => f.id)).toEqual(['1']);
    expect(body.customers.find((c) => c.id === '9')!.facilities).toEqual([]);
    expect(text(res)).not.toContain('DFW-2');
  });

  it('describe_scope still shows every facility when no allow-list is configured', async () => {
    const res = await call(describeScope, {}, await context({}));
    const body = res.structuredContent as { customers: { id: string; facilities: { id: string }[] }[]; hiddenByPolicy: { facilities: number } };
    expect(body.hiddenByPolicy.facilities).toBe(0);
    expect(body.customers.find((c) => c.id === '9')!.facilities.map((f) => f.id)).toEqual(['2']);
  });

  it('check_inventory drops stock rows held in an out-of-scope facility', async () => {
    const scoped = await call(checkInventory, { customer_id: '1' }, await context({ EXTENSIV_MCP_ALLOWED_FACILITY_IDS: '1' }, { adapter: new TwoFacilityAdapter() }));
    const body = scoped.structuredContent as { count: number; positions: { facility: { id: string } }[] };
    expect(body.positions.map((p) => p.facility.id)).toEqual(['1', '1']);
    expect(body.count).toBe(2);
    expect(text(scoped)).not.toContain('DFW-2');
    // Naming that facility is refused, which is what the unfiltered listing contradicted.
    const named = await call(checkInventory, { customer_id: '1', facility_id: '2' }, await context({ EXTENSIV_MCP_ALLOWED_FACILITY_IDS: '1' }, { adapter: new TwoFacilityAdapter() }));
    expect((named.structuredContent as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');

    const open = await call(checkInventory, { customer_id: '1' }, await context({}, { adapter: new TwoFacilityAdapter() }));
    expect((open.structuredContent as { count: number }).count).toBe(3);
  });
});
