import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import type { Logger } from '@mcp-3pl/core';

/**
 * Extensiv signs each delivery with RSA-SHA256 over the raw body and sends the
 * base64 signature in the `Signature` header. The public key is published at
 * GET {base}/events/webhook/key -> { publicKey, retrievalDateISO }.
 * SOURCE: https://help.extensiv.com/en_US/rest-api/implementing-webhooks
 * On verification failure the key is re-fetched once, because the article says
 * rotation is handled by re-fetching.
 */
export interface KeySource {
  getKey(force?: boolean): Promise<KeyObject>;
}

export class PinnedKeySource implements KeySource {
  private readonly key: KeyObject;
  constructor(pem: string) {
    this.key = createPublicKey(pem);
  }
  async getKey(): Promise<KeyObject> {
    return this.key;
  }
}

export class RemoteKeySource implements KeySource {
  private cached: { key: KeyObject; fetchedAt: number; retrievalDateISO?: string } | undefined;
  private inflight: Promise<KeyObject> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly cacheMs: number,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getKey(force = false): Promise<KeyObject> {
    if (!force && this.cached && Date.now() - this.cached.fetchedAt < this.cacheMs) return this.cached.key;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchKey().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async fetchKey(): Promise<KeyObject> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/events/webhook/key`;
    // GUESS: the article shows the key endpoint without an Authorization header; if the real endpoint
    // requires a bearer token this will surface as a 401 in the log and needs credentials wired in.
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`key endpoint ${url} responded ${res.status}`);
    const body = (await res.json()) as { publicKey?: string; retrievalDateISO?: string };
    if (!body.publicKey) throw new Error(`key endpoint ${url} returned no publicKey`);
    const key = createPublicKey(normalizePem(body.publicKey));
    this.cached = { key, fetchedAt: Date.now(), retrievalDateISO: body.retrievalDateISO };
    this.log.info('webhook public key loaded', { url, retrievalDateISO: body.retrievalDateISO });
    return key;
  }
}

/** Accepts a full PEM, or a bare base64 SPKI body (the article's sample wraps it as spki). */
export function normalizePem(value: string): string {
  const v = value.trim();
  if (v.includes('-----BEGIN')) return v;
  const lines = v.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export function verifyOnce(key: KeyObject, rawBody: Buffer, signatureB64: string): boolean {
  try {
    const verifier = createVerify('SHA256');
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export async function verifySignature(source: KeySource, rawBody: Buffer, signatureB64: string | undefined): Promise<'valid' | 'invalid' | 'missing'> {
  if (!signatureB64) return 'missing';
  const key = await source.getKey();
  if (verifyOnce(key, rawBody, signatureB64)) return 'valid';
  // Key may have rotated: fetch fresh and try once more.
  const fresh = await source.getKey(true);
  return verifyOnce(fresh, rawBody, signatureB64) ? 'valid' : 'invalid';
}
