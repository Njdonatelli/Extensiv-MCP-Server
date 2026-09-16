/**
 * Shared plumbing for the end-to-end harness: a real mock Extensiv API on a real
 * socket, the real adapter pointed at it, the real MCP server, and a real MCP
 * client over an in-memory transport pair. Nothing between the layers is stubbed.
 *
 * Every stack gets its own temp state dir (mkdtempSync) so changes.jsonl /
 * audit.jsonl / events.jsonl never collide between tests, and configuration is
 * passed through the `env` object rather than mutating process.env.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { silentLogger } from '@mcp-3pl/core';
import { startMockServer } from '@mcp-3pl/mock-extensiv';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer, type BuiltServer } from '../build.js';

/**
 * Deliberately not the mock's default credentials: the secret-hygiene test needs a
 * string that could only have come from this configuration, and the masked client id
 * must not accidentally be a prefix of the secret.
 */
export const CREDENTIALS = {
  clientId: 'integration-client-id',
  clientSecret: 'zQ7-integration-client-SECRET-never-log-me',
  userLogin: 'integration-user',
};

export type Env = Record<string, string>;

export type MockServer = Awaited<ReturnType<typeof startMockServer>>;

export interface Stack {
  mock: MockServer;
  built: BuiltServer;
  client: Client;
  env: Env;
  stateDir: string;
  /** Path of the audit log this stack writes. */
  auditFile: string;
  /** Path of the change store this stack writes. */
  changesFile: string;
  /** Path of the event file this stack reads (and webhook-ingest writes). */
  eventsFile: string;
  close(): Promise<void>;
}

export function makeStateDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'extensiv-mcp-e2e-'));
}

export function baseEnv(opts: { baseUrl: string; stateDir: string; credentials?: typeof CREDENTIALS }): Env {
  const creds = opts.credentials ?? CREDENTIALS;
  return {
    EXTENSIV_BASE_URL: opts.baseUrl,
    EXTENSIV_CLIENT_ID: creds.clientId,
    EXTENSIV_CLIENT_SECRET: creds.clientSecret,
    EXTENSIV_USER_LOGIN: creds.userLogin,
    EXTENSIV_MCP_STATE_DIR: opts.stateDir,
    EXTENSIV_MCP_LOG_LEVEL: 'silent',
  };
}

/** Writes-enabled configuration for customer 1 (Acme), the seeded main customer. */
export const WRITES_ON: Env = {
  EXTENSIV_MCP_WRITES_ENABLED: 'true',
  EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1',
};

/** Connects an MCP client to an already-built server over a linked in-memory pair. */
export async function connectClient(built: BuiltServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: 'extensiv-e2e-harness', version: '0.1.0' });
  await client.connect(clientTransport);
  return client;
}

