/**
 * End-to-end harness. No stubs between the layers:
 *
 *   startMockServer (real HTTP listener)
 *     -> createExtensivAdapter (real OAuth2 + HAL + RQL + ETag)
 *       -> buildServer (real core policy, mutation engine, JSONL stores)
 *         -> MCP Client over InMemoryTransport.createLinkedPair()
 *
 * Assertions are on real responses from that chain, plus on the mock's own state
 * and request log (`/__mock/state`, `/__mock/requests`) so "nothing was written"
 * can be proved from the other side rather than inferred.
 */
import { JsonlEventStore, silentLogger, type WmsEvent } from '@mcp-3pl/core';
import { loadIngestConfig, startIngest } from '@mcp-3pl/webhook-ingest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIALS,
  SHIP_TO,
  WRITES_ON,
  addWebhookSubscription,
  apiGet,
  call,
  clearMockRequests,
  flushDeliveries,
  freePort,
  mockRequests,
  mockStateDump,
  mockToken,
  startStack,
  type Stack,
} from './harness.js';

const READ_TOOLS = [
  'check_inventory',
  'describe_scope',
  'find_orders',
  'find_receipts',
  'find_stuck_orders',
  'get_order_status',
  'get_receipt_status',
  'lookup_item',
  'operations_summary',
  'recent_events',
  'verify_connection',
];
const WRITE_TOOLS = ['cancel_order', 'commit_change', 'create_order', 'create_receipt', 'update_order'];
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS].sort();

/** Every tool name this file has driven successfully; the last test asserts all 16 are in here. */
const EXERCISED = new Set<string>();

/** call() plus coverage bookkeeping, so "every tool was called" is checked, not claimed. */
async function use<T = Record<string, unknown>>(stack: Stack, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const out = await call<T>(stack.client, name, args);
  EXERCISED.add(name);
  return out;
}

interface OrderSummaryShape {
  id: string;
  referenceNum: string;
  status: string;
  onHold: boolean;
  customer: { id: string; name: string };
  facility: { id: string; name: string };
  trackingNumbers: string[];
  lineCount: number;
}

interface OrderDetailShape extends OrderSummaryShape {
  version?: string;
  notes?: string;
  carrier?: string;
  lines: { sku: string; qtyOrdered: number }[];
  timeline: { at: string; event: string }[];
}

interface PrepareShape {
  changeId: string;
  status: string;
  kind: string;
  summary: string;
  environment: { system: string; baseUrl: string; label: string };
  preview: Record<string, unknown>;
  warnings: string[];
  preconditions: string[];
  risk: string;
  expiresAt: string;
  nextStep: string;
}

interface CommitShape {
  changeId: string;
  status: string;
  outcome: { resourceType: string; resourceId: string; referenceNum?: string; status?: string; version?: string; via: string };
  committedAt: string;
  message: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------

describe('read-only mode', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.close();
  });

  it('registers exactly the 11 read tools and no write tool', async () => {
    const { tools } = await stack.client.listTools();
    expect(tools).toHaveLength(11);
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const write of WRITE_TOOLS) expect(tools.map((t) => t.name)).not.toContain(write);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(stack.built.registeredTools).toHaveLength(11);
  });

  it('tells the client in its instructions that the server is read-only', () => {
    const instructions = stack.client.getInstructions() ?? '';
    expect(instructions).toContain('READ-ONLY');
    expect(instructions).toContain('mock (local)');
    expect(instructions).not.toContain('commit_change');
    expect(stack.built.ctx.policy.writesEnabled).toBe(false);
  });
});

