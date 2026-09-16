import { describe, expect, it } from 'vitest';
import { HttpClient, type TokenProvider } from '../http/client.js';

function makeFetch(script: { status: number; body?: unknown; headers?: Record<string, string> }[], calls: { url: string; auth: string | null; method: string }[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const next = script.shift();
    if (!next) throw new Error('no scripted response');
    const headers = new Headers(init?.headers as Record<string, string>);
    calls.push({ url: String(input), auth: headers.get('authorization'), method: init?.method ?? 'GET' });
    if (next.status === -1) throw new TypeError('fetch failed');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/hal+json', ...(next.headers ?? {}) } });
  }) as typeof fetch;
}

function tokens(): TokenProvider & { logins: number } {
  let n = 0;
  let current: string | undefined;
  return {
    logins: 0,
    async getToken() {
      if (!current) {
        n += 1;
        this.logins = n;
        current = `tok${n}`;
      }
      return current;
    },
    invalidate() {
      current = undefined;
    },
  };
}

describe('HttpClient', () => {
  it('re-authenticates once on 401 and replays the request', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const tp = tokens();
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tp, fetchImpl: makeFetch([{ status: 401 }, { status: 200, body: { ok: true }, headers: { etag: '"7"' } }], calls), sleep: async () => {} });
    const res = await client.request<{ ok: boolean }>({ method: 'GET', path: '/orders/1' });
    expect(res.body.ok).toBe(true);
    expect(res.etag).toBe('"7"');
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok1', 'Bearer tok2']);
    expect(tp.logins).toBe(2);
  });

  it('fails with AUTH_FAILED when the second attempt is also 401', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tokens(), fetchImpl: makeFetch([{ status: 401 }, { status: 401 }], calls), sleep: async () => {} });
    await expect(client.request({ method: 'GET', path: '/orders' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(2);
  });

  it('honours Retry-After on 429 then succeeds', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const waits: number[] = [];
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tokens(), fetchImpl: makeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: [] }], calls), sleep: async (ms) => { waits.push(ms); } });
    const res = await client.request({ method: 'GET', path: '/orders' });
    expect(res.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  it('gives up on 429 when Retry-After exceeds the cap', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tokens(), maxRetryAfterMs: 1000, fetchImpl: makeFetch([{ status: 429, headers: { 'retry-after': '120' } }], calls), sleep: async () => {} });
    await expect(client.request({ method: 'GET', path: '/orders' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('retries idempotent requests on network failure but reports OUTCOME_UNKNOWN for writes', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tokens(), fetchImpl: makeFetch([{ status: -1 }, { status: 200, body: {} }, { status: -1 }], calls), sleep: async () => {} });
    const ok = await client.request({ method: 'GET', path: '/a' });
    expect(ok.status).toBe(200);
    await expect(client.request({ method: 'POST', path: '/orders', body: {} })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 5xx on non-idempotent requests and surfaces the body', async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const client = new HttpClient({ baseUrl: 'http://x', tokenProvider: tokens(), fetchImpl: makeFetch([{ status: 500, body: 'boom' }], calls), sleep: async () => {} });
    await expect(client.request({ method: 'POST', path: '/orders', body: {} })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 500 });
    expect(calls).toHaveLength(1);
  });

  it('builds URLs with query params and joins paths', async () => {
    const client = new HttpClient({ baseUrl: 'http://x/', tokenProvider: tokens(), fetchImpl: makeFetch([], []) });
    expect(client.buildUrl('/orders', { pgsiz: 10, rql: 'a==b;c==d', skip: undefined })).toBe('http://x/orders?pgsiz=10&rql=a%3D%3Db%3Bc%3D%3Dd');
  });
});
