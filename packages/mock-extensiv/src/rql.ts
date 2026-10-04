/**
 * RQL (FIQL-style) filter and sort implementation.
 * SOURCE: https://3w.extensiv.com/Rels/rql — grammar, operators, wildcards, case-insensitivity,
 * value typing (date / number / bool / string), `;` and-precedence over `,`, and the
 * "Properties not supported: <name>" NotParsable hint (SOURCE: https://3w.extensiv.com/Rels/exceptions).
 */
import { queryParameter, type ApiError } from './errors.js';
import { parseWireMs } from './util.js';

export type LeafType = 'string' | 'number' | 'bool' | 'date';
/** Nested description of which dotted property paths a rel supports and their types. */
export type RqlShape = { [key: string]: LeafType | RqlShape };

export type ComparisonOp = '==' | '!=' | '=gt=' | '=ge=' | '=lt=' | '=le=' | '=in=' | '=out=' | '=hv=';

export type RqlNode =
  | { kind: 'and'; left: RqlNode; right: RqlNode }
  | { kind: 'or'; left: RqlNode; right: RqlNode }
  | { kind: 'pred'; path: string[]; op: ComparisonOp; values: string[] };

export class RqlSyntaxError extends Error {}

// SOURCE: Rels/rql "Value strings must match the data type of the corresponding model property" — a
// date is anything System.DateTime.Parse accepts; the mock recognises ISO-8601-ish strings only.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** Derive a shape from a fully-populated sample object (every leaf non-null). */
export function shapeFromSample(sample: Record<string, unknown>): RqlShape {
  const shape: RqlShape = {};
  for (const [key, value] of Object.entries(sample)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) continue; // rql cannot address array members
    if (typeof value === 'object') {
      shape[key] = shapeFromSample(value as Record<string, unknown>);
    } else if (typeof value === 'number') {
      shape[key] = 'number';
    } else if (typeof value === 'boolean') {
      shape[key] = 'bool';
    } else if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
      shape[key] = 'date';
    } else {
      shape[key] = 'string';
    }
  }
  return shape;
}

// ------------------------------------------------------------------------------------------
// Parser
// ------------------------------------------------------------------------------------------

