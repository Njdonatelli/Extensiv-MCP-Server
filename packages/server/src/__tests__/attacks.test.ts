/**
 * Attack suite. Each test drives the real stack (mock Extensiv on a socket, real
 * adapter, real MCP server, real MCP client) into one specific failure mode and
 * asserts on the error code the model would actually receive, plus — where the
 * point is that nothing happened — on the mock's request log.
 *
 * Every test builds its own stack so a fault, a narrowed policy or a mutated order
 * cannot leak into another test.
 */
import { silentLogger } from '@mcp-3pl/core';
import { startMockServer } from '@mcp-3pl/mock-extensiv';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../build.js';
import {
  CREDENTIALS,
  SHIP_TO,
  WRITES_ON,
  apiPut,
  baseEnv,
  call,
  callExpectingError,
  clearMockRequests,
  connectClient,
  isUpstreamWrite,
  mockRequests,
  mockStateDump,
  mockToken,
  rawCall,
  readJsonl,
  resultText,
  startStack,
  type AuditLine,
  type Env,
  type Stack,
} from './harness.js';

interface PrepareShape {
  changeId: string;
  status: string;
  preview: Record<string, unknown>;
  warnings: string[];
  preconditions: string[];
}

interface CommitShape {
  changeId: string;
  status: string;
  outcome: { resourceType: string; resourceId: string; referenceNum?: string; status?: string; via: string };
  message: string;
}

interface OrderDetailShape {
  id: string;
  referenceNum: string;
  status: string;
  version?: string;
  notes?: string;
}

const openStacks: Stack[] = [];

async function stackFor(overrides: Env = {}, opts: Parameters<typeof startStack>[1] = {}): Promise<Stack> {
  const stack = await startStack(overrides, opts);
  openStacks.push(stack);
  return stack;
}

afterEach(async () => {
  while (openStacks.length > 0) {
    const stack = openStacks.pop();
    await stack?.close();
  }
});

