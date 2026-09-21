/**
 * Transport-level hardening for the Streamable HTTP listener. Everything here runs
 * against a real socket: a real bind (and real bind failures), real HTTP requests
 * from fetch, and real MCP sessions created by real `initialize` POSTs. The only
 * thing not exercised end to end is the WMS itself — the adapter is pointed at a
 * dead port because none of these paths ever call it.
 */
import { createLogger, isWmsError, silentLogger, type Logger, type WmsError } from '@mcp-3pl/core';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type BuiltServer } from '../build.js';
import { runHttp } from '../transports.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const TRANSPORTS_MODULE = new URL('../transports.ts', import.meta.url).href;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-hardening', version: '0.1.0' } },
});

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extensiv-mcp-transport-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real BuiltServer whose adapter points at a closed port: no path under test touches it. */
function serverFactory(stateDir: string): { factory: () => BuiltServer; created: BuiltServer[]; closed: string[] } {
  const env = {
    EXTENSIV_BASE_URL: 'http://127.0.0.1:9',
    EXTENSIV_CLIENT_ID: 'transport-test-client',
    EXTENSIV_CLIENT_SECRET: 'transport-test-secret',
    EXTENSIV_USER_LOGIN: 'transport-test-user',
    EXTENSIV_MCP_STATE_DIR: stateDir,
    EXTENSIV_MCP_LOG_LEVEL: 'silent',
  };
  const created: BuiltServer[] = [];
  const closed: string[] = [];
  const factory = () => {
    const built = buildServer({ env, logger: silentLogger });
    const id = `built-${created.length}`;
    const close = built.server.close.bind(built.server);
    built.server.close = async () => {
      closed.push(id);
      await close();
    };
    created.push(built);
    return built;
  };
  return { factory, created, closed };
}

function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('debug', {}, (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  return { logger, lines };
}

async function squat(port: number, host = '127.0.0.1'): Promise<Server> {
  const s = createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => s.close(() => resolve())));
  return s;
}

async function startHttp(opts: { port: number; host?: string; env?: Record<string, string>; stateDir?: string }) {
  const stateDir = opts.stateDir ?? tempStateDir();
  const { factory, created, closed } = serverFactory(stateDir);
  const { logger, lines } = capturingLogger();
  const running = await runHttp(factory, { host: opts.host ?? '127.0.0.1', port: opts.port, logger, env: opts.env ?? {} });
  cleanups.push(() => running.close());
  return { running, created, closed, lines, base: `http://127.0.0.1:${opts.port}` };
}

async function openSession(base: string): Promise<string | null> {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE });
  await res.text();
  return res.headers.get('mcp-session-id');
}