describe('writes-enabled mode: every one of the 16 tools against the real mock', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack(WRITES_ON);
  });
  afterAll(async () => {
    await stack.close();
  });

  it('registers exactly 16 tools', async () => {
    const { tools } = await stack.client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    expect(stack.built.registeredTools).toHaveLength(16);
  });

  it('verify_connection reports ok and the mock environment label', async () => {
    const vc = await use<{
      ok: boolean;
      authenticated: boolean;
      system: string;
      baseUrl: string;
      environmentLabel: string;
      reachableCustomers: number;
      reachableFacilities: number;
      identity: { userLogin?: string; clientIdMasked?: string };
      problems: string[];
      pendingChanges: number;
      policy: { writesEnabled: boolean; writeCustomerIds: string[] };
    }>(stack, 'verify_connection');
    expect(vc.ok).toBe(true);
    expect(vc.authenticated).toBe(true);
    expect(vc.problems).toEqual([]);
    expect(vc.baseUrl).toBe(stack.mock.url);
    // 127.0.0.1 is classified as the local mock by detectEnvironmentLabel.
    expect(vc.environmentLabel).toBe('mock (local)');
    expect(vc.system).toBe('extensiv-3pl-warehouse-manager');
    expect(vc.reachableCustomers).toBe(4);
    expect(vc.reachableFacilities).toBe(2);
    expect(vc.identity.userLogin).toBe(CREDENTIALS.userLogin);
    expect(vc.policy).toMatchObject({ writesEnabled: true, writeCustomerIds: ['1'] });
    expect(vc.pendingChanges).toBe(0);
  });

  it('describe_scope lists the seeded customers and facilities', async () => {
    const scope = await use<{
      environment: { displayName: string; environmentLabel: string };
      customers: { id: string; name: string; active: boolean; writable: boolean; facilities: { id: string; name: string }[] }[];
      facilities: { id: string; name: string; active: boolean; timeZone?: string }[];
      policy: { writeCustomerIds: string[] };
    }>(stack, 'describe_scope');
    // Northwind Traders is seeded deactivated, so the default (active-only) view shows three.
    expect(scope.customers).toHaveLength(3);
    expect(scope.customers.map((c) => c.name).sort()).toEqual(['Acme Outdoor Co', 'Bluebird Cosmetics', 'Out Of Scope Co']);
    const acme = scope.customers.find((c) => c.id === '1');
    expect(acme?.writable).toBe(true);
    expect(acme?.facilities.map((f) => f.name).sort()).toEqual(['DFW-2', 'LAX-1']);
    expect(scope.customers.find((c) => c.id === '9')?.writable).toBe(false);
    expect(scope.facilities.map((f) => f.name).sort()).toEqual(['DFW-2', 'LAX-1']);
    expect(scope.facilities.find((f) => f.name === 'LAX-1')?.timeZone).toBe('Pacific Standard Time');

    const withInactive = await use<{ customers: { name: string }[] }>(stack, 'describe_scope', { include_inactive: true });
    expect(withInactive.customers.map((c) => c.name)).toContain('Northwind Traders');
  });

  it('find_orders returns the seeded orders', async () => {
    const page = await use<{ total: number; page: number; pageSize: number; hasMore: boolean; orders: OrderSummaryShape[] }>(stack, 'find_orders', {
      customer_id: '1',
      limit: 100,
    });
    // 31 seeded orders belong to customer 1 (MOCK_FIDELITY.md §10).
    expect(page.total).toBe(31);
    expect(page.orders).toHaveLength(31);
    expect(page.hasMore).toBe(false);
    expect(page.orders.map((o) => o.referenceNum)).toEqual(expect.arrayContaining(['ACME-SO-10001', 'ACME-SO-10021', 'ACME-SO-10031']));
    expect(page.orders.every((o) => o.customer.id === '1')).toBe(true);

    const closed = await use<{ orders: OrderSummaryShape[] }>(stack, 'find_orders', { customer_id: '1', statuses: ['closed'], limit: 100 });
    expect(closed.orders.length).toBeGreaterThan(0);
    expect(closed.orders.every((o) => o.status === 'closed')).toBe(true);

    const byRef = await use<{ orders: OrderSummaryShape[] }>(stack, 'find_orders', { customer_id: '1', reference_num: 'ACME-SO-10007' });
    expect(byRef.orders).toHaveLength(1);
    expect(byRef.orders[0]?.trackingNumbers).toContain('PRO-88231150');
  });

  it('get_order_status resolves by id and by reference number and carries a version token', async () => {
    const byRef = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { reference_num: 'ACME-SO-10007' });
    expect(byRef.order.referenceNum).toBe('ACME-SO-10007');
    expect(byRef.order.status).toBe('closed');
    expect(byRef.order.lines).toHaveLength(3);
    expect(byRef.order.timeline.length).toBeGreaterThan(0);
    // The ETag is what update_order's If-Match and the commit-time version precondition use.
    expect(typeof byRef.order.version).toBe('string');
    expect(byRef.order.version).not.toBe('');

    const byId = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { order_id: byRef.order.id });
    expect(byId.order.referenceNum).toBe('ACME-SO-10007');
    expect(byId.order.version).toBe(byRef.order.version);
    expect(byId.order.lines.map((l) => l.sku).sort()).toEqual(['ACME-BAG-0F', 'ACME-PAD-LONG', 'ACME-TENT-2P']);
  });

  it('find_stuck_orders groups the seeded short and on-hold orders', async () => {
    const stuck = await use<{
      scanned: number;
      totalOpen: number;
      counts: Record<string, number>;
      groups: Record<string, { order: OrderSummaryShape; reason: string }[]>;
    }>(stack, 'find_stuck_orders', { customer_id: '1', max_age_days: 3 });
    const refs = (group: string): string[] => (stuck.groups[group] ?? []).map((g) => g.order.referenceNum).sort();
    // The two deliberately short orders (MOCK_FIDELITY.md §10): COOLER-45 out of stock, TENT-4P 30 of 14.
    expect(refs('short')).toEqual(['ACME-SO-10021', 'ACME-SO-10022']);
    expect(stuck.counts.short).toBe(2);
    expect(refs('on_hold')).toEqual(['ACME-SO-10023', 'ACME-SO-10030']);
    expect(stuck.groups.on_hold?.every((g) => g.reason.includes('Address verification'))).toBe(true);
    // ACME-SO-10024 carries an earliestShipDate one day in the past and is still open.
    expect(refs('past_ship_date')).toContain('ACME-SO-10024');
    expect(stuck.groups.short?.[0]?.reason).toContain('not fully allocated');
  });

  it('check_inventory returns positions, lots and a low_stock_only run', async () => {
    const inv = await use<{
      customerId: string;
      count: number;
      positions: { sku: string; onHand: number; available: number; allocated: number; onHold: number; lots?: { onHand: number }[]; facility: { name: string } }[];
    }>(stack, 'check_inventory', { customer_id: '1', facility_id: '1', include_lots: true, limit: 500 });
    expect(inv.customerId).toBe('1');
    expect(inv.count).toBeGreaterThan(10);
    const tent = inv.positions.find((p) => p.sku === 'ACME-TENT-4P');
    expect(tent).toBeDefined();
    expect(tent?.onHand).toBeGreaterThan(0);
    expect(tent?.facility.name).toBe('LAX-1');
    expect(Array.isArray(tent?.lots)).toBe(true);
    expect(inv.positions.every((p) => p.onHand === p.available + p.allocated + p.onHold)).toBe(true);

    const low = await use<{ lowStockCount: number; lowStock: { sku: string; available: number; threshold: number; deficit: number }[]; rule: string }>(stack, 'check_inventory', {
      customer_id: '1',
      low_stock_only: true,
      limit: 200,
    });
    expect(low.rule).toContain('reorderPoint');
    expect(low.lowStockCount).toBeGreaterThan(0);
    expect(low.lowStock.every((l) => l.available <= l.threshold)).toBe(true);
    // The two COOLER-45 left were consumed by ACME-SO-10020, so it is the emptiest SKU.
    expect(low.lowStock.map((l) => l.sku)).toContain('ACME-COOLER-45');
  });

  it('lookup_item finds a seeded SKU with its tracking rules', async () => {
    const one = await use<{ customerId: string; count: number; items: { sku: string; description?: string; upc?: string; trackLots?: boolean; reorderPoint?: number; active: boolean }[] }>(
      stack,
      'lookup_item',
      { customer_id: '1', sku: 'ACME-FILTER-SQZ' },
    );
    expect(one.count).toBe(1);
    const item = one.items[0];
    expect(item?.sku).toBe('ACME-FILTER-SQZ');
    expect(item?.description).toContain('Squeeze');
    expect(item?.upc).toBe('810001230097');
    expect(item?.trackLots).toBe(true);
    expect(item?.reorderPoint).toBe(30);
    expect(item?.active).toBe(true);

    const text = await use<{ items: { sku: string }[] }>(stack, 'lookup_item', { customer_id: '1', text: 'cooler', limit: 25 });
    expect(text.items.map((i) => i.sku).sort()).toEqual(['ACME-COOLER-20', 'ACME-COOLER-45']);
  });

  it('find_receipts and get_receipt_status cover a seeded receipt including a variance', async () => {
    const page = await use<{ total: number; receipts: { id: string; referenceNum: string; poNum?: string; status: string; expectedDate?: string }[] }>(stack, 'find_receipts', {
      customer_id: '1',
      limit: 100,
    });
    // Five seeded receipts belong to customer 1: ACME-ASN-5001..5005.
    expect(page.total).toBe(5);
    expect(page.receipts.map((r) => r.referenceNum).sort()).toEqual(['ACME-ASN-5001', 'ACME-ASN-5002', 'ACME-ASN-5003', 'ACME-ASN-5004', 'ACME-ASN-5005']);
    expect(page.receipts.find((r) => r.referenceNum === 'ACME-ASN-5001')?.poNum).toBe('PO-ACME-2201');

    const detail = await use<{
      receipt: { id: string; referenceNum: string; status: string; lines: { sku: string; qtyExpected: number; qtyReceived?: number; variance?: number }[] };
      varianceLines: number;
      variances: { sku: string; variance: number }[];
    }>(stack, 'get_receipt_status', { reference_num: 'ACME-ASN-5001' });
    expect(detail.receipt.referenceNum).toBe('ACME-ASN-5001');
    expect(detail.receipt.status).toBe('closed');
    expect(detail.receipt.lines.length).toBeGreaterThan(10);
    // ACME-PAD-REG was received 76 of 80 (MOCK_FIDELITY.md §10).
    expect(detail.varianceLines).toBeGreaterThanOrEqual(1);
    expect(detail.variances.map((v) => v.sku)).toContain('ACME-PAD-REG');
    expect(detail.variances.find((v) => v.sku === 'ACME-PAD-REG')?.variance).toBe(-4);

    const byId = await use<{ receipt: { referenceNum: string } }>(stack, 'get_receipt_status', { receipt_id: detail.receipt.id });
    expect(byId.receipt.referenceNum).toBe('ACME-ASN-5001');
  });

  it('does not report an ASN that has not arrived as short', async () => {
    const open = await use<{
      receipt: { referenceNum: string; status: string; totalExpectedQty: number; totalReceivedQty: number; lines: { qtyExpected: number; qtyReceived: number; variance: number }[] };
      arrived: boolean;
      varianceLines: number;
      variances: unknown[];
      outstandingNote?: string;
    }>(stack, 'get_receipt_status', { reference_num: 'ACME-ASN-5004' });

    expect(open.receipt.status).toBe('open');
    expect(open.arrived).toBe(false);
    // Nothing has landed, so nothing is received and nothing is short — the whole
    // quantity is outstanding instead. Answering "what was short?" with the entire
    // ASN is the failure this guards.
    expect(open.receipt.totalReceivedQty).toBe(0);
    expect(open.varianceLines).toBe(0);
    expect(open.variances).toEqual([]);
    expect(open.outstandingNote).toMatch(/nothing has been received/i);
    for (const line of open.receipt.lines) {
      expect(line.qtyReceived).toBe(0);
      expect(line.variance).toBe(-line.qtyExpected);
    }
  });

  it("operations_summary returns today's counts and its caveats", async () => {
    const ops = await use<{
      day: string;
      window: { start: string; end: string; note: string };
      orders: { createdToday: number; shippedToday: number; cancelledCreatedToday: number; openBacklog: number; openOnHold: number; openShort: number; openPastShipDate: number };
      receipts: { expectedToday: number; overdue: number; closedToday: number; openTotal: number };
      events: { sinceStartOfDay: number };
      caveats: string[];
    }>(stack, 'operations_summary', { customer_id: '1' });
    expect(ops.day).toBe(today());
    expect(ops.window.note).toBe('UTC day boundaries');
    const open = await use<{ total: number }>(stack, 'find_orders', { customer_id: '1', statuses: ['open', 'complete'], limit: 500 });
    expect(ops.orders.openBacklog).toBe(open.total);
    expect(ops.orders.openOnHold).toBe(2);
    expect(ops.orders.openShort).toBe(2);
    expect(ops.orders.openPastShipDate).toBeGreaterThanOrEqual(1);
    // ACME-ASN-5004 (due tomorrow) and ACME-ASN-5005 (three days overdue) are the open ones.
    expect(ops.receipts.openTotal).toBe(2);
    expect(ops.receipts.overdue).toBe(1);
    expect(ops.caveats[0]).toContain('cancelledCreatedToday');
  });

  it('recent_events reads events written into the shared events file', async () => {
    const event: WmsEvent = {
      id: 'harness:1',
      receivedAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
      eventType: 'OrderConfirm',
      resourceType: 'order',
      resourceId: '41001',
      customerId: '1',
      referenceNum: 'ACME-SO-10001',
      summary: 'written straight into the events file the server reads',
      verified: true,
    };
    // The ingest process is the normal writer; writing the same file directly proves the
    // server re-reads the file rather than caching an in-memory list.
    await new JsonlEventStore(stack.eventsFile).append(event);

    const events = await use<{ count: number; unverifiedSignatures: number; eventsFile: string; events: { id: string; eventType: string; referenceNum?: string; verified: boolean }[] }>(
      stack,
      'recent_events',
      { limit: 50 },
    );
    expect(events.eventsFile).toBe(stack.eventsFile);
    expect(events.count).toBe(1);
    expect(events.events[0]).toMatchObject({ id: 'harness:1', eventType: 'OrderConfirm', referenceNum: 'ACME-SO-10001', verified: true });
    expect(events.unverifiedSignatures).toBe(0);

    const filtered = await use<{ count: number }>(stack, 'recent_events', { event_types: ['OrderCancel'] });
    expect(filtered.count).toBe(0);
  });
});

