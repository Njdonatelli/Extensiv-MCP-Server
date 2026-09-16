/**
 * Webhook signing-key endpoint.
 * SOURCE: https://help.extensiv.com/en_US/rest-api/implementing-webhooks —
 *   GET https://secure-wms.com/events/webhook/key → { publicKey (PEM spki), retrievalDateISO };
 *   an optional `previousRetrievalDateISO` yields 304 when the key has not changed.
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import type { MockState } from '../state.js';

export function eventsRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  app.get('/events/webhook/key', (c) => {
    // INFERRED: `retrievalDateISO` must identify the key version rather than "now", otherwise the
    // documented `previousRetrievalDateISO` → 304 comparison could never match. The mock returns the
    // instant the current key pair was generated.
    const retrievalDateISO = state.webhooks.keyGeneratedAt.toISOString();
    const previous = c.req.query('previousRetrievalDateISO');
    if (previous !== undefined && previous.trim() === retrievalDateISO) {
      return new Response(null, { status: 304 });
    }
    return new Response(JSON.stringify({ publicKey: state.webhooks.publicKeyPem, retrievalDateISO }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  });

  return app;
}
