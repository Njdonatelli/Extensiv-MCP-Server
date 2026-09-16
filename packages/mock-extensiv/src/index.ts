/**
 * Public entry point for the Extensiv 3PL Warehouse Manager mock.
 *
 * `createMockApp()` builds an in-process Hono app (drive it with `app.request(...)`, no sockets);
 * `startMockServer()` binds a real HTTP listener, which is what you need for connection-drop faults
 * and for outbound webhook delivery to a local receiver.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { MockEnv } from './env.js';
import { faultMiddleware } from './faults.js';
import { authRoutes } from './routes/auth.js';
import { billboardRoutes } from './routes/billboard.js';
import { bearerMiddleware, errorHandler, requestLogMiddleware } from './routes/common.js';
import { customersRoutes } from './routes/customers.js';
import { eventsRoutes } from './routes/events.js';
import { inventoryRoutes } from './routes/inventory.js';
import { mockControlRoutes } from './routes/mock.js';
import { ordersRoutes } from './routes/orders.js';
import { propertiesRoutes } from './routes/properties.js';
import { seed } from './seed.js';
import { MockState } from './state.js';

export interface MockOptions {
  port?: number;
  host?: string;
  credentials?: { clientId: string; clientSecret: string; userLogin: string; tplGuid?: string };
  tokenTtlSeconds?: number;
  seed?: 'default' | 'empty';
  log?: boolean;
  now?: () => Date;
}

/**
 * Fixed development credentials. The real ones come from the Support Portal
 * (SOURCE: https://help.extensiv.com/en_US/rest-api/getting-started-with-credential-management).
 */
export const DEFAULT_MOCK_CREDENTIALS = {
  clientId: 'mock-client-id',
  clientSecret: 'mock-client-secret',
  userLogin: 'mock-integration-user',
  tplGuid: '00000000-0000-4000-8000-000000000001',
};

/**
 * SOURCE: https://help.extensiv.com/en_US/rest-api/providing-rest-api-access — tokens last
 * "typically between 30 and 60 minutes". The mock defaults to the documented 3600s of the Rels/auth
 * sample so `expires_in` matches the published example.
 */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/**
 * SOURCE: implementing-webhooks — receivers must answer within 3 seconds, and the real service retries
 * for about six hours. Retrying for six hours inside a test suite is useless, so the mock retries three
 * times, fast. That is a deliberate divergence (see MOCK_FIDELITY.md).
 */
const WEBHOOK_OPTIONS = { maxAttempts: 3, retryDelayMs: 50, timeoutMs: 3000, tplId: 2 };

export function createMockApp(opts: MockOptions = {}): { app: Hono<MockEnv>; state: MockState } {
  const state = new MockState({
    credentials: { ...DEFAULT_MOCK_CREDENTIALS, ...(opts.credentials ?? {}) },
    tokenTtlSeconds: opts.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS,
    webhook: { ...WEBHOOK_OPTIONS },
  });
  if (opts.now) state.now = opts.now;

  const seedKind = opts.seed ?? 'default';
  seed(state, seedKind);

  const app = new Hono<MockEnv>();
  app.onError(errorHandler());
  app.use('*', requestLogMiddleware(state));
  if (opts.log) {
    app.use('*', async (c, next) => {
      await next();
      process.stdout.write(`${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status}\n`);
    });
  }
  app.use('*', faultMiddleware(state));
  app.use('*', bearerMiddleware(state));

  // Control plane first: it must stay reachable even if a real path would otherwise shadow it.
  app.route('/', mockControlRoutes(state, (kind) => seed(state, kind)));
  app.route('/', authRoutes(state));
  app.route('/', billboardRoutes());
  app.route('/', eventsRoutes(state));
  app.route('/', customersRoutes(state));
  app.route('/', propertiesRoutes(state));
  app.route('/', ordersRoutes(state));
  app.route('/', inventoryRoutes(state));

  return { app, state };
}

export async function startMockServer(
  opts: MockOptions = {},
): Promise<{ url: string; port: number; state: MockState; close(): Promise<void> }> {
  const { app, state } = createMockApp(opts);
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? 4010;

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: requestedPort, hostname: host }, () => resolve(s));
    s.on('error', reject);
  });

  // port 0 asks the OS for an ephemeral port; report the one it actually bound.
  const address = server.address() as AddressInfo | string | null;
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  const hostForUrl = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${hostForUrl}:${port}`,
    port,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets would otherwise hold the close open past the test timeout. The method
        // exists on http.Server but not on the Http2Server arm of @hono/node-server's ServerType union.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export { MockState, seed };
export type { MockEnv };
export type { MockCredentials, OrderRecord, ReceiverRecord, RequestLogEntry, StateOptions, StockLot, TokenRecord } from './state.js';
export type { FaultConfig, FaultRequest, OnceFault } from './faults.js';
export type { DeliveryAttempt, EmitInput, WebhookDelivery, WebhookSubscription } from './webhooks.js';
export { HAL_CONTENT_TYPE, REL } from './hal.js';
export * from './models.js';