describe('two-phase write path: create_order prepare -> commit -> replay', () => {
  let stack: Stack;
  const reference = 'INT-SO-90001';
  beforeAll(async () => {
    stack = await startStack(WRITES_ON);
  });
  afterAll(async () => {
    await stack.close();
  });

  it('prepares without writing anything to the mock', async () => {
    const prep = await use<PrepareShape>(stack, 'create_order', {
      customer_id: '1',
      facility_id: '1',
      reference_num: reference,
      ship_to: SHIP_TO,
      lines: [{ sku: 'ACME-STOVE-01', qty: 3 }],
      carrier: 'UPS',
      service: 'Ground',
      po_num: 'PO-INT-1',
    });
    expect(prep.status).toBe('prepared');
    expect(prep.changeId).toMatch(/^chg_[a-z0-9]+$/);
    expect(prep.kind).toBe('create_order');
    expect(prep.environment.label).toBe('mock (local)');
    expect(prep.environment.baseUrl).toBe(stack.mock.url);
    expect(prep.preview).toMatchObject({ referenceNum: reference, lineCount: 1, totalUnits: 3 });
    expect(prep.preconditions.join(' ')).toContain(reference);
    expect(prep.nextStep).toContain(prep.changeId);

    // Proof from the mock's own state that prepare wrote nothing.
    const dump = await mockStateDump(stack.mock.url);
    expect(dump.orders.some((o) => o.referenceNum === reference)).toBe(false);
    const writes = (await mockRequests(stack.mock.url)).filter((r) => r.method === 'POST' && r.path === '/orders');
    expect(writes).toHaveLength(0);
    // ...and from a read back through the server.
    const search = await use<{ orders: OrderSummaryShape[] }>(stack, 'find_orders', { customer_id: '1', reference_num: reference });
    expect(search.orders).toHaveLength(0);
  });

  it('commits once, is replay-safe, and sends exactly one POST /orders', async () => {
    const prep = await use<PrepareShape>(stack, 'create_order', {
      customer_id: '1',
      facility_id: '1',
      reference_num: reference,
      ship_to: SHIP_TO,
      lines: [{ sku: 'ACME-STOVE-01', qty: 3 }],
      carrier: 'UPS',
      service: 'Ground',
      po_num: 'PO-INT-1',
    });
    // Identical intent: the engine recognises the fingerprint instead of planning again.
    expect(prep.status).toBe('already_prepared');

    await clearMockRequests(stack.mock.url);
    const commit = await use<CommitShape>(stack, 'commit_change', { change_id: prep.changeId, requested_by: 'integration harness' });
    expect(commit.status).toBe('committed');
    expect(commit.outcome.via).toBe('executed');
    expect(commit.outcome.resourceType).toBe('order');
    expect(commit.outcome.referenceNum).toBe(reference);

    const orderId = commit.outcome.resourceId;
    const token = await mockToken(stack.mock.url);
    const wire = await apiGet<{ referenceNum: string; readOnly: { orderId: number; warehouseTransactionSourceType: number; status: number } }>(
      stack.mock.url,
      token,
      `/orders/${orderId}`,
    );
    expect(wire.referenceNum).toBe(reference);
    // SOURCE: https://3w.extensiv.com/rels/orders/orders — WarehouseTransactionSourceType 7 is RestApi.
    expect(wire.readOnly.warehouseTransactionSourceType).toBe(7);

    const replay = await use<CommitShape>(stack, 'commit_change', { change_id: prep.changeId });
    expect(replay.status).toBe('replayed');
    expect(replay.outcome.resourceId).toBe(orderId);
    expect(replay.message).toContain('already committed');

    const posts = (await mockRequests(stack.mock.url)).filter((r) => r.method === 'POST' && r.path === '/orders');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.status).toBe(201);

    const back = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { reference_num: reference });
    expect(back.order.id).toBe(orderId);
    expect(back.order.status).toBe('open');
    expect(back.order.lines).toEqual([expect.objectContaining({ sku: 'ACME-STOVE-01', qtyOrdered: 3 })]);
  });
});

