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

export type ExtensivAuthConfig = Pick<ExtensivConfig, 'authUrl' | 'clientId' | 'clientSecret' | 'userLogin' | 'tplGuid' | 'tokenRefreshMarginSeconds' | 'httpTimeoutMs'>;

export interface ExtensivTokenProviderDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
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
      // The auth server answers 400 (invalid_client / invalid_grant) or 401 for bad credentials.
      // Only the error code is surfaced; the body could echo the user_login but never the secret,
      // and we still avoid forwarding it verbatim.
      const code = typeof parsed === 'object' && parsed !== null ? String((parsed as { error?: unknown }).error ?? '') : '';
      this.log.warn('extensiv login rejected', { status: res.status, error: code });
      throw new WmsError('AUTH_FAILED', `Extensiv rejected the API credentials (HTTP ${res.status}${code ? `, ${code}` : ''}).`, {
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
