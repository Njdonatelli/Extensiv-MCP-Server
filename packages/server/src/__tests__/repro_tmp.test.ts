import { afterAll, beforeAll, expect, it } from 'vitest';
import { call, callExpectingError, startStack, WRITES_ON, type Stack } from './harness.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ ...WRITES_ON, EXTENSIV_MCP_CHANGE_TTL_SECONDS: '1' });
});
afterAll(async () => { await s.close(); });

const args = (ref: string, key: string) => ({
  customer_id: '1', facility_id: '1', reference_num: ref,
  ship_to: { name: 'A', address1: '1 St', city: 'LA', state: 'CA', zip: '90001', country: 'US' },
  lines: [{ sku: 'ACME-TENT-2P', qty: 1 }],
  idempotency_key: key,
});

it('expired key reuse', async () => {
  const KEY = 'key-12345678';
  const REF = 'REPRO-EXPIRE-1';
  const p1 = await call<any>(s.client, 'create_order', args(REF, KEY));
  expect(p1.status).toBe('prepared');
  await new Promise((r) => setTimeout(r, 1400));
  const e = await callExpectingError(s.client, 'commit_change', { change_id: p1.change_id ?? p1.changeId });
  console.log('COMMIT1', JSON.stringify(e));
  const p2 = await call<any>(s.client, 'create_order', args(REF, KEY));
  console.log('PREPARE2', JSON.stringify(p2));
  const id2 = p2.change_id ?? p2.changeId;
  const c2 = await call<any>(s.client, 'commit_change', { change_id: id2 }).catch(async (err) => ({ err: String(err) }));
  console.log('COMMIT2', JSON.stringify(c2));
  const p3 = await call<any>(s.client, 'create_order', args(REF, KEY)).catch((err) => ({ err: String(err) }));
  console.log('PREPARE3', JSON.stringify(p3));
});
