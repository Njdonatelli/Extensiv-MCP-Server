/**
 * Shared route plumbing: bearer auth, request logging, the error handler, If-Match checks, and the
 * per-rel paging limits. Routers stay thin by leaning on these.
 */
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import type { MockEnv } from '../env.js';
import { ApiError, preconditionFailed, preconditionRequired, queryParameter, unauthorized, badJson } from '../errors.js';
import type { MockState, RequestLogEntry } from '../state.js';

/**
 * Page-size limits per rel (max, default).
 * SOURCE: https://3w.extensiv.com/Rels/rql and each rel page's "Page Size" note — /orders 1000/100,
 * /inventory 1000/100, /inventory/stocksummaries 500/100, /inventory/stockdetails 500/100,
 * /inventory/receivers 500/100, /customers/{id}/items 100/10, /customers 100/20,
 * /orders/shipmentstrackinginfo 4000.
 * GUESS: the default for shipmentstrackinginfo, and both numbers for facilities, locations,
 * /orders/summaries and /orders/{id}/items — those rel pages quote no limit.
 */
export const PAGING = {
  customers: { defaultSize: 20, maxSize: 100 },
  items: { defaultSize: 10, maxSize: 100 },
  orders: { defaultSize: 100, maxSize: 1000 },
  orderSummaries: { defaultSize: 100, maxSize: 1000 },
  shipmentTracking: { defaultSize: 100, maxSize: 4000 },
  inventory: { defaultSize: 100, maxSize: 1000 },
  stockSummaries: { defaultSize: 100, maxSize: 500 },
  stockDetails: { defaultSize: 100, maxSize: 500 },
  receivers: { defaultSize: 100, maxSize: 500 },
  facilities: { defaultSize: 100, maxSize: 1000 },
  locations: { defaultSize: 100, maxSize: 1000 },
} as const;

export const TOKEN_PATH = '/AuthServer/api/Token';
/** Mock-only control plane; never proxied to or served by the real API. */
export const CONTROL_PREFIX = '/__mock/';

/**
 * SOURCE: https://3w.extensiv.com/Rels/auth — every call other than the token endpoint carries
 * `Authorization: Bearer <token>`; Rels/exceptions maps a missing or invalid bearer to 401.
 */
export function bearerMiddleware(state: MockState): MiddlewareHandler<MockEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === TOKEN_PATH || path.startsWith(CONTROL_PREFIX)) return next();
    const header = (c.req.header('Authorization') ?? '').trim();
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw unauthorized();
    const rec = state.validateToken(match[1] as string);
    if (!rec) throw unauthorized();
    c.set('userLogin', rec.userLogin);
    await next();
  };
}

const REDACTED_HEADERS = new Set(['authorization']);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    // Never keep a live credential in the request log: /__mock/requests is unauthenticated.
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? redactAuthorization(v) : v;
  }
  return out;
}

function redactAuthorization(value: string): string {
  if (/^basic\s/i.test(value)) return 'Basic <redacted>';
  return 'Bearer <redacted>';
}

/** Records every request (including control-plane ones) with its final status. */
export function requestLogMiddleware(state: MockState): MiddlewareHandler<MockEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    let body: unknown = null;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      // Reading text() populates Hono's body cache, so a later c.req.json() reuses it.
      const text = await c.req.text();
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }
    const entry: RequestLogEntry = {
      seq: state.nextRequestSeq(),
      method: c.req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: redactHeaders(c.req.header()),
      body,
      status: 0,
      at: new Date().toISOString(),
    };
    state.requests.push(entry);
    try {
      await next();
    } finally {
      entry.status = c.res.status;
      if (c.get('droppedConnection')) entry.dropped = true;
    }
  };
}

/**
 * SOURCE: https://3w.extensiv.com/Rels/exceptions — 4xx bodies are the documented JSON exception
 * objects; "Status 500 ... The body of the response will be plain text".
 */
export function errorHandler(): ErrorHandler<MockEnv> {
  return (err, c) => {
    if (err instanceof ApiError) return err.toResponse();
    // GUESS: the real 500 text is unknown; the mock echoes the message so mock bugs are debuggable.
    return new Response(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  };
}

/** SOURCE: https://3w.extensiv.com/Rels/headers — "If-Match: Required when updating a resource". */
export function requireIfMatch(c: Context<MockEnv>, currentEtag: string): void {
  const header = c.req.header('If-Match');
  if (header === undefined || header.trim() === '') throw preconditionRequired();
  if (!etagMatches(header, currentEtag)) throw preconditionFailed();
}

export function etagMatches(header: string, currentEtag: string): boolean {
  const normalise = (v: string): string => v.trim().replace(/^W\//, '');
  const current = normalise(currentEtag);
  return header
    .split(',')
    .map(normalise)
    .some((candidate) => candidate === '*' || candidate === current);
}

/** Parse a JSON request body; an unparsable one is a 400 (GUESS: the real code for bad JSON). */
export async function jsonBody(c: Context<MockEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badJson();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badJson();
  return parsed as Record<string, unknown>;
}

/**
 * Parse a comma-delimited enum query parameter case-insensitively, returning canonical names.
 * GUESS: the docs list the allowed values but not what an unknown one produces; the mock answers
 * 400 QueryParameterException NotParsable, matching how an unknown rql property is reported.
 */
export function parseEnumList(c: Context<MockEnv>, name: string, allowed: readonly string[], fallback: string): string[] {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') return [fallback];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return [fallback];
  return parts.map((part) => {
    const hit = allowed.find((a) => a.toLowerCase() === part.toLowerCase());
    if (!hit) throw queryParameter('NotParsable', [name], `${name} must be one of: ${allowed.join(', ')}`);
    return hit;
  });
}

export function requiredIntQuery(c: Context<MockEnv>, name: string): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') {
    // SOURCE: Rels/exceptions QueryParameterException ErrorCode "Required".
    throw queryParameter('Required', [name], `${name} is required`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw queryParameter('NotParsable', [name], `${name} must be an integer`);
  return n;
}

export function optionalIntQuery(c: Context<MockEnv>, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw queryParameter('NotParsable', [name], `${name} must be an integer`);
  return n;
}

/** Path ids are integers; a non-numeric one cannot name a resource, so it is a 404. */
export function pathId(c: Context<MockEnv>, name: string): number {
  const raw = c.req.param(name);
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ApiError(404, null);
  return n;
}

export function boolQuery(c: Context<MockEnv>, name: string): boolean {
  const raw = c.req.query(name);
  return raw !== undefined && /^(true|1)$/i.test(raw.trim());
}

/** `?skulist=a,b` style parameters. */
export function listQuery(c: Context<MockEnv>, name: string): string[] {
  const raw = c.req.query(name);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
