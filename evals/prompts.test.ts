import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_TOOLS, WRITE_TOOLS, type ToolDefinition } from '@mcp-3pl/core';

/**
 * Guards the eval suite against drift: a renamed or removed tool must fail here
 * rather than silently scoring every prompt as a miss.
 */
const here = path.dirname(new URL(import.meta.url).pathname);

interface Prompt {
  id: string;
  prompt: string;
  expected_tool: string;
  acceptable_tools?: string[];
  requires_writes_enabled: boolean;
  category: string;
  rationale: string;
}

const prompts = JSON.parse(readFileSync(path.join(here, 'prompts.json'), 'utf8')) as Prompt[];
const readNames = new Set((READ_TOOLS as ToolDefinition[]).map((t) => t.name));
const writeNames = new Set((WRITE_TOOLS as ToolDefinition[]).map((t) => t.name));
const allNames = new Set([...readNames, ...writeNames]);

describe('eval prompts', () => {
  it('has 25 prompts with unique ids', () => {
    expect(prompts).toHaveLength(25);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(25);
  });

  it('names only tools the server actually registers', () => {
    for (const p of prompts) {
      expect(allNames, `${p.id} expected_tool`).toContain(p.expected_tool);
      for (const alt of p.acceptable_tools ?? []) expect(allNames, `${p.id} acceptable_tools`).toContain(alt);
    }
  });

  it('covers every one of the 16 tools at least once', () => {
    const covered = new Set(prompts.flatMap((p) => [p.expected_tool, ...(p.acceptable_tools ?? [])]));
    expect([...allNames].filter((n) => !covered.has(n))).toEqual([]);
    expect(allNames.size).toBe(16);
  });

  it('never expects a write tool while writes are disabled', () => {
    for (const p of prompts) {
      if (writeNames.has(p.expected_tool)) {
        expect(p.requires_writes_enabled, `${p.id} expects ${p.expected_tool} but does not request writes`).toBe(true);
      }
      if (!p.requires_writes_enabled) {
        expect(readNames, `${p.id} runs read-only so its expected tool must be a read tool`).toContain(p.expected_tool);
      }
    }
  });

  it('uses the identifiers the mock actually seeds', () => {
    // A prompt naming a customer, SKU or order that does not exist would be scored on
    // tool choice but could never succeed against the mock, which hides real breakage.
    const seed = readFileSync(path.join(here, '..', 'packages', 'mock-extensiv', 'src', 'seed.ts'), 'utf8');
    const referenced = new Set<string>();
    for (const p of prompts) {
      for (const m of p.prompt.matchAll(/\b(ACME-[A-Z0-9-]+|BLB-[A-Z0-9-]+|OOS-[A-Z0-9-]+|PO-ACME-\d+|LAX-1|DFW-2)\b/g)) {
        referenced.add(m[0]!);
      }
    }
    // Identifiers a prompt invents on purpose: new records the user is asking to create.
    const intentionallyNew = new Set(['ACME-SO-10101', 'PO-ACME-2210', 'PO-ACME-2211', 'OOS-SO-900']);
    const missing = [...referenced].filter((id) => !intentionallyNew.has(id) && !seed.includes(id));
    expect(missing, 'prompt identifiers absent from the mock seed').toEqual([]);
  });

  it('keeps every category populated', () => {
    const byCat = new Map<string, number>();
    for (const p of prompts) byCat.set(p.category, (byCat.get(p.category) ?? 0) + 1);
    expect([...byCat.keys()].sort()).toEqual(['ambiguous', 'commit', 'policy', 'read', 'write-prepare']);
    for (const [, n] of byCat) expect(n).toBeGreaterThan(0);
  });
});
