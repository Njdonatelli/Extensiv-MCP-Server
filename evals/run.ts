/**
 * Tool-selection eval runner.
 *
 *   pnpm evals                      # live: needs ANTHROPIC_API_KEY; presents the real tool list to a Claude model
 *   pnpm evals --from-file f.json   # replay: score selections recorded elsewhere ({id, selected_tool}[])
 *   pnpm evals --dump-tools f.json  # write the tool list (JSON Schema) the model sees, for offline runs
 *
 * Scoring: 1 point when the first tool called equals expected_tool or is in acceptable_tools.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { READ_TOOLS, WRITE_TOOLS, type ToolDefinition } from '@mcp-3pl/core';

interface Prompt {
  id: string;
  prompt: string;
  expected_tool: string;
  acceptable_tools?: string[];
  requires_writes_enabled: boolean;
  category: string;
  rationale: string;
}

interface Selection {
  id: string;
  selected_tool: string | null;
  arguments?: unknown;
  writes_enabled?: boolean;
  note?: string;
}

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const prompts = JSON.parse(readFileSync(path.join(here, 'prompts.json'), 'utf8')) as Prompt[];

function toolsFor(writesEnabled: boolean): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  const defs = [...READ_TOOLS, ...(writesEnabled ? WRITE_TOOLS : [])] as ToolDefinition[];
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: z.toJSONSchema(d.inputSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown> }));
}

const SYSTEM_READONLY =
  'You are an operations assistant for a 3PL using Extensiv 3PL Warehouse Manager through MCP tools. This server is READ-ONLY: no write tools are registered. If asked to create, change or cancel anything, pick the read tool that best lets you report the current state and explain that writes are disabled. Always call exactly one tool first.';
const SYSTEM_WRITES =
  'You are an operations assistant for a 3PL using Extensiv 3PL Warehouse Manager through MCP tools. Writes are two-phase: create_order / update_order / cancel_order / create_receipt only PREPARE and return a preview with a change_id; nothing is written until commit_change is called with that id after the operator approves. Shipping, confirming receipts and releasing holds are not exposed; report state instead. Always call exactly one tool first.';

async function live(): Promise<Selection[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set; use --from-file to score recorded selections.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const model = flag('--model') ?? 'claude-sonnet-5';
  const out: Selection[] = [];
  for (const p of prompts) {
    const writesEnabled = p.category !== 'policy' && (p.requires_writes_enabled || flag('--writes') === 'on');
    const res = await client.messages.create({
      model,
      max_tokens: 512,
      system: writesEnabled ? SYSTEM_WRITES : SYSTEM_READONLY,
      tools: toolsFor(writesEnabled),
      messages: [{ role: 'user', content: p.prompt }],
    });
    const first = res.content.find((b) => b.type === 'tool_use') as { name: string; input: unknown } | undefined;
    out.push({ id: p.id, selected_tool: first?.name ?? null, arguments: first?.input, writes_enabled: writesEnabled });
    process.stderr.write(`${p.id} -> ${first?.name ?? '(no tool)'}\n`);
  }
  return out;
}

function score(selections: Selection[]): { total: number; correct: number; accuracy: number; byCategory: Record<string, { total: number; correct: number }>; rows: { id: string; category: string; expected: string; selected: string | null; ok: boolean }[] } {
  const byId = new Map(selections.map((s) => [s.id, s]));
  const byCategory: Record<string, { total: number; correct: number }> = {};
  const rows = prompts.map((p) => {
    const sel = byId.get(p.id)?.selected_tool ?? null;
    const ok = sel !== null && (sel === p.expected_tool || (p.acceptable_tools ?? []).includes(sel));
    byCategory[p.category] ??= { total: 0, correct: 0 };
    byCategory[p.category]!.total += 1;
    if (ok) byCategory[p.category]!.correct += 1;
    return { id: p.id, category: p.category, expected: p.expected_tool, selected: sel, ok };
  });
  const correct = rows.filter((r) => r.ok).length;
  return { total: rows.length, correct, accuracy: correct / rows.length, byCategory, rows };
}

async function main(): Promise<void> {
  const dump = flag('--dump-tools');
  if (dump) {
    writeFileSync(dump, JSON.stringify({ readOnly: toolsFor(false), writesEnabled: toolsFor(true), system: { readOnly: SYSTEM_READONLY, writes: SYSTEM_WRITES }, prompts }, null, 2));
    process.stdout.write(`wrote ${dump}\n`);
    return;
  }
  const from = flag('--from-file');
  const selections = from ? (JSON.parse(readFileSync(from, 'utf8')) as Selection[]) : await live();
  const result = score(selections);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(path.join(here, 'results'), { recursive: true });
  const outFile = path.join(here, 'results', `${stamp}.json`);
  writeFileSync(outFile, JSON.stringify({ source: from ?? 'live', model: from ? undefined : flag('--model') ?? 'claude-sonnet-5', ...result, selections }, null, 2));
  const lines = [
    `Tool-selection accuracy: ${result.correct}/${result.total} (${(result.accuracy * 100).toFixed(0)}%)`,
    ...Object.entries(result.byCategory).map(([c, v]) => `  ${c.padEnd(14)} ${v.correct}/${v.total}`),
    '',
    ...result.rows.filter((r) => !r.ok).map((r) => `  MISS ${r.id} expected ${r.expected} got ${r.selected ?? '(none)'}`),
    `results: ${outFile}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  const min = Number(flag('--min-accuracy') ?? '0');
  if (result.accuracy < min) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
