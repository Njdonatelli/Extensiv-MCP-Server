/**
 * HAL helpers. SOURCE https://3w.extensiv.com/Rels/hal
 *
 * Collections look like `{"totalResults": N, "_embedded": {"<rel>": [...]}, "_links": {self,next,prev}}`.
 * Embedded rel keys are the literal doc URLs (`http://api.3plCentral.com/rels/...`);
 * a few lists use the bare key `item` (/inventory, /inventory/stockdetails, /orders/summaries)
 * and /inventory/stocksummaries has no `_embedded` at all (`{"totalResults", "summaries": [...]}`).
 */

export const REL = {
  order: 'http://api.3plCentral.com/rels/orders/order',
  orderItem: 'http://api.3plCentral.com/rels/orders/item',
  orderPackage: 'http://api.3plCentral.com/rels/orders/package',
  orderPackageContent: 'http://api.3plCentral.com/rels/orders/packagecontent',
  customer: 'http://api.3plCentral.com/rels/customers/customer',
  customerItem: 'http://api.3plCentral.com/rels/customers/item',
  receiver: 'http://api.3plCentral.com/rels/inventory/receiver',
  receiveItem: 'http://api.3plCentral.com/rels/inventory/receiveritem',
  facility: 'http://api.3plCentral.com/rels/properties/facility',
  location: 'http://api.3plCentral.com/rels/properties/location',
  carrier: 'http://api.3plCentral.com/rels/properties/carrier',
  /** Bare key used by /inventory, /inventory/stockdetails, /orders/summaries. */
  item: 'item',
} as const;

export interface HalLink {
  href: string;
  templated?: boolean;
}

export interface HalResource {
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  _embedded?: Record<string, unknown>;
}

export interface HalCollection extends HalResource {
  totalResults?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns `_embedded[rel]` as an array. Rel keys are matched exactly first, then
 * case-insensitively (the doc spells the host `3plCentral`; being lenient about
 * casing costs nothing and protects against a server-side spelling change).
 */
export function embedded<T = Record<string, unknown>>(body: unknown, rel: string): T[] {
  if (!isObject(body)) return [];
  const emb = body._embedded;
  if (!isObject(emb)) return [];
  let arr = emb[rel];
  if (arr === undefined) {
    const lower = rel.toLowerCase();
    const key = Object.keys(emb).find((k) => k.toLowerCase() === lower);
    if (key !== undefined) arr = emb[key];
  }
  if (arr === undefined) return [];
  return Array.isArray(arr) ? (arr as T[]) : [arr as T];
}

export function totalResults(body: unknown, fallback = 0): number {
  if (!isObject(body)) return fallback;
  const n = body.totalResults;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function link(body: unknown, rel: string): string | undefined {
  if (!isObject(body) || !isObject(body._links)) return undefined;
  const l = body._links[rel];
  if (Array.isArray(l)) return (l[0] as HalLink | undefined)?.href;
  return isObject(l) && typeof l.href === 'string' ? l.href : undefined;
}

export function nextLink(body: unknown): string | undefined {
  return link(body, 'next');
}

/**
 * Identifier objects (SOURCE https://3w.extensiv.com/Rels/identifiers): GET returns
 * every alternate, e.g. `{externalId, name, id}` for a customer, `{name, id}` for a
 * facility, `{sku, id}` for an item. On write one alternate suffices; `id` wins.
 */
export interface WireIdentifier {
  id?: number | string | null;
  name?: string | null;
  sku?: string | null;
  externalId?: string | null;
}

export function idOf(ident: WireIdentifier | null | undefined): string | undefined {
  if (!ident || ident.id === undefined || ident.id === null) return undefined;
  return String(ident.id);
}

export function nameOf(ident: WireIdentifier | null | undefined): string | undefined {
  if (!ident) return undefined;
  if (typeof ident.name === 'string' && ident.name.length) return ident.name;
  if (typeof ident.sku === 'string' && ident.sku.length) return ident.sku;
  return undefined;
}

/** `{id, name}` for the domain, tolerating a missing name by echoing the id. */
export function toRef(ident: WireIdentifier | null | undefined, fallbackId = ''): { id: string; name: string } {
  const id = idOf(ident) ?? fallbackId;
  return { id, name: nameOf(ident) ?? id };
}

/** Numeric ids go on the wire as numbers (`{"id": 1}` in every documented example); anything else as a string. */
export function toWireId(id: string | number): number | string {
  if (typeof id === 'number') return id;
  return /^\d+$/.test(id) ? Number(id) : id;
}

export interface PageAllOptions {
  /** `pgsiz`; the caller picks a value at or below the rel's documented limit. */
  pageSize: number;
  /** Hard cap on pages fetched per call; protects against runaway collections. */
  maxPages?: number;
  /** Stop once this many items were collected (the last page may overshoot). */
  maxItems?: number;
  /** First page (1-indexed per the doc). */
  startPage?: number;
}

export interface PageAllResult<T> {
  items: T[];
  total: number;
  pagesFetched: number;
  /** True when the collection had more pages than the cap allowed. */
  truncated: boolean;
}

/**
 * Pages through a collection with `pgsiz`/`pgnum` (1-indexed per SOURCE
 * https://3w.extensiv.com/Rels/rql). `fetchPage` returns the items of one page
 * plus `totalResults`; paging stops at the total, at an empty page, at
 * `maxItems`, or at the page cap (default 10).
 */
export async function pageAll<T>(fetchPage: (pgnum: number, pgsiz: number) => Promise<{ items: T[]; total: number }>, opts: PageAllOptions): Promise<PageAllResult<T>> {
  const maxPages = opts.maxPages ?? 10;
  const start = opts.startPage ?? 1;
  const items: T[] = [];
  let total = 0;
  let pagesFetched = 0;
  let pgnum = start;
  for (;;) {
    const page = await fetchPage(pgnum, opts.pageSize);
    pagesFetched += 1;
    items.push(...page.items);
    total = Math.max(page.total, items.length);
    const fetchedSoFar = (pgnum - start + 1) * opts.pageSize;
    if (page.items.length === 0) return { items, total, pagesFetched, truncated: false };
    if (fetchedSoFar >= total) return { items, total, pagesFetched, truncated: false };
    if (opts.maxItems !== undefined && items.length >= opts.maxItems) return { items, total, pagesFetched, truncated: true };
    if (pagesFetched >= maxPages) return { items, total, pagesFetched, truncated: true };
    pgnum += 1;
  }
}