const OPERATORS: ComparisonOp[] = ['=in=', '=out=', '=hv=', '=gt=', '=ge=', '=lt=', '=le=', '==', '!='];

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): RqlNode | null {
    if (this.src.trim() === '') return null;
    const node = this.parseOr();
    this.skipWs();
    if (this.pos < this.src.length) throw new RqlSyntaxError(`Unexpected "${this.src[this.pos]}" at ${this.pos}`);
    return node;
  }

  // SOURCE: Rels/rql — "and" takes precedence over "or" unless overridden by parentheses.
  private parseOr(): RqlNode {
    let left = this.parseAnd();
    while (this.peek() === ',') {
      this.pos++;
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): RqlNode {
    let left = this.parsePrimary();
    while (this.peek() === ';') {
      this.pos++;
      const right = this.parsePrimary();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parsePrimary(): RqlNode {
    this.skipWs();
    if (this.peek() === '(') {
      this.pos++;
      const inner = this.parseOr();
      this.skipWs();
      if (this.peek() !== ')') throw new RqlSyntaxError(`Expected ")" at ${this.pos}`);
      this.pos++;
      return inner;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): RqlNode {
    const ident = this.readWhile((ch) => /[A-Za-z0-9_.]/.test(ch));
    if (ident === '') throw new RqlSyntaxError(`Expected property name at ${this.pos}`);
    const op = OPERATORS.find((o) => this.src.startsWith(o, this.pos));
    if (!op) throw new RqlSyntaxError(`Expected comparison operator after "${ident}"`);
    this.pos += op.length;
    const path = ident.toLowerCase().split('.');
    if (op === '=in=' || op === '=out=') {
      if (this.peek() !== '(') throw new RqlSyntaxError(`Expected "(" after ${op}`);
      this.pos++;
      const values: string[] = [];
      for (;;) {
        values.push(this.readValue(true));
        if (this.peek() === ',') {
          this.pos++;
          continue;
        }
        if (this.peek() === ')') {
          this.pos++;
          break;
        }
        throw new RqlSyntaxError(`Malformed list after ${op}`);
      }
      if (values.some((v) => v === '')) throw new RqlSyntaxError('Empty value in list');
      return { kind: 'pred', path, op, values };
    }
    const value = this.readValue(false);
    if (op === '=hv=' && value !== 'true' && value !== 'false') {
      throw new RqlSyntaxError('=hv= requires true or false');
    }
    // SOURCE: Rels/rql — empty string is allowed only with == and !=.
    if (value === '' && op !== '==' && op !== '!=') throw new RqlSyntaxError(`Empty value not allowed with ${op}`);
    // SOURCE: Rels/rql — "fld1==x**" is rejected as ill-formed wildcard use.
    if (/\*\*/.test(value)) throw new RqlSyntaxError('Ill-formed wildcard');
    return { kind: 'pred', path, op, values: [value] };
  }

  private readValue(inList: boolean): string {
    const raw = this.readWhile((ch) => ch !== ';' && ch !== ',' && ch !== ')' && (inList || ch !== '('));
    // SOURCE: Rels/rql "Character Escape Sequences" — the server URL-decodes values a second time, so
    // `%3B` inside a value survives the transport decode and becomes a literal ';' here.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  private readWhile(pred: (ch: string) => boolean): string {
    const start = this.pos;
    while (this.pos < this.src.length && pred(this.src[this.pos] as string)) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos++;
  }

  private peek(): string | undefined {
    this.skipWs();
    return this.src[this.pos];
  }
}

export function parseRql(src: string): RqlNode | null {
  return new Parser(src).parse();
}

// ------------------------------------------------------------------------------------------
// Compilation against a shape
// ------------------------------------------------------------------------------------------

function lookupShape(shape: RqlShape, path: string[]): LeafType | null {
  let cur: LeafType | RqlShape = shape;
  for (const seg of path) {
    if (typeof cur === 'string') return null;
    const key = Object.keys(cur).find((k) => k.toLowerCase() === seg);
    if (key === undefined) return null;
    cur = cur[key] as LeafType | RqlShape;
  }
  return typeof cur === 'string' ? cur : null;
}

function resolvePath(row: unknown, path: string[]): unknown {
  let cur: unknown = row;
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    const obj = cur as Record<string, unknown>;
    const key = Object.keys(obj).find((k) => k.toLowerCase() === seg);
    if (key === undefined) return undefined;
    cur = obj[key];
  }
  return cur;
}

function unsupported(paths: string[][], parameter: string): ApiError {
  return queryParameter('NotParsable', [parameter], `Properties not supported: ${paths.map((p) => p.join('.')).join(', ')}`);
}

function collectPaths(node: RqlNode, out: string[][]): void {
  if (node.kind === 'pred') out.push(node.path);
  else {
    collectPaths(node.left, out);
    collectPaths(node.right, out);
  }
}

function wildcardToRegex(value: string): RegExp {
  const parts = value.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

function coerce(type: LeafType, raw: string): number | boolean | string | null {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool': {
      const l = raw.toLowerCase();
      return l === 'true' ? true : l === 'false' ? false : null;
    }
    case 'date': {
      const t = parseWireMs(raw);
      return Number.isNaN(t) ? null : t;
    }
    default:
      return raw;
  }
}

function rowValue(type: LeafType, v: unknown): number | boolean | string | null {
  if (v === null || v === undefined) return null;
  if (type === 'date') {
    const t = typeof v === 'string' ? parseWireMs(v) : Number.NaN;
    return Number.isNaN(t) ? null : t;
  }
  if (type === 'number') return typeof v === 'number' ? v : Number(v);
  if (type === 'bool') return typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true';
  return String(v);
}

function evalPredicate(node: Extract<RqlNode, { kind: 'pred' }>, type: LeafType, row: unknown): boolean {
  const actual = rowValue(type, resolvePath(row, node.path));
  const first = node.values[0] ?? '';

  if (node.op === '=hv=') {
    const has = actual !== null && actual !== '';
    return first.toLowerCase() === 'true' ? has : !has;
  }

  if (node.op === '=in=' || node.op === '=out=') {
    const set = node.values.map((v) => coerce(type, v));
    const hit = actual !== null && set.some((s) => equalsCi(s, actual));
    return node.op === '=in=' ? hit : !hit;
  }

  // Wildcards only apply to string properties (SOURCE: Rels/rql "For string data types").
  if (type === 'string' && first.includes('*') && (node.op === '==' || node.op === '!=')) {
    const matched = actual !== null && wildcardToRegex(first).test(String(actual));
    return node.op === '==' ? matched : !matched;
  }

  if (first === '' && (node.op === '==' || node.op === '!=')) {
    const empty = actual === null || actual === '';
    return node.op === '==' ? empty : !empty;
  }

  const expected = coerce(type, first);
  if (expected === null) {
    // Value does not parse as the property's type (e.g. a non-numeric qty): the real API rejects it.
    throw queryParameter('NotParsable', ['rql'], `Value not parsable for ${node.path.join('.')}: ${first}`);
  }
  if (actual === null) return node.op === '!=';

  switch (node.op) {
    case '==':
      return equalsCi(expected, actual);
    case '!=':
      return !equalsCi(expected, actual);
    case '=gt=':
      return compare(actual, expected) > 0;
    case '=ge=':
      return compare(actual, expected) >= 0;
    case '=lt=':
      return compare(actual, expected) < 0;
    case '=le=':
      return compare(actual, expected) <= 0;
    default:
      return false;
  }
}

function equalsCi(a: number | boolean | string | null, b: number | boolean | string): boolean {
  if (a === null) return false;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function compare(a: number | boolean | string, b: number | boolean | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export type RowPredicate<T> = (row: T) => boolean;

/**
 * Compile an rql string for a given shape. Throws a 400 QueryParameterException (ApiError) on
 * unparsable syntax or unsupported properties, mirroring the documented behaviour.
 */
export function compileRql<T>(src: string | undefined | null, shape: RqlShape, parameter = 'rql'): RowPredicate<T> {
  if (src === undefined || src === null || src.trim() === '') return () => true;
  let ast: RqlNode | null;
  try {
    ast = parseRql(src);
  } catch (e) {
    // GUESS: the hint text for a syntax error is not documented; only the ErrorCode is.
    throw queryParameter('NotParsable', [parameter], `Query not parsable: ${(e as Error).message}`);
  }
  if (ast === null) return () => true;
  const paths: string[][] = [];
  collectPaths(ast, paths);
  const bad = paths.filter((p) => lookupShape(shape, p) === null);
  if (bad.length > 0) throw unsupported(bad, parameter);

  const evalNode = (node: RqlNode, row: T): boolean => {
    switch (node.kind) {
      case 'and':
        return evalNode(node.left, row) && evalNode(node.right, row);
      case 'or':
        return evalNode(node.left, row) || evalNode(node.right, row);
      case 'pred':
        return evalPredicate(node, lookupShape(shape, node.path) as LeafType, row);
    }
  };
  return (row) => evalNode(ast, row);
}

/**
 * Compile a `sort=fld1,-fld2` string into a comparator (SOURCE: Rels/rql "Sort").
 * GUESS: an unknown sort property is reported the same way as an unknown rql property, with
 * Parameters ["sort"]; the docs only show the rql case.
 */
export function compileSort<T>(src: string | undefined | null, shape: RqlShape): ((a: T, b: T) => number) | null {
  if (src === undefined || src === null || src.trim() === '') return null;
  const keys = src
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const desc = s.startsWith('-');
      const name = s.replace(/^[+-]/, '').toLowerCase();
      return { path: name.split('.'), desc };
    });
  const bad = keys.filter((k) => lookupShape(shape, k.path) === null).map((k) => k.path);
  if (bad.length > 0) throw unsupported(bad, 'sort');
  return (a, b) => {
    for (const k of keys) {
      const type = lookupShape(shape, k.path) as LeafType;
      const va = rowValue(type, resolvePath(a, k.path));
      const vb = rowValue(type, resolvePath(b, k.path));
      let c: number;
      if (va === null && vb === null) c = 0;
      else if (va === null) c = -1;
      else if (vb === null) c = 1;
      else c = compare(va, vb);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  };
}