async function sessionCount(base: string): Promise<number> {
  const res = await fetch(`${base}/healthz`);
  return ((await res.json()) as { sessions: number }).sessions;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// DEFECT 1 — a failed bind must fail loudly
// ---------------------------------------------------------------------------

describe('bind failures', () => {
  it('rejects with the errno and logs it when the port is taken, instead of claiming to listen', async () => {
    await squat(4611);
    const stateDir = tempStateDir();
    const { factory } = serverFactory(stateDir);
    const { logger, lines } = capturingLogger();

    const err = await runHttp(factory, { host: '127.0.0.1', port: 4611, logger, env: {} }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isWmsError(err)).toBe(true);
    const wms = err as WmsError;
    expect(wms.code).toBe('INTERNAL');
    expect(wms.details).toMatchObject({ code: 'EADDRINUSE', syscall: 'listen', host: '127.0.0.1', port: 4611 });
    expect(typeof wms.details?.errno).toBe('number');

    const failure = lines.find((l) => l.msg === 'streamable http transport failed to bind');
    expect(failure).toMatchObject({ level: 'error', code: 'EADDRINUSE' });
    expect(lines.some((l) => l.msg === 'streamable http transport listening')).toBe(false);
  });

  it('rejects when the host cannot be resolved', async () => {
    const stateDir = tempStateDir();
    const { factory } = serverFactory(stateDir);
    const { logger, lines } = capturingLogger();

    const err = await runHttp(factory, {
      host: 'no-such-host.invalid',
      port: 4618,
      logger,
      env: { EXTENSIV_MCP_HTTP_ALLOW_REMOTE: 'true' },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isWmsError(err)).toBe(true);
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain((err as WmsError).details?.code);
    expect(lines.some((l) => l.msg === 'streamable http transport listening')).toBe(false);
  });

  it('rejects when the address cannot be assigned', async () => {
    const stateDir = tempStateDir();
    const { factory } = serverFactory(stateDir);
    const { logger, lines } = capturingLogger();

    const err = await runHttp(factory, {
      host: '192.0.2.1',
      port: 4619,
      logger,
      env: { EXTENSIV_MCP_HTTP_ALLOW_REMOTE: 'true' },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isWmsError(err)).toBe(true);
    expect((err as WmsError).details?.code).toBe('EADDRNOTAVAIL');
    expect(lines.some((l) => l.msg === 'streamable http transport listening')).toBe(false);
  });

  it('exits non-zero from a real process, with no success line on the way out', async () => {
    await squat(4612);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'extensiv-mcp-bindchild-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'bind.mjs');
    writeFileSync(
      script,
      [
        "const emit = (level) => (msg, meta) => process.stderr.write(JSON.stringify({ level, msg, ...(meta ?? {}) }) + '\\n');",
        "const logger = { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug'), child: () => logger };",
        `const { runHttp } = await import(${JSON.stringify(TRANSPORTS_MODULE)});`,
        "await runHttp(() => { throw new Error('factory must not run'); }, { host: '127.0.0.1', port: 4612, logger, env: {} });",
        "process.stderr.write('REACHED CODE AFTER runHttp\\n');",
      ].join('\n'),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const exit = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

    expect(exit).not.toBe(0);
    expect(out).not.toContain('streamable http transport listening');
    expect(out).not.toContain('REACHED CODE AFTER runHttp');
    expect(out).toContain('EADDRINUSE');
    expect(out).toContain('"errno"');
  });
});

// ---------------------------------------------------------------------------
// DEFECT 5 — a malformed body must not return a stack trace
// ---------------------------------------------------------------------------

describe('malformed request bodies', () => {
  it('answers a broken JSON body with a JSON-RPC parse error carrying no stack and no filesystem path', async () => {
    const { base } = await startHttp({ port: 4613 });

    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{not json' });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null });
    expect(text).not.toContain('SyntaxError');
    expect(text).not.toContain('<html');
    expect(text).not.toContain('at ');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain(REPO_ROOT);
    expect(text).not.toContain('node_modules');
  });

  it('keeps the shape it already returns for a well-formed body that is not a JSON-RPC message', async () => {
    const { base } = await startHttp({ port: 4613 });

    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{not json' });
    const invalid = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{"hello":"world"}' });
    const badBody = (await bad.json()) as { jsonrpc: string; error: { code: number }; id: null };
    const invalidBody = (await invalid.json()) as { jsonrpc: string; error: { code: number }; id: null };

    expect(Object.keys(badBody).sort()).toEqual(Object.keys(invalidBody).sort());
    expect(badBody.jsonrpc).toBe(invalidBody.jsonrpc);
    expect(badBody.id).toBe(invalidBody.id);
    expect(badBody.error.code).toBe(invalidBody.error.code);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 6 — the session table must be bounded in both count and age
// ---------------------------------------------------------------------------

describe('session table', () => {
  it('rejects new sessions with a JSON-RPC error once the cap is reached, without evicting a live one', async () => {
    const { base, created } = await startHttp({ port: 4614, env: { EXTENSIV_MCP_HTTP_MAX_SESSIONS: '2' } });

    const first = await openSession(base);
    const second = await openSession(base);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(await sessionCount(base)).toBe(2);

    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE });
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };

    expect(res.status).toBe(503);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('EXTENSIV_MCP_HTTP_MAX_SESSIONS');
    expect(res.headers.get('mcp-session-id')).toBeNull();

    // The two live sessions survived, and no third BuiltServer was ever constructed.
    expect(await sessionCount(base)).toBe(2);
    expect(created).toHaveLength(2);
    const stillThere = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': first! },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(stillThere.status).toBeLessThan(400);
  });

  it('closes idle sessions and tears down their servers', async () => {
    const { base, created, closed } = await startHttp({ port: 4617, env: { EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS: '1' } });

    await openSession(base);
    await openSession(base);
    expect(await sessionCount(base)).toBe(2);
    expect(created).toHaveLength(2);

    await sleep(2_600);

    expect(await sessionCount(base)).toBe(0);
    expect(closed).toHaveLength(2);
    // A session that the sweeper closed is gone for the client too, not just from the count.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'whatever-it-was' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(404);
  });

  it('leaves a session alone while its notification stream is open, and sweeps it once the stream closes', async () => {
    const { base, closed } = await startHttp({ port: 4620, env: { EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS: '1' } });
    const sid = await openSession(base);
    expect(sid).toBeTruthy();

    // A real client opens GET /mcp for notifications and then says nothing for a
    // long time. Arrival time alone would reap it; the open stream must not.
    const abort = new AbortController();
    const stream = fetch(`${base}/mcp`, {
      headers: { Accept: 'text/event-stream', 'mcp-session-id': sid! },
      signal: abort.signal,
    });
    await sleep(200);
    await sleep(2_600);
    expect(await sessionCount(base)).toBe(1);
    expect(closed).toHaveLength(0);

    abort.abort();
    await stream.catch(() => undefined);
    await sleep(2_600);
    expect(await sessionCount(base)).toBe(0);
    expect(closed).toHaveLength(1);
  });

  it('rejects a non-positive idle timeout the way the config module rejects bad numbers', async () => {
    const stateDir = tempStateDir();
    const { factory } = serverFactory(stateDir);
    await expect(
      runHttp(factory, { host: '127.0.0.1', port: 4618, logger: silentLogger, env: { EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS: '0' } }),
    ).rejects.toThrow(/EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS/);
  });
});

// ---------------------------------------------------------------------------
// HARDENING — an unauthenticated endpoint may not be exposed off-box by accident
// ---------------------------------------------------------------------------

describe('non-loopback bind guard', () => {
  it('refuses to bind a non-loopback host without the opt-in, and binds nothing', async () => {
    const stateDir = tempStateDir();
    const { factory } = serverFactory(stateDir);

    const err = await runHttp(factory, { host: '0.0.0.0', port: 4616, logger: silentLogger, env: {} }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isWmsError(err)).toBe(true);
    expect((err as WmsError).code).toBe('VALIDATION');
    expect((err as WmsError).message).toContain('EXTENSIV_MCP_HTTP_ALLOW_REMOTE');
    expect((err as WmsError).message).toMatch(/unauthenticated/i);

    // Nothing was left listening: the port is free for a plain server to take.
    const proof = await squat(4616, '0.0.0.0');
    expect(proof.listening).toBe(true);
  });

  it('binds a non-loopback host once the operator opts in', async () => {
    const { running, base } = await startHttp({ port: 4615, host: '0.0.0.0', env: { EXTENSIV_MCP_HTTP_ALLOW_REMOTE: 'true' } });
    expect(running.url).toBe('http://0.0.0.0:4615/mcp');
    expect(await sessionCount(base)).toBe(0);
  });

  it('leaves loopback binds alone', async () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      const { running } = await startHttp({ port: 4611, host, env: {} });
      expect(running.url).toContain('4611');
      await running.close();
      cleanups.pop();
    }
  });
});
