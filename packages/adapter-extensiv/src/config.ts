import * as z from 'zod/v4';

/**
 * Adapter configuration, read from the same env as the core config.
 *
 * Credential model (SOURCE https://3w.extensiv.com/Rels/auth ;
 * https://help.extensiv.com/en_US/rest-api/providing-rest-api-access):
 * OAuth2 client_credentials with HTTP BASIC (clientId:clientSecret) against
 * `POST {base}/AuthServer/api/Token`, body `{ grant_type, user_login, tpl? }`.
 * `tpl` (a 3PL GUID) is only required for "Single-Tenant dynamic" credentials.
 */
export const EXTENSIV_ENV_KEYS = {
  baseUrl: 'EXTENSIV_BASE_URL',
  authUrl: 'EXTENSIV_AUTH_URL',
  clientId: 'EXTENSIV_CLIENT_ID',
  clientSecret: 'EXTENSIV_CLIENT_SECRET',
  userLogin: 'EXTENSIV_USER_LOGIN',
  tplGuid: 'EXTENSIV_TPL_GUID',
  tokenRefreshMarginSeconds: 'EXTENSIV_TOKEN_REFRESH_MARGIN_SECONDS',
  httpTimeoutMs: 'EXTENSIV_HTTP_TIMEOUT_MS',
  maxRetries: 'EXTENSIV_MAX_RETRIES',
  environmentLabel: 'EXTENSIV_MCP_ENVIRONMENT_LABEL',
} as const;

const REQUIRED_KEYS = ['clientId', 'clientSecret', 'userLogin'] as const;

const RawSchema = z.object({
  // SOURCE https://help.extensiv.com/en_US/rest-api (base API URL is https://secure-wms.com).
  baseUrl: z.string().url().default('https://secure-wms.com'),
  authUrl: z.string().url().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  userLogin: z.string().min(1),
  tplGuid: z.string().min(1).optional(),
  /** Refresh the token this many seconds before `expires_in` elapses (help center: tokens last 30-60 min). */
  tokenRefreshMarginSeconds: z.coerce.number().int().nonnegative().default(300),
  httpTimeoutMs: z.coerce.number().int().positive().default(30_000),
  maxRetries: z.coerce.number().int().nonnegative().default(3),
  environmentLabel: z.string().min(1).optional(),
});

export const ExtensivConfigSchema = RawSchema.transform((raw) => ({
  ...raw,
  baseUrl: raw.baseUrl.replace(/\/+$/, ''),
  // SOURCE https://3w.extensiv.com/Rels/auth: the token endpoint lives under the API host.
  authUrl: raw.authUrl ?? `${raw.baseUrl.replace(/\/+$/, '')}/AuthServer/api/Token`,
  environmentLabel: raw.environmentLabel ?? detectEnvironmentLabel(raw.baseUrl),
}));

export type ExtensivConfig = z.infer<typeof ExtensivConfigSchema>;

/**
 * Label surfaced to the model on every write preview so an operator can tell
 * production from a sandbox or the local mock at a glance.
 * Hosts: production `secure-wms.com` (help center); legacy sandbox UI
 * `box.secure-wms.com` (research notes §1, sandbox API host is INFERRED).
 */
export function detectEnvironmentLabel(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl;
  }
  if (host === 'secure-wms.com' || host === 'www.secure-wms.com') return 'production';
  if (host === 'box.secure-wms.com') return 'sandbox (legacy box)';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'mock (local)';
  return host;
}

/**
 * Loads and validates adapter config from env. Error messages name the env
 * var and never echo a value, because the value may be a secret.
 */
export function loadExtensivConfig(env: Record<string, string | undefined> = process.env): ExtensivConfig {
  const raw: Record<string, string> = {};
  for (const [key, envName] of Object.entries(EXTENSIV_ENV_KEYS)) {
    const v = env[envName];
    if (v !== undefined && v.trim() !== '') raw[key] = v.trim();
  }
  const missing = REQUIRED_KEYS.filter((k) => raw[k] === undefined).map((k) => EXTENSIV_ENV_KEYS[k]);
  if (missing.length) {
    throw new Error(`Missing required Extensiv configuration: ${missing.join(', ')}. Set them in the environment (see README).`);
  }
  const parsed = ExtensivConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${EXTENSIV_ENV_KEYS[i.path[0] as keyof typeof EXTENSIV_ENV_KEYS] ?? String(i.path[0])}: ${i.message}`);
    throw new Error(`Invalid Extensiv configuration: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** First 4 characters then an ellipsis; enough to tell credentials apart without exposing them. */
export function maskClientId(clientId: string): string {
  return clientId.length <= 4 ? `${clientId.slice(0, 1)}…` : `${clientId.slice(0, 4)}…`;
}
