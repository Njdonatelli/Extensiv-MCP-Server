import { describe, expect, it } from 'vitest';
import { createMockApp, DEFAULT_MOCK_CREDENTIALS as CREDS } from '../index.js';
import { basicHeader, harness } from './helpers.js';

const TOKEN_PATH = '/AuthServer/api/Token';

function tokenRequest(body: unknown, authorization = basicHeader()): RequestInit {
  return { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('POST /AuthServer/api/Token', () => {
  it('issues a bearer token for valid Basic credentials', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, tokenRequest({ grant_type: 'client_credentials', user_login: CREDS.userLogin }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.access_token).toBe('string');
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toBeNull();
    expect(body.scope).toBeNull();
  });

  it('accepts the documented tpl GUID', async () => {
    const { app } = createMockApp();
    const res = await app.request(
      TOKEN_PATH,
      tokenRequest({ grant_type: 'client_credentials', user_login: CREDS.userLogin, tpl: CREDS.tplGuid }),
    );
    expect(res.status).toBe(200);
  });

  it('tolerates the user_login_id spelling (GUESS: undocumented)', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, tokenRequest({ grant_type: 'client_credentials', user_login_id: CREDS.userLogin }));
    expect(res.status).toBe(200);
  });

  it('rejects a wrong client secret with 401 invalid_client', async () => {
    const { app } = createMockApp();
    const res = await app.request(
      TOKEN_PATH,
      tokenRequest({ grant_type: 'client_credentials', user_login: CREDS.userLogin }, basicHeader(CREDS.clientId, 'nope')),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid_client' });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'client_credentials', user_login: CREDS.userLogin }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong grant_type with 400 unsupported_grant_type', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, tokenRequest({ grant_type: 'password', user_login: CREDS.userLogin }));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('rejects an unknown user_login with 401', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, tokenRequest({ grant_type: 'client_credentials', user_login: 'somebody-else' }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing user_login with 400 invalid_request', async () => {
    const { app } = createMockApp();
    const res = await app.request(TOKEN_PATH, tokenRequest({ grant_type: 'client_credentials' }));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid_request' });
  });
});

describe('bearer middleware', () => {
  it('401s with an empty body when the header is missing', async () => {
    const { app } = createMockApp();
    const res = await app.request('/orders');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('401s on a malformed or unknown token', async () => {
    const { app } = createMockApp();
    expect((await app.request('/orders', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect((await app.request('/orders', { headers: { Authorization: 'Bearer not-a-real-token' } })).status).toBe(401);
    expect((await app.request('/orders', { headers: { Authorization: 'Bearer' } })).status).toBe(401);
  });

  it('401s once the token has outlived tokenTtlSeconds', async () => {
    let offsetMs = 0;
    const h = await harness({ tokenTtlSeconds: 60, now: () => new Date(Date.now() + offsetMs) });
    expect((await h.get('/orders?pgsiz=1')).status).toBe(200);
    offsetMs = 61_000;
    expect((await h.get('/orders?pgsiz=1')).status).toBe(401);
  });

  it('401s after /__mock/faults expireAllTokens', async () => {
    const h = await harness();
    expect((await h.get('/orders?pgsiz=1')).status).toBe(200);
    expect((await h.control('/__mock/faults', 'POST', { expireAllTokens: true })).status).toBe(200);
    expect((await h.get('/orders?pgsiz=1')).status).toBe(401);
  });

  it('leaves the control plane and the token endpoint unauthenticated', async () => {
    const { app } = createMockApp();
    expect((await app.request('/__mock/state')).status).toBe(200);
    expect((await app.request('/__mock/requests')).status).toBe(200);
  });
});