describe('update_order, cancel_order and create_receipt against seeded data', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack(WRITES_ON);
  });
  afterAll(async () => {
    await stack.close();
  });

  it('update_order prepare + commit changes an open order', async () => {
    const before = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { reference_num: 'ACME-SO-10031' });
    expect(before.order.status).toBe('open');
    const prep = await use<PrepareShape & { preview: { changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown> } }>(stack, 'update_order', {
      order_id: before.order.id,
      notes: 'Integration harness note',
      carrier: 'FedEx',
      expected_version: before.order.version,
    });
    expect(prep.preview.changedFields.sort()).toEqual(['carrier', 'notes']);
    expect(prep.preconditions.join(' ')).toContain('still open');

    const commit = await use<CommitShape>(stack, 'commit_change', { change_id: prep.changeId });
    expect(commit.status).toBe('committed');
    expect(commit.outcome.via).toBe('executed');

    const after = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { order_id: before.order.id });
    expect(after.order.notes).toContain('Integration harness note');
    expect(after.order.carrier).toBe('FedEx');
    expect(after.order.status).toBe('open');
    // The write moved the concurrency token, which is what makes a stale commit detectable.
    expect(after.order.version).not.toBe(before.order.version);
  });

  it('cancel_order prepare + commit cancels an open order', async () => {
    const before = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { reference_num: 'ACME-SO-10021' });
    expect(before.order.status).toBe('open');
    const prep = await use<PrepareShape & { preview: { currentStatus: string; alreadyCancelled: boolean; reason: string } }>(stack, 'cancel_order', {
      order_id: before.order.id,
      reason: 'integration harness cancellation',
    });
    expect(prep.risk).toBe('high');
    expect(prep.preview).toMatchObject({ currentStatus: 'open', alreadyCancelled: false, reason: 'integration harness cancellation' });

    const commit = await use<CommitShape>(stack, 'commit_change', { change_id: prep.changeId });
    expect(commit.status).toBe('committed');
    expect(commit.outcome.status).toBe('cancelled');

    const after = await use<{ order: OrderDetailShape }>(stack, 'get_order_status', { order_id: before.order.id });
    expect(after.order.status).toBe('cancelled');
  });

  it('create_receipt prepare + commit creates an inbound receipt', async () => {
    const reference = 'INT-ASN-90001';
    const prep = await use<PrepareShape & { preview: { totalUnits: number; lineCount: number } }>(stack, 'create_receipt', {
      customer_id: '1',
      facility_id: '1',
      reference_num: reference,
      po_num: 'PO-INT-ASN-1',
      lines: [
        { sku: 'ACME-PAD-REG', qty: 12 },
        { sku: 'ACME-MEAL-CHILI', qty: 24, expirationDate: '2027-01-31' },
      ],
    });
    expect(prep.preview).toMatchObject({ lineCount: 2, totalUnits: 36 });
    // ACME-MEAL-CHILI is expiration-tracked, so an expiry-less line would be warned about.
    expect(prep.warnings.join(' ')).not.toContain('ACME-PAD-REG is lot-tracked');

    const commit = await use<CommitShape>(stack, 'commit_change', { change_id: prep.changeId });
    expect(commit.status).toBe('committed');
    expect(commit.outcome.resourceType).toBe('receipt');

    const detail = await use<{ receipt: { id: string; referenceNum: string; status: string; poNum?: string; lines: { sku: string; qtyExpected: number }[] } }>(stack, 'get_receipt_status', {
      receipt_id: commit.outcome.resourceId,
    });
    expect(detail.receipt.referenceNum).toBe(reference);
    expect(detail.receipt.status).toBe('open');
    expect(detail.receipt.poNum).toBe('PO-INT-ASN-1');
    expect(detail.receipt.lines.map((l) => l.sku).sort()).toEqual(['ACME-MEAL-CHILI', 'ACME-PAD-REG']);
  });
});

