/**
 * Minimal builder for the FIQL/RQL query language used by the Extensiv API.
 * SOURCE https://3w.extensiv.com/Rels/rql
 *
 * Grammar recap from the doc:
 *   - predicates joined by `;` (AND) and `,` (OR); parentheses group.
 *   - operators `==`, `!=`, `=gt=`, `=ge=`, `=lt=`, `=le=`, `=in=(a,b)`, `=out=(..)`, `=hv=true|false`.
 *   - wildcards `*x`, `x*`, `*x*` with `==`/`!=`.
 *   - property names are the API model names, dotted for nesting, case-insensitive.
 *
 * Escaping (same doc): "URL-encode `% ! ( ) * = , ;` inside values, then encode `%`
 * again as `%25`" because the server decodes the value twice (once as part of the
 * query string, once inside the RQL parser).
 *
 * How that interacts with core's HttpClient.buildUrl: it puts the rql string through
 * URLSearchParams, which percent-encodes the whole string once (`%` -> `%25`,
 * `=` -> `%3D`, `;` -> `%3B`, ...). So this module performs only the FIRST encoding
 * step (reserved chars inside values -> `%XX`) and lets URLSearchParams supply the
 * second (`%` -> `%25`). Example for value `a,b`:
 *
 *   escapeValue('a,b')                        -> 'a%2Cb'          (this module)
 *   URLSearchParams({ rql: 'sku==a%2Cb' })    -> 'rql=sku%3D%3Da%252Cb'   (wire)
 *   server/framework decodes the query once   -> 'sku==a%2Cb'
 *   RQL parser decodes the value once more    -> 'a,b'
 *
 * The local mock receives the once-decoded query from Hono (`sku==a%2Cb`) and, like
 * the real server, must decodeURIComponent each value before comparing.
 */

export type RqlValue = string | number | boolean | Date;

/** Characters the doc lists as reserved inside values. `%` first so we never double-escape. */
const RESERVED = /[%!()*=,;]/;

function encodeChar(ch: string): string {
  return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Single URL-encoding of the reserved RQL characters in a value. Values without
 * reserved characters pass through untouched so ordinary SKUs and reference numbers
 * stay readable in logs.
 */
export function escapeValue(raw: string): string {
  if (!RESERVED.test(raw)) return raw;
  return raw.replace(/[%!()*=,;]/g, encodeChar);
}

export function formatValue(v: RqlValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  return escapeValue(v);
}

/** A property name as the API spells it in RQL: dotted path, lower-cased (names are case-insensitive). */
export function prop(name: string): string {
  return name.toLowerCase();
}

export const eq = (p: string, v: RqlValue): string => `${prop(p)}==${formatValue(v)}`;
export const ne = (p: string, v: RqlValue): string => `${prop(p)}!=${formatValue(v)}`;
export const gt = (p: string, v: RqlValue): string => `${prop(p)}=gt=${formatValue(v)}`;
export const ge = (p: string, v: RqlValue): string => `${prop(p)}=ge=${formatValue(v)}`;
export const lt = (p: string, v: RqlValue): string => `${prop(p)}=lt=${formatValue(v)}`;
export const le = (p: string, v: RqlValue): string => `${prop(p)}=le=${formatValue(v)}`;
/** `prop=in=(a,b,c)`; each value is escaped individually so a `,` inside a value cannot split the list. */
export const inList = (p: string, values: RqlValue[]): string => `${prop(p)}=in=(${values.map(formatValue).join(',')})`;
export const outList = (p: string, values: RqlValue[]): string => `${prop(p)}=out=(${values.map(formatValue).join(',')})`;
/** `prop=hv=true|false` — "has value" (non-null) test, used e.g. for readonly.onholddate. */
export const hv = (p: string, has: boolean): string => `${prop(p)}=hv=${has ? 'true' : 'false'}`;
/** Substring match: `prop==*s*`. A literal `*` inside `s` is escaped so it is not treated as a wildcard. */
export const contains = (p: string, s: string): string => `${prop(p)}==*${escapeValue(s)}*`;
export const startsWith = (p: string, s: string): string => `${prop(p)}==${escapeValue(s)}*`;

function clean(parts: (string | undefined | null | false)[]): string[] {
  return parts.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** AND. `;` binds tighter than `,` in FIQL, so no parentheses are needed around an AND group. */
export function and(...parts: (string | undefined | null | false)[]): string {
  return clean(parts).join(';');
}

/** OR. Wrapped in parentheses whenever it has more than one term so it can be nested inside an AND. */
export function or(...parts: (string | undefined | null | false)[]): string {
  const p = clean(parts);
  if (p.length <= 1) return p[0] ?? '';
  return `(${p.join(',')})`;
}

/** Namespace form for callers that prefer `rql.in(...)` over `inList(...)`. */
export const rql = { and, or, eq, ne, gt, ge, lt, le, in: inList, out: outList, hv, contains, startsWith, escapeValue, formatValue, prop } as const;
