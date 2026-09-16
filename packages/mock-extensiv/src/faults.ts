/**
 * Fault injection. None of this exists on the real API; it is a mock-only control surface so an
 * MCP server can be attacked with expired tokens, 429s, latency and dropped connections.
 */
import type { MiddlewareHandler } from 'hono';
import type { MockEnv } from './env.js';
import type { MockState } from './state.js';

export interface OnceFault {
  /** `METHOD /path-prefix`; METHOD may be `*`. Matched against the request path (no query). */
  match: string;
  status: number;
  retryAfterSeconds?: number;
  body?: unknown;
  /** Perform the request (state mutates) but destroy the socket before any response bytes are written. */
  dropConnection?: boolean;
}

export interface FaultConfig {
  once: OnceFault[];
  latencyMs: number;
}

export interface FaultRequest {
  expireAllTokens?: boolean;
  once?: OnceFault[];
  latencyMs?: number;
  clear?: boolean;
}

export function emptyFaults(): FaultConfig {
  return { once: [], latencyMs: 0 };
}

export function matchesFault(fault: OnceFault, method: string, path: string): boolean {
  const [m, prefix] = fault.match.split(/\s+/, 2);
  if (!m || !prefix) return false;
  if (m !== '*' && m.toUpperCase() !== method.toUpperCase()) return false;
  return path.startsWith(prefix);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function faultMiddleware(state: MockState): MiddlewareHandler<MockEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/__mock/')) return next();

    if (state.faults.latencyMs > 0) await sleep(state.faults.latencyMs);

    const idx = state.faults.once.findIndex((f) => matchesFault(f, c.req.method, path));
    if (idx === -1) return next();
    const fault = state.faults.once[idx] as OnceFault;
    state.faults.once.splice(idx, 1);

    if (fault.dropConnection) {
      // Let the handler run so the side effect is real, then kill the socket so the client sees a
      // network error with the effect already applied (outcome-unknown testing).
      await next();
      c.set('droppedConnection', true);
      const socket = c.env?.incoming?.socket;
      if (socket) {
        socket.destroy();
      } else {
        // app.request() has no socket: signal the drop with a mock-only status so unit tests can
        // still observe the branch. Real clients never see this.
        c.res = new Response(null, { status: 599, headers: { 'X-Mock-Connection-Dropped': '1' } });
      }
      return;
    }

    const headers = new Headers();
    if (fault.retryAfterSeconds !== undefined) headers.set('Retry-After', String(fault.retryAfterSeconds));
    let body: string | null = null;
    if (fault.body !== undefined && fault.body !== null) {
      if (typeof fault.body === 'string') {
        body = fault.body;
        headers.set('Content-Type', 'text/plain; charset=utf-8');
      } else {
        body = JSON.stringify(fault.body);
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }
    }
    c.res = new Response(body, { status: fault.status as 200, headers });
  };
}