function orderArgs(reference: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_id: '1',
    facility_id: '1',
    reference_num: reference,
    ship_to: SHIP_TO,
    lines: [{ sku: 'ACME-BOTTLE-1L', qty: 2 }],
    ...extra,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

describe('replay and idempotency', () => {
  it('committing the same change_id twice writes once and the audit log shows ok then replayed', async () => {
    const stack = await stackFor(WRITES_ON);
    const reference = 'ATK-SO-REPLAY';
    const prep = await call<PrepareShape>(stack.client, 'create_order', orderArgs(reference));
    await clearMockRequests(stack.mock.url);

    const first = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    const second = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(first.status).toBe('committed');
    expect(second.status).toBe('replayed');
    expect(second.outcome.resourceId).toBe(first.outcome.resourceId);

    const posts = (await mockRequests(stack.mock.url)).filter((r) => r.method === 'POST' && r.path === '/orders');
    expect(posts).toHaveLength(1);
    const dump = await mockStateDump(stack.mock.url);
    expect(dump.orders.filter((o) => o.referenceNum === reference)).toHaveLength(1);

    // The audit log records the write once ('ok') and the replay separately ('replayed').
    const commits = readJsonl<AuditLine>(stack.auditFile).filter((e) => e.kind === 'commit' && e.changeId === prep.changeId);
    expect(commits.map((e) => e.outcome)).toEqual(['ok', 'replayed']);
  });

  it('the same idempotency_key with the same intent returns the same change_id', async () => {
    const stack = await stackFor(WRITES_ON);
    const key = 'attack-idempotency-key-0001';
    const first = await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-IDEM-A', { idempotency_key: key }));
    expect(first.status).toBe('prepared');

    const again = await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-IDEM-A', { idempotency_key: key }));
    expect(again.changeId).toBe(first.changeId);
    expect(again.status).toBe('already_prepared');

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
  });

  it('the same idempotency_key with a DIFFERENT intent is refused rather than silently replayed', async () => {
    const stack = await stackFor(WRITES_ON);
    const key = 'attack-idempotency-key-0002';
    await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-IDEM-C', { idempotency_key: key }));

    // Returning the first plan here would quietly discard what the operator just asked for.
    const err = await callExpectingError(stack.client, 'create_order', orderArgs('ATK-SO-IDEM-D', { idempotency_key: key }));
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toContain('already used for a different request');

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
  });
});

describe('scope enforcement', () => {
  it('a write outside EXTENSIV_MCP_WRITE_CUSTOMER_IDS is SCOPE_DENIED and never reaches the mock', async () => {
    const stack = await stackFor(WRITES_ON);
    await clearMockRequests(stack.mock.url);
    const err = await callExpectingError(
      stack.client,
      'create_order',
      // Customer 2 (Bluebird) is readable but not writable under WRITES_ON.
      { ...orderArgs('ATK-SO-OOS'), customer_id: '2', lines: [{ sku: 'BLB-LIP-ROSE', qty: 1 }] },
    );
    expect(err.code).toBe('SCOPE_DENIED');
    expect(err.message).toContain('Customer 2');
    expect(err.details?.writableCustomerIds).toEqual(['1']);

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
    const refusals = readJsonl<AuditLine>(stack.auditFile).filter((e) => e.kind === 'policy_refusal');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error?.code).toBe('SCOPE_DENIED');
  });

  it('with writes disabled the write tools are absent and calling create_order errors', async () => {
    const stack = await stackFor();
    const { tools } = await stack.client.listTools();
    const names = tools.map((t) => t.name);
    for (const write of ['create_order', 'update_order', 'cancel_order', 'create_receipt', 'commit_change']) {
      expect(names).not.toContain(write);
    }

    const res = await rawCall(stack.client, 'create_order', orderArgs('ATK-SO-NOWRITE'));
    expect(res.isError).toBe(true);
    // The SDK answers an unregistered tool with McpError InvalidParams (-32602).
    expect(resultText(res)).toContain('-32602');
    expect(resultText(res)).toContain('Tool create_order not found');

    const commit = await rawCall(stack.client, 'commit_change', { change_id: 'chg_whatever' });
    expect(commit.isError).toBe(true);
    expect(resultText(commit)).toContain('Tool commit_change not found');

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
  });

  it('a read outside EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS is SCOPE_DENIED', async () => {
    const stack = await stackFor({ EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' });
    const err = await callExpectingError(stack.client, 'find_orders', { customer_id: '2' });
    expect(err.code).toBe('SCOPE_DENIED');
    expect(err.details?.customerId).toBe('2');

    const inv = await callExpectingError(stack.client, 'check_inventory', { customer_id: '9' });
    expect(inv.code).toBe('SCOPE_DENIED');

    // The in-scope customer still works, and out-of-scope rows never leak into an unscoped read.
    const ok = await call<{ orders: { customer: { id: string } }[] }>(stack.client, 'find_orders', { customer_id: '1', limit: 10 });
    expect(ok.orders.every((o) => o.customer.id === '1')).toBe(true);
    const unscoped = await call<{ orders: { customer: { id: string } }[] }>(stack.client, 'find_orders', { limit: 100 });
    expect(unscoped.orders.every((o) => o.customer.id === '1')).toBe(true);

    const scope = await call<{ customers: { id: string }[]; hiddenByPolicy: { customers: number } }>(stack.client, 'describe_scope');
    expect(scope.customers.map((c) => c.id)).toEqual(['1']);
    expect(scope.hiddenByPolicy.customers).toBe(3);
  });
});

describe('authentication', () => {
  it('a 401 mid-session is survived by re-authenticating', async () => {
    const stack = await stackFor();
    await call(stack.client, 'find_orders', { customer_id: '1', limit: 5 });
    await clearMockRequests(stack.mock.url);

    // Kill every live token behind the adapter's back: it still believes its token is valid.
    const res = await fetch(`${stack.mock.url}/__mock/faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expireAllTokens: true }),
    });
    expect(res.ok).toBe(true);

    const after = await call<{ orders: unknown[] }>(stack.client, 'find_orders', { customer_id: '1', limit: 5 });
    expect(after.orders.length).toBeGreaterThan(0);

    const log = await mockRequests(stack.mock.url);
    const first401 = log.findIndex((r) => r.status === 401);
    expect(first401).toBeGreaterThanOrEqual(0);
    expect(log[first401]?.path).toBe('/orders');
    const reauth = log.findIndex((r, i) => i > first401 && r.path === '/AuthServer/api/Token' && r.status === 200);
    expect(reauth).toBeGreaterThan(first401);
    expect(log.slice(reauth).some((r) => r.path === '/orders' && r.status === 200)).toBe(true);
  });

  it('credentials the mock rejects make verify_connection report not ok instead of throwing', async () => {
    const stack = await stackFor({ EXTENSIV_CLIENT_SECRET: 'wrong-secret-entirely' });
    const vc = await call<{ ok: boolean; authenticated: boolean; problems: string[]; reachableCustomers?: number }>(stack.client, 'verify_connection');
    expect(vc.ok).toBe(false);
    expect(vc.authenticated).toBe(false);
    expect(vc.problems.join(' ')).toContain('AUTH_FAILED');
    expect(vc.reachableCustomers).toBeUndefined();

    // Other reads surface the same code rather than a protocol-level failure.
    const err = await callExpectingError(stack.client, 'find_orders', { customer_id: '1' });
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).not.toContain('wrong-secret-entirely');
  });
});

describe('preconditions and expiry', () => {
  it('a version that moved between prepare and commit is PRECONDITION_FAILED with no write', async () => {
    const stack = await stackFor(WRITES_ON);
    const before = await call<{ order: OrderDetailShape }>(stack.client, 'get_order_status', { reference_num: 'ACME-SO-10031' });
    const prep = await call<PrepareShape>(stack.client, 'update_order', { order_id: before.order.id, notes: 'note that will never land' });

    // Move the order's ETag through the mock's own hold operator, behind the server's back.
    const token = await mockToken(stack.mock.url);
    const held = await apiPut(stack.mock.url, token, '/orders/orderholder?holdReason=attack%20suite', { orderIdentifiers: [{ id: Number(before.order.id) }] });
    expect(held.status).toBe(200);
    const moved = await call<{ order: OrderDetailShape }>(stack.client, 'get_order_status', { order_id: before.order.id });
    expect(moved.order.version).not.toBe(before.order.version);

    await clearMockRequests(stack.mock.url);
    const err = await callExpectingError(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toContain('version that was previewed');

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
    const after = await call<{ order: OrderDetailShape }>(stack.client, 'get_order_status', { order_id: before.order.id });
    expect(after.order.notes ?? '').not.toContain('note that will never land');
  });

  it('a change older than EXTENSIV_MCP_CHANGE_TTL_SECONDS commits as CHANGE_EXPIRED', async () => {
    const stack = await stackFor({ ...WRITES_ON, EXTENSIV_MCP_CHANGE_TTL_SECONDS: '1' });
    const prep = await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-EXPIRED'));
    await clearMockRequests(stack.mock.url);
    await sleep(1200);

    const err = await callExpectingError(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(err.code).toBe('CHANGE_EXPIRED');
    expect(err.hint).toContain('Prepare the change again');

    const writes = (await mockRequests(stack.mock.url)).filter(isUpstreamWrite);
    expect(writes).toEqual([]);
    const dump = await mockStateDump(stack.mock.url);
    expect(dump.orders.some((o) => o.referenceNum === 'ATK-SO-EXPIRED')).toBe(false);
  });

  it('a change committed against one base URL cannot be committed against another', async () => {
    const stack = await stackFor(WRITES_ON);
    const reference = 'ATK-SO-XENV';
    const prep = await call<PrepareShape>(stack.client, 'create_order', orderArgs(reference));
    const committed = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(committed.status).toBe('committed');
    const pendingElsewhere = await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-XENV-PENDING'));

    // A second mock, and a second server sharing the first one's state dir so the change
    // records are visible — the only difference is the base URL.
    const mockB = await startMockServer({ port: 0, credentials: CREDENTIALS });
    const builtB = buildServer({ env: { ...baseEnv({ baseUrl: mockB.url, stateDir: stack.stateDir }), ...WRITES_ON }, logger: silentLogger });
    const clientB = await connectClient(builtB);
    try {
      for (const changeId of [prep.changeId, pendingElsewhere.changeId]) {
        const err = await callExpectingError(clientB, 'commit_change', { change_id: changeId });
        expect(err.code).toBe('CHANGE_NOT_COMMITTABLE');
        expect(err.message).toContain(mockB.url);
        expect(err.message).toContain(stack.mock.url);
      }
      const dumpB = await mockStateDump(mockB.url);
      expect(dumpB.orders.some((o) => o.referenceNum === reference)).toBe(false);
      expect((await mockRequests(mockB.url)).filter(isUpstreamWrite)).toEqual([]);
    } finally {
      await clientB.close();
      await builtB.close();
      await mockB.close();
    }

    // The original server still replays the committed change correctly.
    const replay = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(replay.status).toBe('replayed');
    expect(replay.outcome.resourceId).toBe(committed.outcome.resourceId);
  });
});

describe('transport faults', () => {
  it('a lost response on POST /orders is OUTCOME_UNKNOWN and the retry reconciles by reference number', async () => {
    const stack = await stackFor(WRITES_ON);
    const reference = 'ATK-SO-DROP';
    const prep = await call<PrepareShape>(stack.client, 'create_order', orderArgs(reference));

    // The handler runs, then the socket dies: the write lands and the client learns nothing.
    await fetch(`${stack.mock.url}/__mock/faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ once: [{ match: 'POST /orders', status: 0, dropConnection: true }] }),
    });
    await clearMockRequests(stack.mock.url);

    const err = await callExpectingError(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(err.code).toBe('OUTCOME_UNKNOWN');
    expect(err.retryable).toBe(true);
    expect(err.hint).toContain('commit_change again');

    const retry = await call<CommitShape>(stack.client, 'commit_change', { change_id: prep.changeId });
    expect(retry.status).toBe('committed');
    expect(retry.outcome.via).toBe('found_existing');
    expect(retry.outcome.referenceNum).toBe(reference);

    const dump = await mockStateDump(stack.mock.url);
    expect(dump.orders.filter((o) => o.referenceNum === reference)).toHaveLength(1);
    const posts = (await mockRequests(stack.mock.url)).filter((r) => r.method === 'POST' && r.path === '/orders');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.dropped).toBe(true);
  });

  it('a 429 with Retry-After is waited out and the tool still succeeds', async () => {
    const stack = await stackFor();
    await clearMockRequests(stack.mock.url);
    await fetch(`${stack.mock.url}/__mock/faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ once: [{ match: 'GET /orders', status: 429, retryAfterSeconds: 1, body: { message: 'slow down' } }] }),
    });

    const started = Date.now();
    const page = await call<{ orders: unknown[] }>(stack.client, 'find_orders', { customer_id: '1', limit: 5 });
    expect(page.orders.length).toBeGreaterThan(0);
    // The client honoured Retry-After: 1 rather than hammering the endpoint.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const log = await mockRequests(stack.mock.url);
    expect(log.filter((r) => r.path === '/orders' && r.status === 429)).toHaveLength(1);
    expect(log.filter((r) => r.path === '/orders' && r.status === 200).length).toBeGreaterThanOrEqual(1);
  });
});

describe('blast radius and secret hygiene', () => {
  it('a mutation over EXTENSIV_MCP_MAX_UNITS_PER_MUTATION is refused as VALIDATION', async () => {
    const stack = await stackFor({ ...WRITES_ON, EXTENSIV_MCP_MAX_UNITS_PER_MUTATION: '5' });
    await clearMockRequests(stack.mock.url);
    const err = await callExpectingError(stack.client, 'create_order', orderArgs('ATK-SO-BIG', { lines: [{ sku: 'ACME-BOTTLE-1L', qty: 10 }] }));
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toContain('10 units exceeds the per-mutation cap of 5');
    expect(err.hint).toContain('EXTENSIV_MCP_MAX_UNITS_PER_MUTATION');

    expect((await mockRequests(stack.mock.url)).filter(isUpstreamWrite)).toEqual([]);
    const vc = await call<{ pendingChanges: number }>(stack.client, 'verify_connection');
    expect(vc.pendingChanges).toBe(0);

    // A request inside the cap still goes through the same path.
    const ok = await call<PrepareShape>(stack.client, 'create_order', orderArgs('ATK-SO-SMALL', { lines: [{ sku: 'ACME-BOTTLE-1L', qty: 5 }] }));
    expect(ok.status).toBe('prepared');
  });

  it('the client secret never appears in a tool result, the audit log or the change store', async () => {
    const stack = await stackFor(WRITES_ON);
    const secret = CREDENTIALS.clientSecret;
    const basic = Buffer.from(`${CREDENTIALS.clientId}:${secret}`).toString('base64');
    expect(secret.length).toBeGreaterThan(20);

    const results: string[] = [];
    const capture = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> => {
      const res = await rawCall(stack.client, name, args);
      results.push(JSON.stringify(res));
      return res.structuredContent;
    };

    await capture('verify_connection');
    await capture('describe_scope');
    await capture('find_orders', { customer_id: '1', limit: 5 });
    await capture('lookup_item', { customer_id: '1', sku: 'ACME-BOTTLE-1L' });
    const prep = (await capture('create_order', orderArgs('ATK-SO-SECRET'))) as PrepareShape | undefined;
    await capture('commit_change', { change_id: prep?.changeId ?? 'chg_missing' });
    // An error path prints more internal detail than a success path, so include one.
    await capture('get_order_status', { order_id: '999999' });
    await capture('recent_events');

    for (const serialized of results) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(basic);
    }
    // The masked client id is all a result may reveal about the credential.
    expect(results.join('')).toContain('inte…');

    const auditText = readJsonl<AuditLine>(stack.auditFile).map((l) => JSON.stringify(l)).join('\n');
    expect(auditText.length).toBeGreaterThan(0);
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(basic);

    const changesText = readJsonl<Record<string, unknown>>(stack.changesFile).map((l) => JSON.stringify(l)).join('\n');
    expect(changesText.length).toBeGreaterThan(0);
    expect(changesText).not.toContain(secret);
    expect(changesText).not.toContain(basic);

    // The mock's own request log redacts the credentials it received, too.
    const log = await mockRequests(stack.mock.url);
    expect(JSON.stringify(log)).not.toContain(secret);
    expect(JSON.stringify(log)).not.toContain(basic);
  });
});
