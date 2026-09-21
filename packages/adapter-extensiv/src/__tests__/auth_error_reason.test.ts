/**
 * Fidelity of the AUTH_FAILED message when the token endpoint rejects a login.
 * Production answers 401 with an ASP.NET `Message` body (live probe, 2026-09-21);
 * the sandbox answers with the RFC 6749 `error`/`error_description` pair.
 */
import { WmsError } from '@mcp-3pl/core';
import type { Logger } from '@mcp-3pl/core';
import { describe, expect, it } from 'vitest';
import { ExtensivTokenProvider } from '../auth.js';
import { FakeClock, testConfig } from './fake_api.js';

interface Captured {
  logger: Logger;
  warns: { msg: string; meta?: Record<string, unknown> }[];
}

function captureLogger(): Captured {
  const warns: { msg: string; meta?: Record<string, unknown> }[] = [];
  const noop = (): void => undefined;
  const logger: Logger = {
    error: noop,
    warn: (msg, meta) => {
      warns.push({ msg, ...(meta ? { meta } : {}) });
    },
    info: noop,
    debug: noop,
    child: () => logger,
  };
  return { logger, warns };
}

function rejectingFetch(status: number, body: string, contentType = 'application/json'): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': contentType } });
}

async function reject(status: number, body: string, over: Partial<Record<string, string>> = {}, contentType?: string) {
  const cap = captureLogger();
  const p = new ExtensivTokenProvider(testConfig(over), {
    fetchImpl: rejectingFetch(status, body, contentType),
    clock: new FakeClock(),
    logger: cap.logger,
  });
  const err = await p.getToken().then(
    () => undefined,
    (e: unknown) => e as WmsError,
  );
  expect(err).toBeInstanceOf(WmsError);
  return { err: err as WmsError, warns: cap.warns };
}

describe('login rejection reason', () => {
  it('surfaces the ASP.NET Message field the production endpoint returns on 401', async () => {
    const { err, warns } = await reject(401, JSON.stringify({ Message: 'invalid_client: client not registered' }));
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toBe('Extensiv rejected the API credentials (HTTP 401, invalid_client: client not registered).');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('extensiv login rejected');
    expect(warns[0]?.meta).toEqual({ status: 401, reason: 'invalid_client: client not registered' });
  });

  it('folds the OAuth2 error and error_description pair the sandbox returns', async () => {
    const { err } = await reject(400, JSON.stringify({ error: 'unsupported_grant_type', error_description: 'Only client_credentials is supported' }));
    expect(err.message).toContain('unsupported_grant_type: Only client_credentials is supported');
  });

  it('accepts an error code on its own and an error_description on its own', async () => {
    const onlyCode = await reject(401, JSON.stringify({ error: 'invalid_client' }));
    expect(onlyCode.err.message).toBe('Extensiv rejected the API credentials (HTTP 401, invalid_client).');
    const onlyDescription = await reject(401, JSON.stringify({ error_description: 'credential is disabled' }));
    expect(onlyDescription.err.message).toContain('credential is disabled');
  });

  it('reads a non-JSON body as the reason', async () => {
    const { err, warns } = await reject(401, 'Authorization has been denied for this request.', {}, 'text/html');
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toContain('Authorization has been denied for this request.');
    expect(warns[0]?.meta).toMatchObject({ reason: 'Authorization has been denied for this request.' });
  });

  it('keeps the bare message when the body carries no reason at all', async () => {
    const empty = await reject(401, '');
    expect(empty.err.message).toBe('Extensiv rejected the API credentials (HTTP 401).');
    expect(empty.warns[0]?.meta).toEqual({ status: 401, reason: '' });
    const unknownShape = await reject(400, JSON.stringify({ somethingElse: 'x' }));
    expect(unknownShape.err.message).toBe('Extensiv rejected the API credentials (HTTP 400).');
  });

  it('never lets a body that echoes the credential leak it into the message or the log', async () => {
    const secret = 'super-secret-value-0123456789';
    const clientId = 'cid-abcdef';
    const basic = Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64');
    const { err, warns } = await reject(401, JSON.stringify({ Message: `bad secret ${secret} (Basic ${basic})` }), { clientId, clientSecret: secret });
    const serialized = JSON.stringify({ message: err.message, details: err.details, warns });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(basic);
    expect(err.message).toContain('<redacted>');
    // The hint and the masked client id are still there for the operator.
    expect(err.details).toMatchObject({ status: 401, clientIdMasked: 'cid-…' });
  });

  it('bounds the reason and flattens the line breaks an HTML error page brings', async () => {
    const long = 'x'.repeat(500);
    const { err, warns } = await reject(401, JSON.stringify({ Message: long }));
    const reason = String((warns[0]?.meta as { reason?: unknown } | undefined)?.reason ?? '');
    expect(reason.length).toBeLessThanOrEqual(161);
    expect(err.message.length).toBeLessThan(260);

    const multiline = await reject(401, JSON.stringify({ Message: 'invalid_client\n\tclient not registered\r\n' }));
    expect(multiline.err.message).toBe('Extensiv rejected the API credentials (HTTP 401, invalid_client client not registered).');
  });

  it('still classifies rejection as AUTH_FAILED and does not retry it', async () => {
    const { err } = await reject(401, JSON.stringify({ Message: 'invalid_client: client not registered' }));
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.hint).toContain('EXTENSIV_CLIENT_SECRET');
  });
});
