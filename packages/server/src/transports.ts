import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { randomUUID } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import type { Logger } from '@mcp-3pl/core';
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
 * Stateful Streamable HTTP: one MCP server instance per session, all sharing the
 * same adapter, change store, event store and audit log (via the factory).
 * DNS-rebinding protection from createMcpExpressApp stays on by default.
 */
export async function runHttp(factory: () => BuiltServer, opts: { host: string; port: number; logger: Logger }): Promise<{ close(): Promise<void>; url: string }> {
  const app = createMcpExpressApp({ host: opts.host });
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; built: BuiltServer }>();

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && sessions.has(sid)) {
      await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
      return;
    }
    if (sid) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown session' }, id: null });
      return;
    }
    const built = factory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, built });
        opts.logger.info('mcp session started', { sessionId: id });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        opts.logger.info('mcp session closed', { sessionId: id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void built.server.close();
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
    await s.transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionRoute);
  app.delete('/mcp', sessionRoute);
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  const server: NodeHttpServer = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `http://${opts.host}:${port}/mcp`;
  opts.logger.info('streamable http transport listening', { url });
  return {
    url,
    close: async () => {
      for (const s of sessions.values()) await s.transport.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
