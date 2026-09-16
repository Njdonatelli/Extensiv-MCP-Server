import { createHash, randomBytes } from 'node:crypto';

/** Deterministic JSON with sorted keys so two equal intents hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function fingerprint(kind: string, input: unknown): string {
  return createHash('sha256').update(kind).update('\n').update(canonicalJson(input)).digest('hex');
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newChangeId(): string {
  const bytes = randomBytes(12);
  let out = 'chg_';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
