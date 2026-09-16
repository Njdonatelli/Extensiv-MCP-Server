/**
 * OAuth2 client_credentials token endpoint.
 * SOURCE: https://3w.extensiv.com/Rels/auth and
 * https://help.extensiv.com/en_US/rest-api/providing-rest-api-access —
 *   POST https://secure-wms.com/AuthServer/api/Token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   Content-Type: application/json; charset=utf-8
 *   { "grant_type": "client_credentials", "user_login": "guysmiley" }   (+ "tpl" for dynamic creds)
 * → 200 { access_token, token_type: "Bearer", expires_in, refresh_token: null, scope: null }
 */
import { Hono } from 'hono';
import type { MockEnv } from '../env.js';
import type { TokenResponse } from '../models.js';
import type { MockState } from '../state.js';
import { jsonBody, TOKEN_PATH } from './common.js';

const JSON_CT = 'application/json; charset=utf-8';

function oauthError(status: number, error: string, description?: string): Response {
  // GUESS: the failure bodies are not documented anywhere. RFC 6749 §5.2 shapes them
  // ({"error":"invalid_client"} with 401, {"error":"unsupported_grant_type"} with 400) and the real
  // endpoint is an OAuth2 authorisation server, so the mock emits the RFC bodies.
  const body: Record<string, string> = { error };
  if (description !== undefined) body.error_description = description;
  return new Response(JSON.stringify(body), { status: status as 400, headers: { 'Content-Type': JSON_CT } });
}

function parseBasic(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (header === undefined) return null;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] as string, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function authRoutes(state: MockState): Hono<MockEnv> {
  const app = new Hono<MockEnv>();

  app.post(TOKEN_PATH, async (c) => {
    const creds = parseBasic(c.req.header('Authorization'));
    const expected = state.options.credentials;
    if (!creds || creds.clientId !== expected.clientId || creds.clientSecret !== expected.clientSecret) {
      return oauthError(401, 'invalid_client', 'Basic credentials are missing or do not match');
    }

    const body = await jsonBody(c);
    const grantType = stringField(body, 'grant_type');
    if (grantType !== 'client_credentials') {
      return oauthError(400, 'unsupported_grant_type', 'Only client_credentials is supported');
    }

    // SOURCE: Rels/auth — the body field is `user_login`.
    // GUESS: `user_login_id` appears in neither source; the mock tolerates it because several
    // community samples use that spelling and rejecting it would be a mock-only failure mode.
    const userLogin = stringField(body, 'user_login') ?? stringField(body, 'user_login_id');
    if (userLogin === undefined) {
      // GUESS: a missing user_login is undocumented; RFC 6749 calls this invalid_request.
      return oauthError(400, 'invalid_request', 'user_login is required');
    }
    if (userLogin !== expected.userLogin) {
      // GUESS: the real server presumably rejects an unknown user_login; invalid_client is the closest RFC code.
      return oauthError(401, 'invalid_client', 'user_login is not associated with these credentials');
    }

    // SOURCE: Rels/auth — `tpl` (3PL GUID) is required only for Single-Tenant dynamic credentials.
    const tpl = stringField(body, 'tpl');
    if (tpl !== undefined && expected.tplGuid !== undefined && tpl.toLowerCase() !== expected.tplGuid.toLowerCase()) {
      // GUESS: a wrong tpl GUID is undocumented.
      return oauthError(400, 'invalid_request', 'tpl does not match the 3PL for these credentials');
    }

    const rec = state.issueToken(userLogin);
    const payload: TokenResponse = {
      access_token: rec.token,
      token_type: 'Bearer',
      expires_in: state.options.tokenTtlSeconds,
      refresh_token: null,
      scope: null,
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': JSON_CT } });
  });

  return app;
}
