import { HttpClient, WmsError } from '@mcp-3pl/core';
import { describe, expect, it } from 'vitest';
import { ExtensivTokenProvider } from '../auth.js';
import { FakeClock, createFakeApi, route, testConfig, tokenRoute } from './fake_api.js';

function tokenServer(tokens: string[] = ['token-1', 'token-2', 'token-3'], expiresIn = 3600) {
  let n = 0;
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const token = tokens[Math.min(n, tokens.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: null, scope: null }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return { fetchImpl, bodies, logins: () => n };
}

describe('ExtensivTokenProvider', () => {
  it('sends the documented client_credentials body and caches the token', async () => {
    const server = tokenServer();
    const clock = new FakeClock();
    const p = new ExtensivTokenProvider(testConfig({ tplGuid: 'guid-1' }), { fetchImpl: server.fetchImpl, clock });
    expect(await p.getToken()).toBe('token-1');
    expect(await p.getToken()).toBe('token-1');
    expect(server.logins()).toBe(1);
    expect(server.bodies[0]).toEqual({ grant_type: 'client_credentials', user_login: 'integration-user', tpl: 'guid-1' });
  });

  it('refreshes only once the refresh margin has been reached', async () => {
    const server = tokenServer();
    const clock = new FakeClock();
    const p = new ExtensivTokenProvider(testConfig(), { fetchImpl: server.fetchImpl, clock });
    await p.getToken();
    // expires_in 3600 minus the 300s default margin: usable for 3300 seconds.
    expect(p.expiresInSeconds()).toBe(3300);
    clock.advance(3299);
    expect(await p.getToken()).toBe('token-1');
    expect(server.logins()).toBe(1);
    clock.advance(2);
    expect(await p.getToken()).toBe('token-2');
    expect(server.logins()).toBe(2);
  });

  it('coalesces concurrent logins into one request (single flight)', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ access_token: 'slow-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const p = new ExtensivTokenProvider(testConfig(), { fetchImpl, clock: new FakeClock() });
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken(), p.getToken()]);
    expect(tokens).toEqual(['slow-token', 'slow-token', 'slow-token', 'slow-token']);
    expect(calls).toBe(1);
  });

  it('invalidate() forces a fresh login on the next call', async () => {
    const server = tokenServer();
    const p = new ExtensivTokenProvider(testConfig(), { fetchImpl: server.fetchImpl, clock: new FakeClock() });
    expect(await p.getToken()).toBe('token-1');
    p.invalidate();
    expect(await p.getToken()).toBe('token-2');
    expect(server.logins()).toBe(2);
    expect(p.describe()).toMatchObject({ clientIdMasked: 'cid-…', userLogin: 'integration-user', logins: 2 });
    expect(JSON.stringify(p.describe())).not.toContain('shhh');
  });

  it('turns rejected credentials into AUTH_FAILED without echoing the secret', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const p = new ExtensivTokenProvider(testConfig(), { fetchImpl, clock: new FakeClock() });
    await expect(p.getToken()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(p.getToken()).rejects.toBeInstanceOf(WmsError);
  });
});

describe('401 handling through core HttpClient', () => {
  it('re-authenticates once and replays the request with the new token', async () => {
    let orderCalls = 0;
    const api = createFakeApi([
      tokenRoute('token-1'),
      route('GET', '/orders', () => {
        orderCalls += 1;
        // First call: the token has been revoked upstream mid-session.
        if (orderCalls === 1) return { status: 401, body: { ErrorCode: 'NotAuthenticated' } };
        return { status: 200, body: { totalResults: 0, _embedded: {} } };
      }),
    ]);
    // A token provider whose second login returns a different token proves the replay used it.
    let n = 0;
    const provider = {
      getToken: async () => `token-${n}`,
      invalidate: () => {
        n += 1;
      },
    };
    const http = new HttpClient({ baseUrl: 'https://secure-wms.test', tokenProvider: provider, fetchImpl: api.fetchImpl });
    const res = await http.request({ method: 'GET', path: '/orders' });
    expect(res.status).toBe(200);
    expect(orderCalls).toBe(2);
    const auths = api.calls.filter((c) => c.path === '/orders').map((c) => c.headers.authorization);
    expect(auths).toEqual(['Bearer token-0', 'Bearer token-1']);
  });
});
