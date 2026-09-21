import { WmsError, systemClock, silentLogger } from '@mcp-3pl/core';
import type { Clock, Logger, TokenProvider } from '@mcp-3pl/core';
import { maskClientId } from './config.js';
import type { ExtensivConfig } from './config.js';

/** Success body of the token endpoint (SOURCE https://3w.extensiv.com/Rels/auth). */
interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string | null;
  scope?: string | null;
}

/**
 * Rejection body of the token endpoint. Two shapes exist in the wild, so both are read:
 * the ASP.NET `Message` string production returns, and the RFC 6749 §5.2
 * `error`/`error_description` pair the sandbox emits.
 */
interface TokenErrorResponse {
  Message?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export type ExtensivAuthConfig = Pick<ExtensivConfig, 'authUrl' | 'clientId' | 'clientSecret' | 'userLogin' | 'tplGuid' | 'tokenRefreshMarginSeconds' | 'httpTimeoutMs'>;

export interface ExtensivTokenProviderDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
}

/** A rejection reason is upstream text on a model-visible message, so it stays short enough to read at a glance. */
const REASON_MAX_CHARS = 160;

/** Prefers the ASP.NET field production uses, then the OAuth2 pair; a non-JSON body arrives here as its raw text. */
function extractReason(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed !== 'object' || parsed === null) return '';
  const body = parsed as TokenErrorResponse;
  if (typeof body.Message === 'string' && body.Message !== '') return body.Message;
  const error = typeof body.error === 'string' ? body.error : '';
  const description = typeof body.error_description === 'string' ? body.error_description : '';
  if (error && description) return `${error}: ${description}`;
  return error || description;
}

/**
 * The reason is attacker-influenceable text from a body we did not write: a secret it echoes
 * must not reach a message or a log line, and control characters must not break the one-line
 * JSON log format.
 */
function sanitizeReason(raw: string, forbidden: readonly string[]): string {
  let out = raw;
  for (const needle of forbidden) {
    if (needle.length > 0 && out.includes(needle)) out = out.split(needle).join('<redacted>');
  }
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return out.length > REASON_MAX_CHARS ? `${out.slice(0, REASON_MAX_CHARS)}…` : out;
}

const AUTH_HINT =
  'Check EXTENSIV_CLIENT_ID / EXTENSIV_CLIENT_SECRET / EXTENSIV_USER_LOGIN (and EXTENSIV_TPL_GUID for single-tenant dynamic credentials) and that the credential is enabled in the Extensiv Support Portal.';

/**
 * OAuth2 client_credentials token source for Extensiv 3PL Warehouse Manager.
 *
 * Wire format (SOURCE https://3w.extensiv.com/Rels/auth):
 *   POST {authUrl}
 *   Authorization: Basic base64(clientId:clientSecret)
 *   Content-Type: application/json; charset=utf-8
 *   Accept: application/json
 *   { "grant_type": "client_credentials", "user_login": "...", "tpl": "<guid>"? }
 *   -> 200 { access_token, token_type: "Bearer", expires_in: 3600, ... }
 *   -> 401 { "Message": "invalid_client: ..." } in production; see login() for the citation.
 *
 * Behaviour: the token is cached until `expires_in - margin`; concurrent
 * callers share one in-flight login (single-flight) so a burst of requests
 * after expiry does not stampede the auth server; `invalidate()` drops the
 * cache (HttpClient calls it on 401 before retrying once).
 */
export class ExtensivTokenProvider implements TokenProvider {
  private readonly cfg: ExtensivAuthConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly log: Logger;
  private cached: { token: string; expiresAtMs: number } | undefined;
  private inFlight: Promise<string> | undefined;
  /** Counts successful logins; useful for diagnostics and tests. */
  private logins = 0;

  constructor(cfg: ExtensivAuthConfig, deps: ExtensivTokenProviderDeps = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.logger ?? silentLogger;
  }