export async function startStack(
  overrides: Env = {},
  opts: { credentials?: typeof CREDENTIALS; seed?: 'default' | 'empty'; stateDir?: string } = {},
): Promise<Stack> {
  const stateDir = opts.stateDir ?? makeStateDir();
  const mock = await startMockServer({ port: 0, credentials: opts.credentials ?? CREDENTIALS, seed: opts.seed ?? 'default' });
  const env: Env = { ...baseEnv({ baseUrl: mock.url, stateDir, credentials: opts.credentials }), ...overrides };
  const built = buildServer({ env, logger: silentLogger });
  const client = await connectClient(built);
  return {
    mock,
    built,
    client,
    env,
    stateDir,
    auditFile: path.join(stateDir, 'audit.jsonl'),
    changesFile: path.join(stateDir, 'changes.jsonl'),
    eventsFile: path.join(stateDir, 'events.jsonl'),
    close: async () => {
      await client.close();
      await built.close();
      await mock.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool calling
// ---------------------------------------------------------------------------

export interface RawToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export async function rawCall(client: Client, name: string, args: Record<string, unknown> = {}): Promise<RawToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as RawToolResult;
}

export function resultText(res: RawToolResult): string {
  return res.content.map((c) => c.text ?? '').join('\n');
}

/** Calls a tool and fails loudly unless it returned a non-error structured result. */
export async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await rawCall(client, name, args);
  if (res.isError) throw new Error(`tool ${name} returned an error: ${resultText(res)}`);
  if (res.structuredContent === undefined) throw new Error(`tool ${name} returned no structuredContent`);
  return res.structuredContent as T;
}

/** Calls a tool that is expected to fail and returns the structured error payload. */
export async function callExpectingError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolError> {
  const res = await rawCall(client, name, args);
  if (!res.isError) throw new Error(`tool ${name} unexpectedly succeeded: ${resultText(res)}`);
  const structured = res.structuredContent as { error?: ToolError } | undefined;
  if (!structured?.error) throw new Error(`tool ${name} failed without a structured error payload: ${resultText(res)}`);
  return structured.error;
}

// ---------------------------------------------------------------------------
// Mock API / control plane
// ---------------------------------------------------------------------------

export interface MockRequestEntry {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  at: string;
  dropped?: boolean;
}

export interface MockOrderRow {
  orderId: number;
  referenceNum: string;
  customerId: number;
  facilityId: number;
  status: number;
  fullyAllocated: boolean;
  onHoldReason: string | null;
  etag: string;
}

export interface MockReceiverRow {
  receiverId: number;
  referenceNum: string;
  customerId: number;
  status: number;
  etag: string;
}

export interface MockStateDump {
  orders: MockOrderRow[];
  receivers: MockReceiverRow[];
  webhookSubscriptions: { url: string; resource: string; eventTypes: string[] }[];
  webhookDeliveries: number;
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} responded ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Obtains a bearer token the same way the adapter does, for direct API assertions. */
export async function mockToken(url: string, credentials: typeof CREDENTIALS = CREDENTIALS): Promise<string> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  const res = await fetch(`${url}/AuthServer/api/Token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', user_login: credentials.userLogin }),
  });
  const body = await readJson<{ access_token?: string }>(res, 'token endpoint');
  if (!body.access_token) throw new Error('token endpoint returned no access_token');
  return body.access_token;
}

/** Direct authenticated GET against the mock, bypassing the MCP server entirely. */
export async function apiGet<T>(url: string, token: string, apiPath: string): Promise<T> {
  const res = await fetch(`${url}${apiPath}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/hal+json' } });
  return readJson<T>(res, `GET ${apiPath}`);
}

export async function apiPut(url: string, token: string, apiPath: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}${apiPath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/hal+json', 'Content-Type': 'application/hal+json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function mockRequests(url: string): Promise<MockRequestEntry[]> {
  const body = await readJson<{ requests: MockRequestEntry[] }>(await fetch(`${url}/__mock/requests`), 'GET /__mock/requests');
  return body.requests;
}

export async function clearMockRequests(url: string): Promise<void> {
  const res = await fetch(`${url}/__mock/requests`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE /__mock/requests responded ${res.status}`);
}

export async function mockStateDump(url: string): Promise<MockStateDump> {
  return readJson<MockStateDump>(await fetch(`${url}/__mock/state`), 'GET /__mock/state');
}

export async function setFaults(url: string, faults: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${url}/__mock/faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(faults) });
  if (!res.ok) throw new Error(`POST /__mock/faults responded ${res.status}: ${await res.text()}`);
}

export async function addWebhookSubscription(url: string, sub: { url: string; resource?: string; eventTypes?: string[] }): Promise<void> {
  const res = await fetch(`${url}/__mock/webhooks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  if (!res.ok) throw new Error(`POST /__mock/webhooks responded ${res.status}: ${await res.text()}`);
}

export interface MockDelivery {
  deliveryId: number;
  url: string;
  eventType: string;
  attempts: { attempt: number; status: number | null; error: string | null }[];
  ok: boolean;
  done: boolean;
}

/** Waits for every in-flight webhook delivery and returns the delivery log. */
export async function flushDeliveries(url: string): Promise<MockDelivery[]> {
  const body = await readJson<{ deliveries: MockDelivery[] }>(await fetch(`${url}/__mock/webhooks/deliveries`), 'GET /__mock/webhooks/deliveries');
  return body.deliveries;
}

/** The webhook signing key, pinned by the ingest app so it never has to fetch it. */
export async function webhookPublicKey(url: string, token: string): Promise<string> {
  const body = await apiGet<{ publicKey: string }>(url, token, '/events/webhook/key');
  return body.publicKey;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Writes to a mutation endpoint, i.e. anything that is not a read or the token/control plane. */
export function isUpstreamWrite(entry: MockRequestEntry): boolean {
  if (entry.method === 'GET' || entry.method === 'HEAD') return false;
  if (entry.path === '/AuthServer/api/Token') return false;
  return !entry.path.startsWith('/__mock/');
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

export interface AuditLine {
  at: string;
  kind: string;
  tool?: string;
  changeId?: string;
  outcome: string;
  error?: { code: string; message: string };
}

/** An OS-assigned free TCP port, for processes whose listener needs a known number. */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not obtain a free port'))));
    });
  });
}

export const SHIP_TO = {
  name: 'Dana Integration',
  companyName: 'Integration Test Co',
  address1: '742 Evergreen Terrace',
  city: 'Springfield',
  state: 'OR',
  zip: '97477',
  country: 'US',
};