describe('webhook round trip: mock -> webhook-ingest -> events file -> recent_events', () => {
  let stack: Stack;
  let ingest: Awaited<ReturnType<typeof startIngest>> | undefined;
  beforeAll(async () => {
    stack = await startStack(WRITES_ON);
  });
  afterAll(async () => {
    await ingest?.close();
    await stack.close();
  });

  it('delivers a signed OrderCancel that recent_events reports as verified', async () => {
    const token = await mockToken(stack.mock.url);
    // SOURCE: implementing-webhooks — the signing key is published at GET /events/webhook/key.
    // Pinning it means the ingest app verifies against exactly this mock's key pair.
    const { publicKey } = await apiGet<{ publicKey: string; retrievalDateISO: string }>(stack.mock.url, token, '/events/webhook/key');
    expect(publicKey).toContain('BEGIN PUBLIC KEY');

    const port = await freePort();
    ingest = await startIngest(
      loadIngestConfig({
        EXTENSIV_BASE_URL: stack.mock.url,
        EXTENSIV_WEBHOOK_HOST: '127.0.0.1',
        EXTENSIV_WEBHOOK_PORT: String(port),
        EXTENSIV_MCP_EVENTS_FILE: stack.eventsFile,
        EXTENSIV_WEBHOOK_PUBLIC_KEY_PEM: publicKey,
        EXTENSIV_MCP_LOG_LEVEL: 'silent',
      }),
      { logger: silentLogger },
    );
    await addWebhookSubscription(stack.mock.url, { url: ingest.url, resource: 'Order', eventTypes: ['OrderCancel'] });

    const target = await call<{ order: OrderDetailShape }>(stack.client, 'get_order_status', { reference_num: 'ACME-SO-10024' });
    const prep = await call<PrepareShape>(stack.client, 'cancel_order', { order_id: target.order.id, reason: 'webhook round trip' });
    const commit = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(commit.status).toBe('committed');

    const deliveries = (await flushDeliveries(stack.mock.url)).filter((d) => d.url === ingest?.url);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe('OrderCancel');
    expect(deliveries[0]?.ok).toBe(true);
    expect(deliveries[0]?.attempts[0]?.status).toBe(200);
    expect(ingest.stats).toMatchObject({ received: 1, stored: 1, rejectedSignature: 0, malformed: 0 });

    const events = await call<{ count: number; events: { eventType: string; resourceId?: string; referenceNum?: string; customerId?: string; verified: boolean; summary: string }[] }>(
      stack.client,
      'recent_events',
      { event_types: ['OrderCancel'] },
    );
    expect(events.count).toBe(1);
    expect(events.events[0]).toMatchObject({
      eventType: 'OrderCancel',
      resourceId: target.order.id,
      referenceNum: 'ACME-SO-10024',
      customerId: '1',
      verified: true,
    });
  });
});

describe('coverage', () => {
  it('drove all 16 registered tools at least once', () => {
    expect([...EXERCISED].sort()).toEqual(ALL_TOOLS);
  });
});
