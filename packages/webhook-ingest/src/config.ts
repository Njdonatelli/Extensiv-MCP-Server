import * as z from 'zod/v4';

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

export const IngestConfigSchema = z.object({
  /** Same base URL the MCP server uses; the signing public key is fetched from `${baseUrl}/events/webhook/key`. */
  baseUrl: z.string().url().default('https://secure-wms.com'),
  port: z.coerce.number().int().positive().default(4020),
  host: z.string().default('0.0.0.0'),
  path: z.string().default('/webhooks/extensiv'),
  eventsFile: z.string().default('.state/events.jsonl'),
  /** Reject deliveries whose Signature does not verify (default). */
  requireSignature: bool.default(true),
  /** When signature is not required, still record verified=false so readers can tell. */
  storeUnverified: bool.default(false),
  /** Pin a PEM public key instead of fetching it (offline or key-rotation drills). */
  publicKeyPem: z.string().optional(),
  /** Optional shared bearer token a reverse proxy/tunnel may add; checked on top of the signature. */
  ingressToken: z.string().optional(),
  keyCacheSeconds: z.coerce.number().int().positive().default(3600),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type IngestConfig = z.infer<typeof IngestConfigSchema>;

export const INGEST_ENV_KEYS = {
  baseUrl: 'EXTENSIV_BASE_URL',
  port: 'EXTENSIV_WEBHOOK_PORT',
  host: 'EXTENSIV_WEBHOOK_HOST',
  path: 'EXTENSIV_WEBHOOK_PATH',
  eventsFile: 'EXTENSIV_MCP_EVENTS_FILE',
  requireSignature: 'EXTENSIV_WEBHOOK_REQUIRE_SIGNATURE',
  storeUnverified: 'EXTENSIV_WEBHOOK_STORE_UNVERIFIED',
  publicKeyPem: 'EXTENSIV_WEBHOOK_PUBLIC_KEY_PEM',
  ingressToken: 'EXTENSIV_WEBHOOK_INGRESS_TOKEN',
  keyCacheSeconds: 'EXTENSIV_WEBHOOK_KEY_CACHE_SECONDS',
  logLevel: 'EXTENSIV_MCP_LOG_LEVEL',
} as const satisfies Record<keyof IngestConfig, string>;

export function loadIngestConfig(env: Record<string, string | undefined> = process.env): IngestConfig {
  const raw: Record<string, string> = {};
  for (const [k, name] of Object.entries(INGEST_ENV_KEYS)) {
    const v = env[name];
    if (v !== undefined && v !== '') raw[k] = v;
  }
  if (raw.eventsFile === undefined && env.EXTENSIV_MCP_STATE_DIR) raw.eventsFile = `${env.EXTENSIV_MCP_STATE_DIR.replace(/\/+$/, '')}/events.jsonl`;
  const parsed = IngestConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid webhook-ingest configuration: ' + parsed.error.issues.map((i) => `${INGEST_ENV_KEYS[i.path[0] as keyof IngestConfig]}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
