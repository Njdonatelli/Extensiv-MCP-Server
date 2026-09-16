import { serve } from '@hono/node-server';
import { JsonlEventStore, createLogger, type Logger } from '@mcp-3pl/core';
import path from 'node:path';
import { createIngestApp, type IngestStats } from './app.js';
import type { IngestConfig } from './config.js';
import { PinnedKeySource, RemoteKeySource, type KeySource } from './signature.js';

export async function startIngest(config: IngestConfig, deps: { logger?: Logger; keySource?: KeySource; fetchImpl?: typeof fetch } = {}): Promise<{ url: string; stats: IngestStats; close(): Promise<void> }> {
  const logger = deps.logger ?? createLogger(config.logLevel, { component: 'webhook-ingest' });
  const store = new JsonlEventStore(path.resolve(config.eventsFile));
  const keySource = deps.keySource ?? (config.publicKeyPem ? new PinnedKeySource(config.publicKeyPem) : new RemoteKeySource(config.baseUrl, config.keyCacheSeconds * 1000, logger, deps.fetchImpl));
  const { app, stats } = createIngestApp({ config, store, keySource, logger });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  const url = `http://${config.host}:${config.port}${config.path}`;
  logger.info('webhook ingest listening', { url, eventsFile: path.resolve(config.eventsFile), requireSignature: config.requireSignature, keySource: config.publicKeyPem ? 'pinned' : `${config.baseUrl}/events/webhook/key` });
  return {
    url,
    stats,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
