/**
 * Drives the REAL server through a REAL MCP client with a real model, one fresh
 * client session per prompt, and records the first tool the model chose.
 *
 * This is a stronger signal than asking a model to name a tool from a printed
 * list: the tool schemas reach the model the way they will in production, over
 * MCP, from this repo's own server binary.
 *
 *   npx tsx evals/drive_client.ts --out evals/results/selections.json [--model claude-sonnet-5] [--only E01,E02]
 *
 * Requires: `pnpm build`, and the mock API reachable at --base (default http://127.0.0.1:4010).
 * Writes selections.json, which evals/run.ts scores with --from-file.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Prompt {
  id: string;
  prompt: string;
  expected_tool: string;
  acceptable_tools?: string[];
  requires_writes_enabled: boolean;
  category: string;
}

interface Selection {
  id: string;
  selected_tool: string | null;
  arguments?: unknown;
  writes_enabled: boolean;
  tools_offered: number;
  note?: string;
}

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const model = flag('--model', 'claude-sonnet-5')!;
const base = flag('--base', 'http://127.0.0.1:4010')!;
const outFile = flag('--out', path.join(here, 'results', 'selections.json'))!;
const only = flag('--only')?.split(',').map((s) => s.trim());
const timeoutMs = Number(flag('--timeout-ms', '180000'));

const prompts = (JSON.parse(readFileSync(path.join(here, 'prompts.json'), 'utf8')) as Prompt[]).filter((p) => !only || only.includes(p.id));

/** Mirrors the instructions the server itself advertises, so the eval measures tool choice, not prompt novelty. */
const SYSTEM_EXTRA =
  'You are an operations assistant for a third-party logistics provider, working through the Extensiv MCP tools. ' +
  'Call exactly one tool first, the one that best serves the request. Do not ask clarifying questions before calling a tool. ' +
  'Never invent a tool that is not offered.';

function mcpConfig(writesEnabled: boolean, stateDir: string): string {
  const env: Record<string, string> = {
    EXTENSIV_BASE_URL: base,
    EXTENSIV_CLIENT_ID: 'mock-client-id',
    EXTENSIV_CLIENT_SECRET: 'mock-client-secret',
    EXTENSIV_USER_LOGIN: 'mock-integration-user',
    EXTENSIV_MCP_STATE_DIR: stateDir,
    EXTENSIV_MCP_LOG_LEVEL: 'silent',
  };
  if (writesEnabled) {
    env.EXTENSIV_MCP_WRITES_ENABLED = 'true';
    env.EXTENSIV_MCP_WRITE_CUSTOMER_IDS = '1,2';
  }
  return JSON.stringify({ mcpServers: { extensiv: { command: 'node', args: [path.join(repo, 'packages/server/dist/cli.js')], env } } });
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: { type: string; name?: string; input?: unknown }[] };
  mcp_servers?: { name: string; status: string }[];
  tools?: string[];
}

async function runOne(p: Prompt): Promise<Selection> {
  const stateDir = mkdtempSync(path.join(tmpdir(), `eval-${p.id}-`));
  const writesEnabled = p.requires_writes_enabled;
  const args = [
    '-p',
    p.prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfig(writesEnabled, stateDir),
    '--strict-mcp-config',
    '--append-system-prompt',
    SYSTEM_EXTRA,
    '--allowedTools',
    'mcp__extensiv',
    '--max-turns',
    '2',
  ];
  return new Promise<Selection>((resolve) => {
    const child = spawn('claude', args, { cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let selected: string | null = null;
    let selectedInput: unknown;
    let toolsOffered = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        if (ev.type === 'system' && Array.isArray(ev.tools)) {
          toolsOffered = ev.tools.filter((t) => t.startsWith('mcp__extensiv__')).length;
        }
        if (selected === null && ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name?.startsWith('mcp__extensiv__')) {
              selected = block.name.replace('mcp__extensiv__', '');
              selectedInput = block.input;
              break;
            }
          }
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      process.stderr.write(`${p.id} [${writesEnabled ? 'writes' : 'read-only'}, ${toolsOffered} tools] -> ${selected ?? '(no tool)'}\n`);
      resolve({
        id: p.id,
        selected_tool: selected,
        arguments: selectedInput,
        writes_enabled: writesEnabled,
        tools_offered: toolsOffered,
        ...(selected === null ? { note: `exit ${code}; stderr: ${stderr.slice(-400)}` } : {}),
      });
    });
  });
}

async function main(): Promise<void> {
  const selections: Selection[] = [];
  // Serial on purpose: each run spawns a server process and a model session, and a
  // parallel burst would make rate limiting, not tool choice, the thing being measured.
  for (const p of prompts) selections.push(await runOne(p));
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(selections, null, 2));
  const withTool = selections.filter((s) => s.selected_tool).length;
  process.stdout.write(`\n${withTool}/${selections.length} prompts produced a tool call. Wrote ${outFile}\nScore with: npx tsx evals/run.ts --from-file ${outFile}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
