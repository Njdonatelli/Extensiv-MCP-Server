/**
 * The webhook signing key bootstraps trust for a receiver that holds no API credential, so the real
 * endpoint cannot be bearer-gated and neither can the mock's. Gating it broke the shipped demo path
 * (mock CLI + webhook-ingest CLI, default config), which is why the second half of this file drives
 * both real CLIs over real sockets instead of asserting on the route alone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockApp } from '../index.js';
import { harness } from './helpers.js';

const KEY_PATH = '/events/webhook/key';

interface KeyBody {
  publicKey: string;
  retrievalDateISO: string;
}

describe(`GET ${KEY_PATH} is unauthenticated`, () => {
  it('serves the public key with no Authorization header', async () => {
    const { app } = createMockApp();
    const res = await app.request(KEY_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as KeyBody;
    expect(body.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(Number.isNaN(Date.parse(body.retrievalDateISO))).toBe(false);
  });

  it('ignores a malformed or unknown bearer rather than 401ing', async () => {
    const { app } = createMockApp();
    for (const Authorization of ['Bearer not-a-real-token', 'Basic abc', 'Bearer']) {
      expect((await app.request(KEY_PATH, { headers: { Authorization } })).status).toBe(200);
    }
  });

  it('still answers 304 for an unchanged key without a token', async () => {
    const { app } = createMockApp();
    const { retrievalDateISO } = (await (await app.request(KEY_PATH)).json()) as KeyBody;
    const res = await app.request(`${KEY_PATH}?previousRetrievalDateISO=${encodeURIComponent(retrievalDateISO)}`);
    expect(res.status).toBe(304);
  });

  it('still serves the key to an authenticated caller', async () => {
    const h = await harness();
    expect((await h.get(KEY_PATH)).status).toBe(200);
  });

  it('leaves every other API route bearer-gated', async () => {
    const { app } = createMockApp();
    for (const p of ['/orders', '/customers', '/properties/facilities', '/inventory']) {
      expect((await app.request(p)).status).toBe(401);
    }
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MOCK_PORT = 4631;
const INGEST_PORT = 4632;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const RECEIVER_URL = `http://127.0.0.1:${INGEST_PORT}/webhooks/extensiv`;

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Fixed ports, so refuse to run against somebody else's server rather than silently passing. */
async function requireFreePort(url: string): Promise<void> {
  if (await reachable(url)) throw new Error(`${url} is already serving; free the port before running this test`);
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error(`${url}: process exited with ${child.exitCode} before listening`);
    if (await reachable(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} never became ready`);
}

/**
 * `node --import tsx` and not the `tsx` shim: the shim re-execs a second node process that outlives a
 * kill of the shim and goes on holding the port after the suite ends.
 */
function launch(script: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

describe('shipped mock CLI and webhook-ingest CLI pair with default config', () => {
  let mock: ChildProcess;
  let ingest: ChildProcess;
  let eventsFile: string;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'webhook-key-e2e-'));
    eventsFile = path.join(dir, 'events.jsonl');
    await requireFreePort(`${MOCK_URL}/__mock/state`);
    await requireFreePort(`http://127.0.0.1:${INGEST_PORT}/healthz`);
    mock = launch('packages/mock-extensiv/src/cli.ts', { MOCK_EXTENSIV_PORT: String(MOCK_PORT), MOCK_EXTENSIV_HOST: '127.0.0.1' });
    // Only the base URL and the ports are set: the receiver is given no API credential, exactly as a
    // standalone deployment has none.
    ingest = launch('packages/webhook-ingest/src/cli.ts', {
      EXTENSIV_BASE_URL: MOCK_URL,
      EXTENSIV_WEBHOOK_PORT: String(INGEST_PORT),
      EXTENSIV_WEBHOOK_HOST: '127.0.0.1',
      EXTENSIV_MCP_EVENTS_FILE: eventsFile,
      EXTENSIV_MCP_LOG_LEVEL: 'silent',
    });
    await waitFor(`${MOCK_URL}/__mock/state`, mock);
    await waitFor(`http://127.0.0.1:${INGEST_PORT}/healthz`, ingest);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([stop(mock), stop(ingest)]);
  });

  it('delivers a signed webhook the receiver verifies and stores', async () => {
    const json = { 'Content-Type': 'application/json' };
    const subscribed = await fetch(`${MOCK_URL}/__mock/webhooks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'ingest-cli', url: RECEIVER_URL, resource: 'Order', eventTypes: ['OrderCreate'] }),
    });
    expect(subscribed.status).toBe(201);

    const emitted = await fetch(`${MOCK_URL}/__mock/webhooks/emit`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ eventType: 'OrderCreate', resourceRel: 'orders/order', resourceId: 1 }),
    });
    expect(((await emitted.json()) as { emitted: number }).emitted).toBeGreaterThan(0);

    const log = (await (await fetch(`${MOCK_URL}/__mock/webhooks/deliveries`)).json()) as {
      deliveries: { url: string; ok: boolean; body: string; signature: string; attempts: { status: number | null }[] }[];
    };
    const mine = log.deliveries.find((d) => d.url === RECEIVER_URL);
    expect(mine?.attempts.map((a) => a.status)).toEqual([200]);
    expect(mine?.ok).toBe(true);

    // The receiver could only have accepted it by fetching the key anonymously, but assert the chain
    // directly too: the anonymously-served key verifies the delivered body.
    const key = (await (await fetch(`${MOCK_URL}${KEY_PATH}`)).json()) as KeyBody;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(mine?.body ?? '');
    expect(verifier.verify(key.publicKey, Buffer.from(mine?.signature ?? '', 'base64'))).toBe(true);

    const stored = (await readFile(eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { eventType: string; verified: boolean });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.eventType).toBe('OrderCreate');
    expect(stored[0]?.verified).toBe(true);
  }, 60_000);
});
