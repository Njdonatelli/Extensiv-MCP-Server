import * as z from 'zod/v4';
import type { WmsAdapter } from '../adapter.js';
import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { MutationEngine } from '../engine/mutation_engine.js';
import { toWmsError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ScopePolicy } from '../policy.js';
import type { AuditLog } from '../stores/audit_log.js';
import type { EventStore } from '../stores/event_store.js';

export interface ToolContext {
  adapter: WmsAdapter;
  policy: ScopePolicy;
  engine: MutationEngine;
  events: EventStore;
  audit: AuditLog;
  config: CoreConfig;
  logger: Logger;
  clock: Clock;
}

export type ToolKind = 'read' | 'prepare' | 'commit';

export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  inputSchema: S;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<object>;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export interface ToolCallResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Executes a tool with audit + uniform error shaping. Errors become
 * `{ error: { code, message, hint } }` with isError so the model can reason
 * about them instead of receiving a protocol-level failure.
 */
export async function runTool(def: ToolDefinition, rawInput: unknown, ctx: ToolContext): Promise<ToolCallResult> {
  const started = Date.now();
  const parsed = def.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    const payload = { error: { code: 'VALIDATION', message: `Invalid arguments for ${def.name}: ${message}`, retryable: false } };
    await ctx.audit.record({ at: new Date(started).toISOString(), kind: 'tool_call', tool: def.name, outcome: 'error', durationMs: Date.now() - started, error: payload.error });
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
  }
  try {
    const result = (await def.handler(parsed.data, ctx)) as Record<string, unknown>;
    await ctx.audit.record({
      at: new Date(started).toISOString(),
      kind: 'tool_call',
      tool: def.name,
      outcome: 'ok',
      durationMs: Date.now() - started,
      input: def.kind === 'read' ? undefined : parsed.data,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (e) {
    const err = toWmsError(e);
    const outcome = err.code === 'SCOPE_DENIED' || err.code === 'WRITES_DISABLED' ? 'refused' : 'error';
    ctx.logger[outcome === 'refused' ? 'warn' : 'error'](`tool ${def.name} ${outcome}`, { code: err.code, message: err.message });
    await ctx.audit.record({ at: new Date(started).toISOString(), kind: 'tool_call', tool: def.name, outcome, durationMs: Date.now() - started, error: { code: err.code, message: err.message }, input: parsed.data });
    const payload = { error: err.toJSON() };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
  }
}

/** Shared zod fragments so every tool describes the same things the same way. */
export const common = {
  customerId: z.string().min(1).describe('Customer id as shown by describe_scope. Required when the server can see more than one customer and the request is customer-specific.'),
  facilityId: z.string().min(1).describe('Facility (warehouse) id as shown by describe_scope.'),
  isoDate: z.string().min(4).describe('ISO-8601 date or date-time, e.g. 2026-09-16 or 2026-09-16T00:00:00Z.'),
  limit: (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Max results (default ${def}, max ${max}).`),
};

export function toStringArray(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean);
}
