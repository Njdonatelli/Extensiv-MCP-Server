import { Hono } from 'hono';
import type { EventStore, Logger } from '@mcp-3pl/core';
import type { IngestConfig } from './config.js';
import { isWebhookBody, parseWebhook, type ExtensivWebhookBody } from './parse.js';
import { verifySignature, type KeySource } from './signature.js';

export interface IngestDeps {
  config: IngestConfig;
  store: EventStore;
  keySource: KeySource;
  logger: Logger;
  clock?: () => Date;
}

/** Generous next to the documented payload, small enough to refuse abuse. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface IngestStats {
  received: number;
  stored: number;
  duplicates: number;
  rejectedSignature: number;
  rejectedAuth: number;
  malformed: number;
  lastReceivedAt?: string;
}

/**
 * Extensiv requires a 20x within 3 seconds; everything here is a signature check
 * and one small file append, so the response is sent well inside that budget.
 * SOURCE: https://help.extensiv.com/en_US/rest-api/implementing-webhooks
 */
export function createIngestApp(deps: IngestDeps): { app: Hono; stats: IngestStats } {
  const { config, store, keySource, logger } = deps;
  const now = deps.clock ?? (() => new Date());
  const stats: IngestStats = { received: 0, stored: 0, duplicates: 0, rejectedSignature: 0, rejectedAuth: 0, malformed: 0 };
  const app = new Hono();

  app.get('/healthz', async (c) => c.json({ ok: true, events: await store.count(), stats }));

  app.post(config.path, async (c) => {
    stats.received += 1;
    stats.lastReceivedAt = now().toISOString();
    if (config.ingressToken) {
      const auth = c.req.header('authorization') ?? '';
      if (auth !== `Bearer ${config.ingressToken}`) {
        stats.rejectedAuth += 1;
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    // Bound the body before any work: the endpoint is public by necessity, and a documented
    // delivery is a few kilobytes even with the resource included.
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      stats.malformed += 1;
      return c.json({ error: 'body too large' }, 413);
    }
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_BODY_BYTES) {
      stats.malformed += 1;
      return c.json({ error: 'body too large' }, 413);
    }
    const signature = c.req.header('signature') ?? c.req.header('x-signature');
    let verdict: 'valid' | 'invalid' | 'missing' = 'missing';
    try {
      verdict = await verifySignature(keySource, raw, signature);
    } catch (e) {
      logger.error('signature verification unavailable', { err: String(e) });
      verdict = 'invalid';
    }
    if (verdict !== 'valid' && config.requireSignature) {
      stats.rejectedSignature += 1;
      logger.warn('rejected webhook delivery', { verdict, bytes: raw.length });
      return c.json({ error: `signature ${verdict}` }, 401);
    }
    let body: ExtensivWebhookBody;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isWebhookBody(parsed)) {
        stats.malformed += 1;
        // 400 and not 500: a malformed body is never going to succeed, so the sender should
        // stop retrying it for six hours.
        return c.json({ error: 'body must be a JSON object' }, 400);
      }
      body = parsed;
    } catch {
      stats.malformed += 1;
      return c.json({ error: 'body is not JSON' }, 400);
    }
    const verified = verdict === 'valid';
    if (!verified && !config.storeUnverified) {
      stats.rejectedSignature += 1;
      return c.json({ error: 'unverified delivery not stored' }, 401);
    }
    const event = parseWebhook(raw, body, now().toISOString(), verified);
    const { inserted } = await store.append(event);
    if (inserted) stats.stored += 1;
    else stats.duplicates += 1;
    logger.info(inserted ? 'event stored' : 'duplicate event ignored', { id: event.id, eventType: event.eventType, resource: event.resourceType, resourceId: event.resourceId, verified });
    return c.json({ ok: true, id: event.id, duplicate: !inserted }, 200);
  });

  return { app, stats };
}
