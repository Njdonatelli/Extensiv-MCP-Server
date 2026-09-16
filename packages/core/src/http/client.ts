import { WmsError } from '../errors.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

/**
 * Adapter-provided bearer token source. `invalidate` is called by the client
 * when the upstream answers 401 so the next `getToken` performs a fresh login.
 */
export interface TokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Safe to retry on network failure / 5xx. Defaults to true for GET, false otherwise. */
  idempotent?: boolean;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  etag?: string;
  /** Wall-clock time spent including retries. */
  durationMs: number;
}

export class UpstreamHttpError extends WmsError {
  readonly status: number;
  readonly body: unknown;
  readonly request: { method: string; path: string };

  constructor(status: number, body: unknown, request: { method: string; path: string }, message?: string) {
    super(status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR', message ?? `Upstream responded ${status} to ${request.method} ${request.path}`, {
      retryable: status === 429 || status >= 500,
      details: { status, body: truncate(body) },
    });
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.body = body;
    this.request = request;
  }
}

function truncate(body: unknown): unknown {
  if (typeof body === 'string') return body.length > 2000 ? body.slice(0, 2000) + '…' : body;
  return body;
}

export interface HttpClientOptions {
  baseUrl: string;
  tokenProvider: TokenProvider;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** Max retries for 429 / 5xx / network errors on idempotent requests. */
  maxRetries?: number;
  /** Upper bound for a single Retry-After wait; longer values fail fast with RATE_LIMITED. */
  maxRetryAfterMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal, dependency-free HTTP client with the behaviours every WMS adapter
 * needs and no adapter should re-implement:
 *  - bearer injection with one forced re-auth + retry on 401 (token expired mid-call)
 *  - 429 honouring Retry-After with a cap
 *  - bounded exponential backoff on 5xx / network errors, only for idempotent requests
 *  - OUTCOME_UNKNOWN when a non-idempotent request fails after it may have been applied
 *  - ETag capture
 */
export class HttpClient {
  private readonly opts: Required<Pick<HttpClientOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryAfterMs'>> & HttpClientOptions;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpClientOptions) {
    this.opts = { timeoutMs: 30_000, maxRetries: 3, maxRetryAfterMs: 30_000, ...opts };
    this.log = opts.logger ?? silentLogger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  buildUrl(path: string, query?: HttpRequest['query']): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const url = new URL(base + (path.startsWith('/') ? path : '/' + path));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const started = Date.now();
    const idempotent = req.idempotent ?? req.method === 'GET';
    const url = this.buildUrl(req.path, req.query);
    let reauthed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const token = await this.opts.tokenProvider.getToken();
      const headers: Record<string, string> = {
        Accept: 'application/hal+json',
        ...(req.body !== undefined ? { 'Content-Type': 'application/hal+json; charset=utf-8' } : {}),
        ...this.opts.defaultHeaders,
        ...req.headers,
        Authorization: `Bearer ${token}`,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.opts.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: req.method,
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        this.log.warn('http network error', { method: req.method, path: req.path, attempt, err: String(err) });
        if (!idempotent) {
          throw new WmsError('OUTCOME_UNKNOWN', `${req.method} ${req.path} failed before a response was received; the write may or may not have been applied.`, {
            hint: 'Do not blindly retry. Look the resource up by its natural key (reference number) before deciding.',
            retryable: false,
            cause: err,
          });
        }
        if (attempt > this.opts.maxRetries) {
          throw new WmsError('UPSTREAM_UNAVAILABLE', `${req.method} ${req.path} failed after ${attempt} attempts: ${String(err)}`, { retryable: true, cause: err });
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }
      clearTimeout(timer);

      if (res.status === 401 && !reauthed) {
        // Token expired or was revoked mid-call: force one fresh login and replay the request.
        reauthed = true;
        this.log.info('http 401, refreshing token once', { method: req.method, path: req.path });
        this.opts.tokenProvider.invalidate();
        continue;
      }
      if (res.status === 401) {
        throw new WmsError('AUTH_FAILED', 'Upstream rejected the credentials even after a fresh token was obtained.', {
          hint: 'Check EXTENSIV_CLIENT_ID / EXTENSIV_CLIENT_SECRET / EXTENSIV_USER_LOGIN and that the credential is enabled in the Support Portal.',
        });
      }
      if (res.status === 429 || (res.status >= 500 && idempotent)) {
        if (attempt > this.opts.maxRetries) {
          throw new UpstreamHttpError(res.status, await readBody(res), { method: req.method, path: req.path });
        }
        const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after'), attempt) : backoffMs(attempt);
        if (wait > this.opts.maxRetryAfterMs) {
          throw new UpstreamHttpError(res.status, await readBody(res), { method: req.method, path: req.path }, `Upstream asked to wait ${Math.round(wait / 1000)}s (429); giving up rather than blocking.`);
        }
        this.log.warn('http retryable status', { status: res.status, waitMs: wait, attempt, path: req.path });
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(wait);
        continue;
      }

      const body = (await readBody(res)) as T;
      if (!res.ok) {
        throw new UpstreamHttpError(res.status, body, { method: req.method, path: req.path });
      }
      return {
        status: res.status,
        headers: res.headers,
        body,
        etag: res.headers.get('etag') ?? undefined,
        durationMs: Date.now() - started,
      };
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 250 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 100);
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (!header) return backoffMs(attempt);
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return backoffMs(attempt);
}
