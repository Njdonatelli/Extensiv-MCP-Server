/** Small shared helpers (dates, ETags, identifiers). */

/**
 * Dates on the wire look like `2016-12-25T23:00:00` — .NET DateTime, no offset, no milliseconds
 * (SOURCE: every sample on https://3w.extensiv.com/rels/orders/order). The mock renders UTC and
 * drops the `Z`.
 * GUESS: whether the real API's unqualified timestamps are UTC or warehouse-local is not documented.
 */
export function wireDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

/** Webhook timestamps carry seven fractional digits (SOURCE: implementing-webhooks sample `2022-01-07T19:54:15.4770000`). */
export function webhookDate(d: Date): string {
  return d.toISOString().replace(/(\.\d{3})Z$/, '$10000');
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/**
 * ETag from an incrementing row version.
 * GUESS: the real value is opaque; SQL Server rowversions surface through Newtonsoft as base64 of 8
 * bytes (e.g. "AAAAAAALdzM="), so the mock uses that shape wrapped in quotes.
 */
export function etagFor(rowVersion: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(rowVersion));
  return `"${buf.toString('base64')}"`;
}

/** rowVersion strings inside readOnly blocks use the same base64 form without quotes. */
export function rowVersionString(rowVersion: number): string {
  return etagFor(rowVersion).slice(1, -1);
}

export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export function ci(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
