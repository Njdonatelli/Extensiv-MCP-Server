/**
 * Test double for the Extensiv API: a `fetch` implementation driven by a list of
 * routes, plus the fixtures under src/__fixtures__. No network, no dependency on
 * the mock-extensiv package, so an adapter test fails only when the adapter is wrong.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensivConfigSchema, type ExtensivConfig } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(here, '..', '__fixtures__', name), 'utf8')) as T;
}

export interface Ctx {
  method: string;
  path: string;
  url: URL;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface Res {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = (ctx: Ctx) => Res | undefined;

export interface FakeApi {
  fetchImpl: typeof fetch;
  calls: Ctx[];
}

/** `path` is matched exactly (string) or tested (RegExp). */
export function route(method: string, path: string | RegExp, respond: (ctx: Ctx) => Res | undefined): Route {
  return (ctx) => {
    if (ctx.method !== method.toUpperCase()) return undefined;
    const hit = typeof path === 'string' ? ctx.path === path : path.test(ctx.path);
    return hit ? respond(ctx) : undefined;
  };
}

/** The documented token endpoint (SOURCE https://3w.extensiv.com/Rels/auth). */
export function tokenRoute(token = 'test-token', expiresIn = 3600): Route {
  return route('POST', '/AuthServer/api/Token', () => ({ status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: null, scope: null } }));
}

export function customersRoute(): Route {
  return route('GET', '/customers', () => ({ status: 200, body: fixture('customers_page.json') }));
}

export function facilitiesRoute(): Route {
  return route('GET', '/properties/facilities', () => ({ status: 200, body: fixture('facilities_page.json') }));
}

/**
 * Item master with just enough RQL awareness for the adapter's three uses:
 * `sku=in=(a,b)`, `sku==x` and `readonly.deactivated==false`.
 */
export function itemsRoute(): Route {
  return route('GET', /^\/customers\/\d+\/items$/, (ctx) => {
    const page = fixture<{ totalResults: number; _embedded: Record<string, { sku?: string; readOnly?: { deactivated?: boolean } }[]> }>('items_page.json');
    const key = 'http://api.3plCentral.com/rels/customers/item';
    let rows = page._embedded[key] ?? [];
    const rql = ctx.query.get('rql') ?? '';
    const inList = /sku=in=\(([^)]*)\)/i.exec(rql);
    if (inList?.[1]) {
      const wanted = inList[1].split(',').map((s) => decodeURIComponent(s).toUpperCase());
      rows = rows.filter((r) => wanted.includes((r.sku ?? '').toUpperCase()));
    }
    const exact = /(?:^|;|\()sku==([^;,)]+)/i.exec(rql);
    if (exact?.[1]) {
      const wanted = decodeURIComponent(exact[1]).toUpperCase();
      rows = rows.filter((r) => (r.sku ?? '').toUpperCase() === wanted);
    }
    if (/readonly\.deactivated==false/i.test(rql)) rows = rows.filter((r) => r.readOnly?.deactivated !== true);
    return { status: 200, body: { totalResults: rows.length, _embedded: { [key]: rows } } };
  });
}

/** Auth + customers + facilities + items: the reads almost every adapter call makes. */
export function baseRoutes(): Route[] {
  return [tokenRoute(), customersRoute(), facilitiesRoute(), itemsRoute()];
}

export function halCollection(rel: string, rows: unknown[], total = rows.length): unknown {
  return { totalResults: total, _embedded: { [rel]: rows } };
}

export function createFakeApi(routes: Route[]): FakeApi {
  const calls: Ctx[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) raw.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(raw)) for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v);
      else for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    let body: unknown;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const ctx: Ctx = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, url, query: url.searchParams, headers, body };
    calls.push(ctx);
    for (const r of routes) {
      const res = r(ctx);
      if (res) {
        const has = res.body !== undefined;
        return new Response(has ? JSON.stringify(res.body) : null, {
          status: res.status,
          headers: { ...(has ? { 'content-type': 'application/hal+json' } : {}), ...(res.headers ?? {}) },
        });
      }
    }
    // Unmatched: the documented 404 shape, so the adapter's 404 handling is exercised.
    return new Response(JSON.stringify({ $type: 'WMS.V2.Generic.Models.Exceptions.WmsException, WMS.V2.Generic.Models', ErrorCode: 'DoesNotExist', Hint: `no route for ${ctx.method} ${ctx.path}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

export function testConfig(over: Partial<Record<string, string>> = {}): ExtensivConfig {
  return ExtensivConfigSchema.parse({
    baseUrl: 'https://secure-wms.test',
    clientId: 'cid-abcdef',
    clientSecret: 'shhh',
    userLogin: 'integration-user',
    ...over,
  });
}

/** Clock whose time the test advances explicitly, for the cache-TTL and token-margin tests. */
export class FakeClock {
  constructor(private ms = Date.parse('2026-09-16T12:00:00Z')) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}
