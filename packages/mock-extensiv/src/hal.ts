/**
 * HAL envelope helpers.
 * SOURCE: https://3w.extensiv.com/Rels/hal — collections are `{ totalResults, _embedded: { "<rel>": [...] }, _links }`
 * with self/next/prev links; media type application/hal+json.
 */
import type { Context } from 'hono';
import { queryParameter } from './errors.js';

export const HAL_CONTENT_TYPE = 'application/hal+json; charset=utf-8';

export const REL = {
  order: 'http://api.3plCentral.com/rels/orders/order',
  orderItem: 'http://api.3plCentral.com/rels/orders/item',
  package: 'http://api.3plCentral.com/rels/orders/package',
  packageContent: 'http://api.3plCentral.com/rels/orders/packagecontent',
  trackingInfo: 'http://api.3plCentral.com/rels/orders/orderparceltrackpackageinfo',
  customer: 'http://api.3plCentral.com/rels/customers/customer',
  item: 'http://api.3plCentral.com/rels/customers/item',
  receiver: 'http://api.3plCentral.com/rels/inventory/receiver',
  receiveItem: 'http://api.3plCentral.com/rels/inventory/receiveritem',
  facility: 'http://api.3plCentral.com/rels/properties/facility',
  location: 'http://api.3plCentral.com/rels/properties/location',
  carrier: 'http://api.3plCentral.com/rels/properties/carrier',
} as const;

/** Rel keys on `_links` use the same literal URL form as `_embedded` keys (SOURCE: Rels/hal, Rels/billboard). */
export function relLink(service: string, rel: string): string {
  return `http://api.3plCentral.com/rels/${service}/${rel}`;
}

export type HalLinks = Record<string, { href: string }>;

export interface Paging {
  pgsiz: number;
  pgnum: number;
}

/**
 * Parse pgsiz/pgnum. SOURCE: https://3w.extensiv.com/rels/inventory/stocksummaries "must be positive;
 * limit N, specifying more is an error; default M" and Rels/rql "pgnum ... 1-indexed".
 * GUESS: the error for an out-of-range value is a 400 QueryParameterException NotParsable; the docs
 * only say "specifying more is an error".
 */
export function parsePaging(c: Context, defaults: { defaultSize: number; maxSize: number }): Paging {
  const rawSize = c.req.query('pgsiz');
  const rawNum = c.req.query('pgnum');
  let pgsiz = defaults.defaultSize;
  let pgnum = 1;
  if (rawSize !== undefined && rawSize !== '') {
    const n = Number(rawSize);
    if (!Number.isInteger(n) || n <= 0 || n > defaults.maxSize) {
      throw queryParameter('NotParsable', ['pgsiz'], `pgsiz must be a positive integer no greater than ${defaults.maxSize}`);
    }
    pgsiz = n;
  }
  if (rawNum !== undefined && rawNum !== '') {
    const n = Number(rawNum);
    if (!Number.isInteger(n) || n <= 0) {
      throw queryParameter('NotParsable', ['pgnum'], 'pgnum must be a positive integer (1-indexed)');
    }
    pgnum = n;
  }
  return { pgsiz, pgnum };
}

function pageHref(c: Context, pgsiz: number, pgnum: number): string {
  const url = new URL(c.req.url);
  url.searchParams.set('pgsiz', String(pgsiz));
  url.searchParams.set('pgnum', String(pgnum));
  return `${url.pathname}${url.search}`;
}

/** Slice a filtered/sorted list into a page and build self/next/prev links. */
export function paginate<T>(c: Context, rows: T[], paging: Paging): { page: T[]; totalResults: number; links: HalLinks } {
  const start = (paging.pgnum - 1) * paging.pgsiz;
  const page = rows.slice(start, start + paging.pgsiz);
  const links: HalLinks = { self: { href: pageHref(c, paging.pgsiz, paging.pgnum) } };
  if (start + paging.pgsiz < rows.length) links.next = { href: pageHref(c, paging.pgsiz, paging.pgnum + 1) };
  if (paging.pgnum > 1) links.prev = { href: pageHref(c, paging.pgsiz, paging.pgnum - 1) };
  return { page, totalResults: rows.length, links };
}

export function collection<T>(rel: string, rows: T[], totalResults: number, links: HalLinks): Record<string, unknown> {
  return { totalResults, _embedded: { [rel]: rows }, _links: links };
}

export function hal(c: Context, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Headers({ 'Content-Type': HAL_CONTENT_TYPE, ...headers });
  return new Response(JSON.stringify(body), { status: status as 200, headers: h });
}

/** Apply optional filter + sort then page. */
export function listPipeline<T>(
  c: Context,
  rows: T[],
  filter: (row: T) => boolean,
  sort: ((a: T, b: T) => number) | null,
  paging: Paging,
): { page: T[]; totalResults: number; links: HalLinks } {
  const filtered = rows.filter(filter);
  if (sort) filtered.sort(sort);
  return paginate(c, filtered, paging);
}