  async getToken(): Promise<string> {
    const now = this.clock.now().getTime();
    if (this.cached && now < this.cached.expiresAtMs) return this.cached.token;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.login().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** Seconds until the cached token is considered expired (after the margin); undefined when no token is cached. */
  expiresInSeconds(): number | undefined {
    if (!this.cached) return undefined;
    return Math.max(0, Math.round((this.cached.expiresAtMs - this.clock.now().getTime()) / 1000));
  }

  /** Model-visible description; the client id is masked and the secret never appears. */
  describe(): { clientIdMasked: string; userLogin: string; tplGuid?: string; authUrl: string; logins: number } {
    return {
      clientIdMasked: maskClientId(this.cfg.clientId),
      userLogin: this.cfg.userLogin,
      ...(this.cfg.tplGuid ? { tplGuid: this.cfg.tplGuid } : {}),
      authUrl: this.cfg.authUrl,
      logins: this.logins,
    };
  }

  private async login(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`, 'utf8').toString('base64');
    const body: Record<string, string> = { grant_type: 'client_credentials', user_login: this.cfg.userLogin };
    if (this.cfg.tplGuid) body.tpl = this.cfg.tplGuid;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.httpTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.authUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new WmsError('UPSTREAM_UNAVAILABLE', `Could not reach the Extensiv auth server at ${this.cfg.authUrl}: ${String(err)}`, {
        retryable: true,
        hint: 'Check EXTENSIV_BASE_URL / EXTENSIV_AUTH_URL and network access to the Extensiv API.',
        cause: err,
      });
    }
    clearTimeout(timer);

    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (res.status === 400 || res.status === 401) {
      // Production rejects with an ASP.NET body, not the OAuth2 one: a live probe of
      // POST https://secure-wms.com/AuthServer/api/Token on 2026-09-21 answered HTTP 401
      // {"Message":"invalid_client: client not registered"} (SOURCE: that probe — the failure
      // body is described on no doc page). The sandbox still emits 400/401 with
      // {"error","error_description"}, so whichever field is present is surfaced: telling
      // "client not registered" from a disabled credential or a bad user_login is the one
      // actionable detail here. Sanitised first — the body is upstream text.
      const reason = sanitizeReason(extractReason(parsed), [this.cfg.clientSecret, basic]);
      this.log.warn('extensiv login rejected', { status: res.status, reason });
      throw new WmsError('AUTH_FAILED', `Extensiv rejected the API credentials (HTTP ${res.status}${reason ? `, ${reason}` : ''}).`, {
        hint: AUTH_HINT,
        details: { status: res.status, clientIdMasked: maskClientId(this.cfg.clientId), userLogin: this.cfg.userLogin },
      });
    }
    if (!res.ok) {
      throw new WmsError(res.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR', `Extensiv auth server responded ${res.status}.`, {
        retryable: res.status >= 500 || res.status === 429,
        details: { status: res.status },
      });
    }
    const tok = parsed as TokenResponse | undefined;
    if (!tok || typeof tok.access_token !== 'string' || tok.access_token.length === 0) {
      throw new WmsError('UPSTREAM_ERROR', 'Extensiv auth server returned 200 without an access_token.', { details: { keys: tok ? Object.keys(tok) : [] } });
    }
    // expires_in is seconds (3600 in the documented example). Fall back to 30 minutes, the
    // lower bound the help center quotes, when the field is missing.
    const expiresIn = typeof tok.expires_in === 'number' && tok.expires_in > 0 ? tok.expires_in : 1800;
    const usable = Math.max(0, expiresIn - this.cfg.tokenRefreshMarginSeconds);
    this.cached = { token: tok.access_token, expiresAtMs: this.clock.now().getTime() + usable * 1000 };
    this.logins += 1;
    this.log.info('extensiv token obtained', { expiresIn, usableSeconds: usable, clientIdMasked: maskClientId(this.cfg.clientId) });
    return tok.access_token;
  }
}
