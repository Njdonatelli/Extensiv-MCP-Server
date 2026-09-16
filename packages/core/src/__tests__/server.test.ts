import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadCoreConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { createWmsMcpServer } from '../server.js';
import { MemoryAuditLog } from '../stores/audit_log.js';
import { MemoryChangeStore } from '../stores/change_store.js';
import { MemoryEventStore } from '../stores/event_store.js';
import { FakeAdapter } from './fake_adapter.js';

async function connect(env: Record<string, string>) {
  const adapter = new FakeAdapter();
  adapter.seedOrder({ id: '1', referenceNum: 'ACME-SO-1', onHold: true, holdReason: 'address', fullyAllocated: false });
  const built = createWmsMcpServer({ adapter, config: loadCoreConfig(env), logger: silentLogger, changeStore: new MemoryChangeStore(), eventStore: new MemoryEventStore(), audit: new MemoryAuditLog() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await built.server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  return { client, adapter, built };
}

type Structured = Record<string, unknown>;

describe('createWmsMcpServer over a real MCP client', () => {
  it('registers only the 11 read tools when writes are disabled', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_inventory', 'describe_scope', 'find_orders', 'find_receipts', 'find_stuck_orders', 'get_order_status', 'get_receipt_status', 'lookup_item', 'operations_summary', 'recent_events', 'verify_connection']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const res = await client.callTool({ name: 'create_order', arguments: {} });
    expect(res.isError).toBe(true);
  });

  it('registers all 16 tools when writes are enabled and round-trips prepare -> commit -> replay', async () => {
    const { client, adapter } = await connect({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const prep = (await client.callTool({
      name: 'create_order',
      arguments: { customer_id: '1', facility_id: '1', reference_num: 'ACME-SO-2', ship_to: { name: 'Jo', address1: '1 Main', city: 'LA', state: 'CA', zip: '90001' }, lines: [{ sku: 'SKU-1', qty: 1 }] },
    })) as { structuredContent: Structured; isError?: boolean };
    expect(prep.isError).toBeFalsy();
    const changeId = prep.structuredContent.changeId as string;
    expect(adapter.orders.size).toBe(1);
    const commit = (await client.callTool({ name: 'commit_change', arguments: { change_id: changeId } })) as { structuredContent: Structured };
    expect(commit.structuredContent.status).toBe('committed');
    const replay = (await client.callTool({ name: 'commit_change', arguments: { change_id: changeId } })) as { structuredContent: Structured };
    expect(replay.structuredContent.status).toBe('replayed');
    expect(adapter.executeCalls).toHaveLength(1);
  });

  it('returns structured refusals for out-of-scope writes', async () => {
    const { client } = await connect({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const res = (await client.callTool({
      name: 'create_order',
      arguments: { customer_id: '9', facility_id: '2', reference_num: 'X', ship_to: { name: 'Jo', address1: '1', city: 'c', state: 's', zip: 'z' }, lines: [{ sku: 'SKU-1', qty: 1 }] },
    })) as { structuredContent: { error: { code: string } }; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('SCOPE_DENIED');
  });

  it('serves read tools with validation errors as structured results', async () => {
    const { client } = await connect({});
    // Schema-level failures are rejected by the SDK before the handler runs; the text still names the tool and the problem.
    const bad = (await client.callTool({ name: 'get_order_status', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/order_id or reference_num is required|Invalid arguments/);
    const notFound = (await client.callTool({ name: 'get_order_status', arguments: { order_id: '404' } })) as { structuredContent: { error: { code: string } }; isError?: boolean };
    expect(notFound.isError).toBe(true);
    expect(notFound.structuredContent.error.code).toBe('NOT_FOUND');
    const ok = (await client.callTool({ name: 'find_stuck_orders', arguments: {} })) as { structuredContent: { counts: Record<string, number> } };
    expect(ok.structuredContent.counts.on_hold).toBe(1);
    expect(ok.structuredContent.counts.short).toBe(1);
    const low = (await client.callTool({ name: 'check_inventory', arguments: { customer_id: '1', low_stock_only: true } })) as { structuredContent: { lowStock: { sku: string }[] } };
    expect(low.structuredContent.lowStock.map((l) => l.sku)).toEqual(expect.arrayContaining(['SKU-1', 'SKU-2', 'SKU-3']));
  });

  it('exposes policy and pending changes as resources', async () => {
    const { client } = await connect({});
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['wms://changes/pending', 'wms://policy']);
    const r = await client.readResource({ uri: 'wms://policy' });
    expect(JSON.parse((r.contents[0] as { text: string }).text).policy.writesEnabled).toBe(false);
  });
});

describe('customer and facility references accept a name or an id', () => {
  it('resolves an exact name, a differently-cased name and a unique partial', async () => {
    const { client } = await connect({});
    for (const ref of ['1', 'Acme', 'acme', 'Acm']) {
      const res = (await client.callTool({ name: 'find_orders', arguments: { customer_id: ref } })) as { structuredContent: { orders: { customer: { id: string } }[] }; isError?: boolean };
      expect(res.isError, `ref ${ref}`).toBeFalsy();
      expect(res.structuredContent.orders.every((o) => o.customer.id === '1')).toBe(true);
    }
  });

  it('resolves a facility name to its id', async () => {
    const { client } = await connect({});
    const res = (await client.callTool({ name: 'check_inventory', arguments: { customer_id: 'Acme', facility_id: 'LAX-1' } })) as { structuredContent: { facilityId: string }; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.facilityId).toBe('1');
  });

  it('reports NOT_FOUND with the visible customers for an unknown reference', async () => {
    const { client } = await connect({});
    const res = (await client.callTool({ name: 'find_orders', arguments: { customer_id: 'Globex' } })) as { structuredContent: { error: { code: string; details: { visibleCustomers: unknown[] } } }; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('NOT_FOUND');
    expect(res.structuredContent.error.details.visibleCustomers).toHaveLength(2);
  });

  it('reports AMBIGUOUS when a partial name matches more than one customer', async () => {
    const { client } = await connect({});
    const res = (await client.callTool({ name: 'find_orders', arguments: { customer_id: 'c' } })) as { structuredContent: { error: { code: string } }; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('AMBIGUOUS');
  });

  it('still refuses a write when a NAME resolves to a customer outside write scope', async () => {
    const { client, adapter } = await connect({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1' });
    const res = (await client.callTool({
      name: 'create_order',
      arguments: { customer_id: 'Out Of Scope', facility_id: 'DFW-2', reference_num: 'X-1', ship_to: { name: 'Jo', address1: '1', city: 'c', state: 's', zip: 'z' }, lines: [{ sku: 'SKU-1', qty: 1 }] },
    })) as { structuredContent: { error: { code: string } }; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('SCOPE_DENIED');
    expect(adapter.executeCalls).toHaveLength(0);
  });

  it('refuses a read for a name outside the read allowlist', async () => {
    const { client } = await connect({ EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' });
    const res = (await client.callTool({ name: 'find_orders', arguments: { customer_id: 'Out Of Scope' } })) as { structuredContent: { error: { code: string } }; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('SCOPE_DENIED');
  });
});
