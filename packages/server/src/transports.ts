import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { randomUUID } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import * as z from 'zod/v4';
import { WmsError, type Logger } from '@mcp-3pl/core';
import type { BuiltServer } from './build.js';

export async function runStdio(built: BuiltServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  logger.info('stdio transport connected', { tools: built.registeredTools.length, writesEnabled: built.coreConfig.writesEnabled });
  const stop = async () => {
    await built.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Knobs that only the HTTP transport has any use for. They are read from the
 * environment here rather than through `CoreConfigSchema` because they guard the
 * bind and the session table, both of which this file owns end to end; the names
 * follow `CORE_ENV_KEYS` so an operator still sees one convention.
 */
const HTTP_ENV_KEYS = {
  allowRemote: 'EXTENSIV_MCP_HTTP_ALLOW_REMOTE',
  sessionIdleSeconds: 'EXTENSIV_MCP_HTTP_SESSION_IDLE_SECONDS',
  maxSessions: 'EXTENSIV_MCP_HTTP_MAX_SESSIONS',
} as const;

const HttpTransportSchema = z.object({
  sessionIdleSeconds: z.coerce.number().int().positive().default(900),
  maxSessions: z.coerce.number().int().positive().default(64),
});

interface HttpTransportOptions {
  allowRemote: boolean;
  idleMs: number;
  maxSessions: number;
}

function httpTransportOptions(env: Record<string, string | undefined>): HttpTransportOptions {
  const raw: Record<string, string> = {};
  for (const key of ['sessionIdleSeconds', 'maxSessions'] as const) {
    const v = env[HTTP_ENV_KEYS[key]];
    if (v !== undefined && v !== '') raw[key] = v;
  }
  const parsed = HttpTransportSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${HTTP_ENV_KEYS[i.path[0] as keyof typeof HTTP_ENV_KEYS] ?? String(i.path[0])}: ${i.message}`);
    throw new Error(`Invalid HTTP transport configuration: ${issues.join('; ')}`);
  }
  return {
    allowRemote: ['1', 'true', 'yes', 'on'].includes((env[HTTP_ENV_KEYS.allowRemote] ?? '').trim().toLowerCase()),
    idleMs: parsed.data.sessionIdleSeconds * 1000,
    maxSessions: parsed.data.maxSessions,
  };
}

/** 127.0.0.0/8 and ::1, plus the names for them: a bind nothing off this box can reach. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Binds without express's listen callback, which doubles as a one-shot 'error' handler. */
function bind(app: ReturnType<typeof createMcpExpressApp>, host: string, port: number): Promise<NodeHttpServer> {
  return new Promise<NodeHttpServer>((resolve, reject) => {
    const s = app.listen(port, host);
    s.once('error', reject);
    s.once('listening', () => {
      // A socket that is not really bound reports a null address; announcing a url
      // from opts.port in that state is how a failed bind used to look like success.
      if (s.address() === null) reject(new WmsError('INTERNAL', `Socket for ${host}:${port} reported listening without an address`));
      else resolve(s);
    });
  });
}

/**
 * Stateful Streamable HTTP: one MCP server instance per session, all sharing the
 * same adapter, change store, event store and audit log (via the factory).
 * DNS-rebinding protection from createMcpExpressApp stays on by default.
 */
export async function runHttp(
  factory: () => BuiltServer,
  opts: { host: string; port: number; logger: Logger; env?: Record<string, string | undefined> },
): Promise<{ close(): Promise<void>; url: string }> {
  const { allowRemote, idleMs, maxSessions } = httpTransportOptions(opts.env ?? process.env);

  // This endpoint has no authentication of any kind. On loopback that is contained;
  // off it, anyone who can route to this host gets every registered tool.
  if (!isLoopbackHost(opts.host) && !allowRemote) {
    throw new WmsError(
      'VALIDATION',
      `Refusing to bind the MCP HTTP transport to ${opts.host}: the endpoint is unauthenticated, so any host that can reach ${opts.host}:${opts.port} would get every read tool — and every write tool that is enabled — against this warehouse system. ` +
        `Set ${HTTP_ENV_KEYS.allowRemote}=true to accept that exposure deliberately, or leave the bind on 127.0.0.1 and put an authenticating proxy or an SSH tunnel in front of it.`,
      { details: { host: opts.host, variable: HTTP_ENV_KEYS.allowRemote } },
    );
  }

  const app = createMcpExpressApp({ host: opts.host });
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; closeServer: () => Promise<void>; lastSeen: number; openStreams: number }>();

  /** Drops the session from the table and tears down both halves so the BuiltServer can be collected. */
  const closeSession = async (id: string, reason: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    opts.logger.info('mcp session closed', { sessionId: id, reason });
    try {
      await s.transport.close();
      await s.closeServer();
    } catch (e) {
      opts.logger.warn('mcp session teardown failed', { sessionId: id, error: e instanceof Error ? e.name : 'unknown' });
    }
  };

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }
    if (sid) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown session' }, id: null });
      return;
    }
    // Refuse rather than evict: a live session belongs to a client mid-conversation,
    // and an unauthenticated caller must not be able to push it out.
    if (sessions.size >= maxSessions) {
      opts.logger.warn('mcp session rejected: cap reached', { sessions: sessions.size, maxSessions });
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Too many active MCP sessions (${maxSessions}). Close an existing session with DELETE /mcp, or raise ${HTTP_ENV_KEYS.maxSessions}.`,
        },
        id: null,
      });
      return;
    }
    const built = factory();
    // One teardown per session however it is reached — sweep, DELETE, shutdown, or the
    // transport closing itself — so the server is released exactly once.
    let serverClosed: Promise<void> | undefined;
    const closeServer = () => (serverClosed ??= built.server.close());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, closeServer, lastSeen: Date.now(), openStreams: 0 });
        opts.logger.info('mcp session started', { sessionId: id, sessions: sessions.size });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        opts.logger.info('mcp session closed', { sessionId: id, reason: 'client' });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void closeServer();
    };
    await built.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRoute = async (req: import('express').Request, res: import('express').Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      res.status(400).send('Missing or unknown Mcp-Session-Id');
      return;
    }
    s.lastSeen = Date.now();
    // A GET holds the notification stream open and then goes quiet by design, so
    // arrival time alone would let the idle sweep reap a healthy client mid-session.
    // An open stream counts as activity until it closes.
    if (req.method === 'GET') {
      s.openStreams += 1;
      res.on('close', () => {
        s.openStreams = Math.max(0, s.openStreams - 1);
        s.lastSeen = Date.now();
      });
    }
    await s.transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionRoute);
  app.delete('/mcp', sessionRoute);
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  // express.json() rejects a malformed body by throwing; with no error middleware
  // Express's default handler answers an unauthenticated caller with an HTML stack
  // trace naming on-disk paths. The shape below is the transport's own parse error.
  app.use((err: Error & { type?: string; status?: number }, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err.type === 'entity.parse.failed') {
      // The message quotes the caller's bytes, which may be anything at all; only the type is logged.
      opts.logger.warn('rejected malformed request body', { type: err.type });
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null });
      return;
    }
    if (typeof err.type === 'string' && err.type.startsWith('entity.')) {
      opts.logger.warn('rejected request body', { type: err.type });
      res.status(typeof err.status === 'number' ? err.status : 400).json({ jsonrpc: '2.0', error: { code: -32000, message: `Bad Request: ${err.type}` }, id: null });
      return;
    }
    opts.logger.error('unhandled http error', { name: err.name, message: err.message });
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  });

  let server: NodeHttpServer;
  try {
    server = await bind(app, opts.host, opts.port);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    opts.logger.error('streamable http transport failed to bind', {
      host: opts.host,
      port: opts.port,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      message: err.message,
    });
    throw new WmsError('INTERNAL', `Failed to bind the MCP HTTP transport to ${opts.host}:${opts.port}: ${err.message}`, {
      details: { host: opts.host, port: opts.port, code: err.code, errno: err.errno, syscall: err.syscall },
      cause: e,
    });
  }

  // Sessions are created by any unauthenticated POST and otherwise live until the
  // client remembers to DELETE, so they are swept on age as well as capped.
  const sweepMs = Math.max(1_000, Math.min(idleMs, 30_000));
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.openStreams === 0 && s.lastSeen <= cutoff) void closeSession(id, 'idle');
  }, sweepMs);
  sweeper.unref();

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `http://${opts.host}:${port}/mcp`;
  opts.logger.info('streamable http transport listening', { url, maxSessions, sessionIdleSeconds: idleMs / 1000 });
  return {
    url,
    close: async () => {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) await closeSession(id, 'shutdown');
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
