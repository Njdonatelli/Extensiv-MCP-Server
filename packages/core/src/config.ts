import * as z from 'zod/v4';

/**
 * Core configuration. Adapter-specific settings (credentials, base URL) are
 * loaded by the adapter from the same env object; the core only needs policy,
 * state locations and transport.
 */
const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const idList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s.length > 0));

export const CoreConfigSchema = z.object({
  /** Write tools are only registered when true. */
  writesEnabled: boolFromEnv.default(false),
  /** Customers readable through this server. Empty = every customer the credential can see. */
  allowedCustomerIds: idList.default([]),
  /** Facilities readable through this server. Empty = all. */
  allowedFacilityIds: idList.default([]),
  /** Customers writable through this server. Must be non-empty when writesEnabled; never implicit. */
  writeCustomerIds: idList.default([]),
  /** Facilities writable. Empty = any facility of a writable customer. */
  writeFacilityIds: idList.default([]),
  /** Where change records, audit log and events live. */
  stateDir: z.string().default('.state'),
  eventsFile: z.string().optional(),
  auditFile: z.string().optional(),
  changeTtlSeconds: z.coerce.number().int().positive().default(900),
  /** Hard cap on lines per created order/receipt as a blast-radius limit. */
  maxLinesPerMutation: z.coerce.number().int().positive().default(200),
  /** Hard cap on units per created order/receipt. */
  maxUnitsPerMutation: z.coerce.number().int().positive().default(10_000),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  httpPort: z.coerce.number().int().positive().default(3333),
  httpHost: z.string().default('127.0.0.1'),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  /** Label shown to the model in previews; adapters may override with their own detection. */
  environmentLabel: z.string().optional(),
});

export type CoreConfig = z.infer<typeof CoreConfigSchema>;

export const CORE_ENV_KEYS = {
  writesEnabled: 'EXTENSIV_MCP_WRITES_ENABLED',
  allowedCustomerIds: 'EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS',
  allowedFacilityIds: 'EXTENSIV_MCP_ALLOWED_FACILITY_IDS',
  writeCustomerIds: 'EXTENSIV_MCP_WRITE_CUSTOMER_IDS',
  writeFacilityIds: 'EXTENSIV_MCP_WRITE_FACILITY_IDS',
  stateDir: 'EXTENSIV_MCP_STATE_DIR',
  eventsFile: 'EXTENSIV_MCP_EVENTS_FILE',
  auditFile: 'EXTENSIV_MCP_AUDIT_FILE',
  changeTtlSeconds: 'EXTENSIV_MCP_CHANGE_TTL_SECONDS',
  maxLinesPerMutation: 'EXTENSIV_MCP_MAX_LINES_PER_MUTATION',
  maxUnitsPerMutation: 'EXTENSIV_MCP_MAX_UNITS_PER_MUTATION',
  transport: 'EXTENSIV_MCP_TRANSPORT',
  httpPort: 'EXTENSIV_MCP_HTTP_PORT',
  httpHost: 'EXTENSIV_MCP_HTTP_HOST',
  logLevel: 'EXTENSIV_MCP_LOG_LEVEL',
  environmentLabel: 'EXTENSIV_MCP_ENVIRONMENT_LABEL',
} as const satisfies Record<keyof CoreConfig, string>;

export function loadCoreConfig(env: Record<string, string | undefined> = process.env): CoreConfig {
  const raw: Record<string, string | undefined> = {};
  for (const [key, envName] of Object.entries(CORE_ENV_KEYS)) {
    const v = env[envName];
    if (v !== undefined && v !== '') raw[key] = v;
  }
  const parsed = CoreConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${CORE_ENV_KEYS[i.path[0] as keyof CoreConfig] ?? String(i.path[0])}: ${i.message}`);
    throw new Error(`Invalid core configuration: ${issues.join('; ')}`);
  }
  const cfg = parsed.data;
  if (cfg.writesEnabled && cfg.writeCustomerIds.length === 0) {
    throw new Error(
      `${CORE_ENV_KEYS.writesEnabled}=true requires ${CORE_ENV_KEYS.writeCustomerIds} to list at least one customer id. ` +
        'Write scope is never implicit.',
    );
  }
  return cfg;
}
