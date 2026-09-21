import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { WmsError } from '../errors.js';
import { silentLogger } from '../logger.js';
import { MemoryAuditLog } from '../stores/audit_log.js';
import { common, defineTool, runTool, type ToolContext, type ToolDefinition } from '../tools/define.js';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function ctxWith(audit: MemoryAuditLog): ToolContext {
  // runTool only reaches audit + logger; the rest of the context is never touched.
  return { audit, logger: silentLogger } as unknown as ToolContext;
}

const dateTool = defineTool({
  name: 'date_tool',
  title: 'Date tool',
  description: 'test',
  kind: 'read',
  inputSchema: z.object({ day: common.isoDate.optional() }),
  annotations: RO,
  handler: async (input) => ({ echoed: input.day }),
});

describe('common.isoDate', () => {
  const parse = (v: string) => z.object({ day: common.isoDate }).safeParse({ day: v });

  it.each([
    '2026-09-16',
    '2026-09-16T00:00:00Z',
    '2026-09-16T14:30Z',
    '2026-09-16T14:30:00',
    '2026-09-16T04:00:00+00:00',
    '2026-09-16T04:00:00-07:00',
    '2022-01-07T19:54:15.4770000',
    '2026-12-31T23:59:59.999Z',
  ])('accepts the shape the adapter actually sends: %s', (v) => {
    expect(parse(v).success).toBe(true);
  });

  it.each([
    'today',
    'tomorrow',
    'now',
    '<script>alert(1)</script>',
    '',
    '2026',
    '09/16/2026',
    '2026-13-01',
    '2026-00-10',
    '2026-09-32',
    '2026-09-16T25:00:00Z',
    '2026-09-16T10:60:00Z',
    '2026-09-16 10:00:00',
    '2026-09-16T10:00:00Z; DROP TABLE',
  ])('rejects %s', (v) => {
    expect(parse(v).success).toBe(false);
  });

  it('tells the model the exact format to use instead of just "invalid"', () => {
    const res = parse('today');
    expect(res.success).toBe(false);
    const message = res.success ? '' : res.error.issues[0]!.message;
    expect(message).toContain('2026-09-16');
    expect(message).toContain('2026-09-16T00:00:00Z');
    expect(message).toMatch(/today/i);
  });

  it('exposes the rule to the model as a JSON Schema pattern (a .refine would be dropped)', () => {
    const schema = z.toJSONSchema(z.object({ day: common.isoDate.optional() })) as {
      properties: { day: { pattern?: string; description?: string } };
    };
    expect(schema.properties.day.pattern).toBeTruthy();
    expect(new RegExp(schema.properties.day.pattern!).test('2026-09-16')).toBe(true);
    expect(new RegExp(schema.properties.day.pattern!).test('today')).toBe(false);
    expect(schema.properties.day.description).toContain('ISO-8601');
  });

  it('rejects "today" locally instead of spending an upstream round trip on it', async () => {
    const audit = new MemoryAuditLog();
    const res = (await runTool(dateTool as unknown as ToolDefinition, { day: 'today' }, ctxWith(audit))) as {
      isError?: boolean;
      structuredContent?: { error: { code: string; message: string } };
    };
    expect(res.isError).toBe(true);
    expect(res.structuredContent!.error.code).toBe('VALIDATION');
    expect(res.structuredContent!.error.message).toContain('day: ');
    expect(res.structuredContent!.error.message).toContain('2026-09-16');
    expect(audit.entries[0]!.outcome).toBe('error');
  });

  it('still accepts a valid date end to end', async () => {
    const audit = new MemoryAuditLog();
    const res = (await runTool(dateTool as unknown as ToolDefinition, { day: '2026-09-16' }, ctxWith(audit))) as {
      isError?: boolean;
      structuredContent?: { echoed: string };
    };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.echoed).toBe('2026-09-16');
  });
});

describe('common fragments that promise a format', () => {
  it('leaves free-form id-or-name fragments free-form (they are resolved, not parsed)', () => {
    expect(z.object({ c: common.customerId }).safeParse({ c: 'Acme Outdoor Co' }).success).toBe(true);
    expect(z.object({ f: common.facilityId }).safeParse({ f: 'LAX-1' }).success).toBe(true);
    expect(z.object({ c: common.customerId }).safeParse({ c: '' }).success).toBe(false);
  });

  it('enforces the bounds limit() advertises', () => {
    const s = z.object({ limit: common.limit(50, 500) });
    expect(s.parse({}).limit).toBe(50);
    expect(s.safeParse({ limit: 501 }).success).toBe(false);
    expect(s.safeParse({ limit: 0 }).success).toBe(false);
    expect(s.safeParse({ limit: 1.5 }).success).toBe(false);
  });
});

const huge = 'A'.repeat(200_000);

const throwingRead = defineTool({
  name: 'throwing_read',
  title: 'Throwing read',
  description: 'test',
  kind: 'read',
  inputSchema: z.object({ reference_num_contains: z.string().optional() }),
  annotations: RO,
  handler: async () => {
    throw new WmsError('UPSTREAM_ERROR', 'boom');
  },
});

const okWrite = defineTool({
  name: 'ok_write',
  title: 'Ok write',
  description: 'test',
  kind: 'prepare',
  inputSchema: z.object({ notes: z.string().optional() }),
  annotations: RW,
  handler: async () => ({ ok: true }),
});

describe('audit input is size-capped', () => {
  it('caps the error-path record so one call cannot grow audit.jsonl without bound', async () => {
    const audit = new MemoryAuditLog();
    await runTool(throwingRead as unknown as ToolDefinition, { reference_num_contains: huge }, ctxWith(audit));
    const entry = audit.entries[0]!;
    expect(entry.outcome).toBe('error');
    const serialized = JSON.stringify(entry.input);
    expect(serialized.length).toBeLessThan(1100);
    expect(JSON.stringify(entry).length).toBeLessThan(2000);
  });

  it('marks the truncation rather than silently dropping the tail', async () => {
    const audit = new MemoryAuditLog();
    await runTool(throwingRead as unknown as ToolDefinition, { reference_num_contains: huge }, ctxWith(audit));
    expect(typeof audit.entries[0]!.input).toBe('string');
    expect(audit.entries[0]!.input as string).toMatch(/…$/);
  });

  it('caps the success-path record for writes too', async () => {
    const audit = new MemoryAuditLog();
    await runTool(okWrite as unknown as ToolDefinition, { notes: huge }, ctxWith(audit));
    const entry = audit.entries[0]!;
    expect(entry.outcome).toBe('ok');
    expect(JSON.stringify(entry.input).length).toBeLessThan(1100);
  });

  it('keeps small inputs intact and structured', async () => {
    const audit = new MemoryAuditLog();
    await runTool(okWrite as unknown as ToolDefinition, { notes: 'rush it' }, ctxWith(audit));
    expect(audit.entries[0]!.input).toEqual({ notes: 'rush it' });
  });

  it('still records no input at all for a successful read', async () => {
    const audit = new MemoryAuditLog();
    await runTool(dateTool as unknown as ToolDefinition, { day: '2026-09-16' }, ctxWith(audit));
    expect(audit.entries[0]!.input).toBeUndefined();
  });
});
