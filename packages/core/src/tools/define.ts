import * as z from 'zod/v4';
import type { WmsAdapter } from '../adapter.js';
import type { Clock } from '../clock.js';
import type { CoreConfig } from '../config.js';
import type { MutationEngine } from '../engine/mutation_engine.js';
import { WmsError, toWmsError } from '../errors.js';
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


/**
 * Resolves a customer reference that may be an id OR a name, then applies read
 * policy to the RESOLVED id.
 *
 * Operators say "Acme Outdoor Co", not "1". Requiring an id cost every
 * conversation an extra describe_scope round trip: in the 25-prompt eval the
 * model reached the right tool 23 times but called it first only 11 times,
 * because it had to look the id up first. Accepting a name removes that hop.
 */
export async function resolveCustomerRef(ctx: ToolContext, value: string | undefined, required: boolean): Promise<string | undefined> {
  if (value === undefined || value.trim() === '') {
    const scoped = ctx.policy.readCustomerFilter();
    if (scoped && scoped.length === 1) return scoped[0];
    if (!required) return undefined;
    const active = ctx.policy.filterCustomers(await ctx.adapter.listCustomers()).filter((c) => c.active);
    if (active.length === 1) return active[0]!.id;
    throw new WmsError('AMBIGUOUS', 'customer_id is required because this server can see more than one customer.', {
      hint: 'Pass customer_id as either the id or the customer name. describe_scope lists both.',
      details: { customers: active.map((c) => ({ id: c.id, name: c.name })) },
    });
  }
  const raw = value.trim();
  const customers = await ctx.adapter.listCustomers();
  const byId = customers.find((c) => c.id === raw);
  if (byId) {
    ctx.policy.assertReadCustomer(byId.id);
    return byId.id;
  }
  const lower = raw.toLowerCase();
  const exact = customers.filter((c) => c.name.toLowerCase() === lower);
  const matches = exact.length ? exact : customers.filter((c) => c.name.toLowerCase().includes(lower));
  // Narrow by read scope FIRST: a name that is ambiguous across the whole tenant is
  // often unique within what this server may see, and no error detail may ever name a
  // customer outside the allow-list.
  const inScope = ctx.policy.filterCustomers(matches);
  if (inScope.length === 1) return inScope[0]!.id;
  if (inScope.length > 1) {
    throw new WmsError('AMBIGUOUS', `'${raw}' matches ${inScope.length} customers.`, {
      hint: 'Pass the customer id, or a name that matches only one customer.',
      details: { matches: inScope.map((c) => ({ id: c.id, name: c.name })) },
    });
  }
  if (matches.length > 0) {
    // The name matched, but only customers this server may not read.
    throw new WmsError('SCOPE_DENIED', `'${raw}' matches only customers outside this server's read scope.`, {
      hint: 'Use describe_scope to see which customers this server may read.',
    });
  }
  throw new WmsError('NOT_FOUND', `No customer matches '${raw}'.`, {
    hint: 'Call describe_scope to list the customers this server can see, then use an id or an exact name.',
    details: { visibleCustomers: ctx.policy.filterCustomers(customers).map((c) => ({ id: c.id, name: c.name })) },
  });
}

/** Same for a facility: accepts an id or a warehouse name such as "LAX-1". */
export async function resolveFacilityRef(ctx: ToolContext, value: string | undefined): Promise<string | undefined> {
  if (value === undefined || value.trim() === '') return undefined;
  const raw = value.trim();
  const facilities = await ctx.adapter.listFacilities();
  const byId = facilities.find((f) => f.id === raw);
  if (byId) {
    ctx.policy.assertReadFacility(byId.id);
    return byId.id;
  }
  const lower = raw.toLowerCase();
  const exact = facilities.filter((f) => f.name.toLowerCase() === lower);
  const matches = exact.length ? exact : facilities.filter((f) => f.name.toLowerCase().includes(lower));
  const inScope = ctx.policy.filterFacilities(matches);
  if (inScope.length === 1) return inScope[0]!.id;
  if (inScope.length > 1) {
    throw new WmsError('AMBIGUOUS', `'${raw}' matches ${inScope.length} facilities.`, {
      hint: 'Pass the facility id, or a name that matches only one facility.',
      details: { matches: inScope.map((f) => ({ id: f.id, name: f.name })) },
    });
  }
  if (matches.length > 0) {
    throw new WmsError('SCOPE_DENIED', `'${raw}' matches only facilities outside this server's read scope.`, {
      hint: 'Use describe_scope to see which facilities this server may read.',
    });
  }
  throw new WmsError('NOT_FOUND', `No facility matches '${raw}'.`, {
    hint: 'Call describe_scope to list facilities.',
    details: { visibleFacilities: ctx.policy.filterFacilities(facilities).map((f) => ({ id: f.id, name: f.name })) },
  });
}

/**
 * Resolves an order reference that may be a warehouse id OR the reference number
 * an operator actually says ("ACME-SO-10026"). Same reasoning as the customer
 * resolver: without it, every cancel or update costs a lookup round trip first.
 * Costs one extra GET when the caller passes a reference number; a model turn
 * costs far more.
 */
export async function resolveOrderRef(ctx: ToolContext, value: string, customerId: string | undefined): Promise<string> {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const byId = await ctx.adapter.getOrder({ id: raw });
    if (byId) {
      ctx.policy.assertReadCustomer(byId.customer.id);
      return byId.id;
    }
  }
  const byRef = await ctx.adapter.getOrder({ referenceNum: raw, customerId });
  if (byRef) {
    ctx.policy.assertReadCustomer(byRef.customer.id);
    return byRef.id;
  }
  throw new WmsError('NOT_FOUND', `No order matches '${raw}'.`, {
    hint: 'Pass the warehouse order id or the exact reference number. find_orders with reference_num_contains will locate it.',
    details: { tried: raw, customerId },
  });
}

/** Shared zod fragments so every tool describes the same things the same way. */
export const common = {
  customerId: z
    .string()
    .min(1)
    .describe('Customer id OR customer name, e.g. "1" or "Acme Outdoor Co". A partial name is accepted when it matches exactly one customer. Required when the server can see more than one customer and the request is customer-specific.'),
  facilityId: z
    .string()
    .min(1)
    .describe('Facility (warehouse) id OR name, e.g. "1" or "LAX-1". A partial name is accepted when it matches exactly one facility.'),
  isoDate: z.string().min(4).describe('ISO-8601 date or date-time, e.g. 2026-09-16 or 2026-09-16T00:00:00Z.'),
  limit: (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Max results (default ${def}, max ${max}).`),
};

export function toStringArray(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean);
}
