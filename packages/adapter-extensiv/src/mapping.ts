/**
 * Pure wire -> domain mapping. No I/O, no clock, no config: everything here is a
 * function of the JSON the API returned plus (for the few rows that omit them)
 * the customer/facility names the adapter already cached.
 *
 * Every rule cites the rel page it came from; `// INFERRED:` marks a property or
 * semantic the documentation does not state, and `// GUESS:` a value we chose
 * because the API exposes nothing better.
 */
import type {
  Address,
  Customer,
  CustomerRef,
  Facility,
  FacilityRef,
  InventoryPosition,
  Item,
  LotPosition,
  OrderDetail,
  OrderLine,
  OrderStatus,
  OrderSummary,
  Package,
  ReceiptDetail,
  ReceiptLine,
  ReceiptStatus,
  ReceiptSummary,
  TimelineEvent,
} from '@mcp-3pl/core';
import { REL, embedded, idOf, nameOf, type WireIdentifier } from './hal.js';
import { WIRE_STATUS } from './wire.js';
import type {
  WireAddress,
  WireCustomer,
  WireFacility,
  WireItem,
  WireOrder,
  WireOrderItem,
  WireOrderReadOnly,
  WirePackage,
  WirePackageContent,
  WireReceiveItem,
  WireReceiver,
  WireStockDetail,
  WireStockSummary,
} from './wire.js';

/**
 * Names for identifiers the API returns without one. A stock summary row, for
 * instance, carries only `facilityId` (SOURCE
 * https://3w.extensiv.com/rels/inventory/stocksummaries), so the adapter passes
 * the id->name maps it built from /customers and /properties/facilities.
 */
export interface RefMaps {
  customers?: ReadonlyMap<string, string>;
  facilities?: ReadonlyMap<string, string>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Identifier -> domain ref, taking the name from the payload, then the cached map, then the id. */
function refOf(ident: WireIdentifier | null | undefined, names?: ReadonlyMap<string, string>): { id: string; name: string } {
  const id = idOf(ident) ?? '';
  const name = nameOf(ident) ?? (id ? names?.get(id) : undefined) ?? id;
  return { id, name };
}

function refOfId(id: string | undefined, names?: ReadonlyMap<string, string>): { id: string; name: string } {
  const safe = id ?? '';
  return { id: safe, name: (safe ? names?.get(safe) : undefined) ?? safe };
}

/**
 * Contact block -> domain Address. Same shape on orders (shipTo/soldTo/billTo),
 * customers (companyInfo) and facilities (contact).
 * SOURCE https://3w.extensiv.com/rels/orders/order
 */
export function toAddress(w: WireAddress | null | undefined): Address {
  if (!w) return {};
  return {
    name: str(w.name),
    companyName: str(w.companyName),
    address1: str(w.address1),
    address2: str(w.address2),
    city: str(w.city),
    state: str(w.state),
    zip: str(w.zip),
    country: str(w.country),
    phone: str(w.phoneNumber),
    email: str(w.emailAddress),
  };
}

// ---------------------------------------------------------------------------
// Customers, facilities, items
// ---------------------------------------------------------------------------

/** SOURCE https://3w.extensiv.com/rels/customers/customer — "active" is `readOnly.deactivated === false`. */
export function toCustomer(w: WireCustomer): Customer {
  const id = w.readOnly?.customerId !== undefined ? String(w.readOnly.customerId) : '';
  const name = str(w.companyInfo?.companyName) ?? str(w.companyInfo?.name) ?? id;
  return {
    id,
    name,
    active: w.readOnly?.deactivated !== true,
    facilities: (w.facilities ?? []).map((f) => refOf(f)),
    externalId: str(w.externalId),
  };
}

/** SOURCE https://3w.extensiv.com/rels/properties/facilities */
export function toFacility(w: WireFacility): Facility {
  const id = w.facilityId !== undefined ? String(w.facilityId) : '';
  return {
    id,
    name: str(w.name) ?? id,
    active: w.deactivated !== true,
    timeZone: str(w.timeZoneName),
    address: w.contact ? toAddress(w.contact) : undefined,
  };
}

/**
 * SOURCE https://3w.extensiv.com/rels/customers/item
 *  - active            = !readOnly.deactivated
 *  - reorderPoint      = options.inventoryUnit.reorderQuantity, else minimumStock
 *  - trackLots/Serials/Expiration = trackBys enum > 0 (0 Disallow, 1 Allow, 2 Require)
 *  - dimensions/weight = options.inventoryUnit.imperial
 */
export function toItem(w: WireItem, customer?: CustomerRef, names?: RefMaps): Item {
  const inv = w.options?.inventoryUnit;
  const imperial = inv?.imperial;
  const trackBys = w.options?.trackBys;
  const length = num(imperial?.length);
  const width = num(imperial?.width);
  const height = num(imperial?.height);
  const weight = num(imperial?.weight) ?? num(imperial?.netWeight);
  const hasDims = length !== undefined || width !== undefined || height !== undefined;
  return {
    sku: str(w.sku) ?? '',
    description: str(w.description),
    upc: str(w.upc),
    customer: customer ?? refOf(w.readOnly?.customerIdentifier, names?.customers),
    active: w.readOnly?.deactivated !== true,
    unitOfMeasure: nameOf(inv?.unitIdentifier),
    // GUESS: the block is named `imperial`, so inches and pounds; the rel page states no unit.
    dimensions: hasDims ? { length, width, height, unit: 'in' } : undefined,
    weight: weight !== undefined ? { value: weight, unit: 'lb' } : undefined,
    trackLots: trackBys ? (num(trackBys.trackLotNumber) ?? 0) > 0 : undefined,
    trackExpiration: trackBys ? (num(trackBys.trackExpirationDate) ?? 0) > 0 : undefined,
    trackSerials: trackBys ? (num(trackBys.trackSerialNumber) ?? 0) > 0 : undefined,
    reorderPoint: num(inv?.reorderQuantity) ?? num(inv?.minimumStock),
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * SOURCE https://3w.extensiv.com/rels/orders/order — `readOnly.status` is the
 * WarehouseTransactionApiStatus enum: 0 Open ("has not yet been confirmed"),
 * 1 Closed ("has been confirmed"), 2 Canceled.
 *
 * The enum has no "Complete" member: in 3PL Warehouse Manager "Mark Complete" is
 * an operator, not a status, so the domain's 'complete' is never produced by this
 * adapter. Anything the UI shows as Complete still reports as 'open' here
 * (isClosed === false), which is what the write paths care about.
 */
export function toOrderStatus(readOnly: WireOrderReadOnly | undefined): OrderStatus {
  switch (readOnly?.status) {
    case WIRE_STATUS.cancelled:
      return 'cancelled';
    case WIRE_STATUS.closed:
      return 'closed';
    case WIRE_STATUS.open:
      return 'open';
    default:
      // status omitted: fall back to the flag the rql docs call the reliable one.
      return readOnly?.isClosed === true ? 'closed' : 'open';
  }
}

function dedupe(values: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Tracking numbers live in three places on one order (SOURCE
 * https://3w.extensiv.com/rels/orders/order): the routing block, each package,
 * and the small-parcel response. Callers want one deduped list.
 */
export function trackingNumbersOf(w: WireOrder): string[] {
  return dedupe([
    w.routingInfo?.trackingNumber,
    ...(w.readOnly?.packages ?? []).map((p) => p.trackingNumber),
    ...(w.parcelResponse?.trackingNumbers ?? []),
  ]);
}

const ORDER_TIMELINE: { key: keyof WireOrderReadOnly; event: string }[] = [
  { key: 'creationDate', event: 'order created' },
  { key: 'onHoldDate', event: 'placed on hold' },
  { key: 'pickStarted', event: 'picking started' },
  { key: 'pickDoneDate', event: 'picking done' },
  { key: 'packStarted', event: 'packing started' },
  { key: 'packDoneDate', event: 'packing done' },
  { key: 'shipDate', event: 'shipped' },
  { key: 'lastModifiedDate', event: 'last modified' },
];

function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return events.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    return ta - tb;
  });
}

/** The readOnly date fields, in one chronological list with operator-readable names. */
export function toOrderTimeline(readOnly: WireOrderReadOnly | undefined): TimelineEvent[] {
  if (!readOnly) return [];
  const events: TimelineEvent[] = [];
  for (const { key, event } of ORDER_TIMELINE) {
    const at = str(readOnly[key]);
    if (at !== undefined) events.push({ at, event, detail: key === 'onHoldDate' ? str(readOnly.onHoldReason) : undefined });
  }
  return sortTimeline(events);
}

/** Sum of `readOnly.allocations[].qty`; undefined when the order was fetched without itemdetail=Allocations. */
function allocatedQty(item: WireOrderItem): number | undefined {
  const allocs = item.readOnly?.allocations;
  if (!Array.isArray(allocs)) return undefined;
  return allocs.reduce((s, a) => s + (num(a.qty) ?? 0), 0);
}

/**
 * Packed quantity per order item, from `readOnly.packages[].packageContents[]`
 * (SOURCE https://3w.extensiv.com/rels/orders/package for the content shape).
 */

/**
 * Packages and their contents arrive in two documented shapes and the rel pages do not
 * say which one `detail=Packages` fills in: the order model carries `readOnly.packages[]`
 * (https://3w.extensiv.com/rels/orders/order) while the packages sub-resource carries
 * `_embedded["…/orders/package"]` with contents under `_embedded["…/orders/packagecontent"]`
 * (https://3w.extensiv.com/rels/orders/packages). Reading only one shape silently produced
 * zero packages and undefined packed quantities against a tenant that returns the other,
 * so both are read and merged by package id.
 * INFERRED: which shape a given tenant returns.
 */
export function packagesOf(w: WireOrder): WirePackage[] {
  const fromReadOnly = w.readOnly?.packages ?? [];
  const fromEmbedded = embedded<WirePackage>(w, REL.orderPackage);
  const byId = new Map<string, WirePackage>();
  for (const p of [...fromReadOnly, ...fromEmbedded]) {
    const key = p.packageId !== undefined && p.packageId !== null ? String(p.packageId) : `anon-${byId.size}`;
    const existing = byId.get(key);
    // Merge rather than replace: one shape may carry contents the other omits.
    byId.set(key, existing ? { ...existing, ...p, packageContents: packageContentsOf(p).length ? packageContentsOf(p) : packageContentsOf(existing) } : p);
  }
  return [...byId.values()];
}

export function packageContentsOf(p: WirePackage): WirePackageContent[] {
  const flat = p.packageContents ?? [];
  if (flat.length) return flat;
  return embedded<WirePackageContent>(p, REL.orderPackageContent);
}

function packedQtyByOrderItem(packages: WirePackage[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of packages) {
    for (const c of packageContentsOf(p)) {
      const key = c.orderItemId !== undefined ? String(c.orderItemId) : undefined;
      if (key === undefined) continue;
      out.set(key, (out.get(key) ?? 0) + (num(c.qty) ?? 0));
    }
  }
  return out;
}

export function toOrderLine(item: WireOrderItem, opts: { packedQty?: number; shipped?: boolean } = {}): OrderLine {
  const lineId = item.readOnly?.orderItemId !== undefined ? String(item.readOnly.orderItemId) : undefined;
  return {
    lineId,
    sku: nameOf(item.itemIdentifier) ?? '',
    qtyOrdered: num(item.qty) ?? 0,
    qtyAllocated: allocatedQty(item),
    // GUESS: the order-item model exposes no picked/shipped quantity. Packed quantity is the
    // only per-line progress the API reports, so it stands in for picked, and for shipped once
    // the order has a ship date (a closed order's packed lines have left the building).
    qtyPicked: opts.packedQty,
    qtyShipped: opts.shipped ? opts.packedQty : undefined,
    qualifier: str(item.qualifier),
    lotNumber: str(item.lotNumber),
    expirationDate: str(item.expirationDate),
  };
}

/** Order items as embedded by `detail=OrderItems` (rel `.../orders/item`). */
export function orderItemsOf(w: WireOrder): WireOrderItem[] {
  const emb = embedded<WireOrderItem>(w, REL.orderItem);
  return emb.length > 0 ? emb : (w.orderItems ?? []);
}


/** pickStarted / packStarted are documented as flags but may arrive as timestamps. */
function flagOrDate(v: boolean | string | null | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return str(v) !== undefined;
}

export function toOrderSummary(w: WireOrder, names?: RefMaps): OrderSummary {
  const ro = w.readOnly;
  const items = orderItemsOf(w);
  const status = toOrderStatus(ro);
  return {
    id: ro?.orderId !== undefined ? String(ro.orderId) : '',
    referenceNum: str(w.referenceNum) ?? '',
    customer: refOf(ro?.customerIdentifier, names?.customers),
    facility: refOf(ro?.facilityIdentifier, names?.facilities),
    status,
    onHold: str(ro?.onHoldDate) !== undefined,
    holdReason: str(ro?.onHoldReason),
    createdAt: str(ro?.creationDate) ?? '',
    updatedAt: str(ro?.lastModifiedDate),
    // The small-parcel pipeline stamps smallParcelShipDate; plain LTL/FTL orders stamp shipDate.
    shippedAt: str(ro?.shipDate) ?? str(ro?.smallParcelShipDate),
    earliestShipDate: str(w.earliestShipDate),
    carrier: str(w.routingInfo?.carrier),
    service: str(w.routingInfo?.mode),
    trackingNumbers: trackingNumbersOf(w),
    // With detail=None there are no embedded items, so fall back to the row's own totals.
    // INFERRED: numUnits1 is the order's total unit count.
    lineCount: items.length,
    totalQty: items.length > 0 ? items.reduce((s, i) => s + (num(i.qty) ?? 0), 0) : (num(w.numUnits1) ?? 0),
    fullyAllocated: ro?.fullyAllocated,
    pickStarted: flagOrDate(ro?.pickStarted),
    pickDone: str(ro?.pickDoneDate) !== undefined,
    packStarted: flagOrDate(ro?.packStarted),
    packDone: str(ro?.packDoneDate) !== undefined,
    shipToName: str(w.shipTo?.name) ?? str(w.shipTo?.companyName),
    shipToCity: str(w.shipTo?.city),
    shipToState: str(w.shipTo?.state),
  };
}

export function toPackage(p: WirePackage): Package {
  return {
    id: p.packageId !== undefined ? String(p.packageId) : undefined,
    trackingNumber: str(p.trackingNumber),
    weight: num(p.weight),
    // weightUnit is deliberately omitted: no rel page states the unit of package weight.
    skus: packageContentsOf(p).map((c) => ({ sku: nameOf(c.itemIdentifier) ?? '', qty: num(c.qty) ?? 0 })),
  };
}

export function toOrderDetail(w: WireOrder, opts: { version?: string; names?: RefMaps } = {}): OrderDetail {
  const ro = w.readOnly;
  const summary = toOrderSummary(w, opts.names);
  const packages = packagesOf(w);
  const packed = packedQtyByOrderItem(packages);
  const shipped = summary.shippedAt !== undefined;
  const lines = orderItemsOf(w).map((item) => {
    const key = item.readOnly?.orderItemId !== undefined ? String(item.readOnly.orderItemId) : undefined;
    return toOrderLine(item, { packedQty: key !== undefined ? packed.get(key) : undefined, shipped });
  });
  const shortLines = lines
    .filter((l) => l.qtyAllocated !== undefined && l.qtyAllocated < l.qtyOrdered)
    .map((l) => ({ sku: l.sku, short: l.qtyOrdered - (l.qtyAllocated ?? 0) }));
  return {
    ...summary,
    lines,
    shipTo: toAddress(w.shipTo),
    billTo: w.billTo ? toAddress(w.billTo) : undefined,
    notes: str(w.notes),
    packages: packages.map(toPackage),
    timeline: toOrderTimeline(ro),
    // The ETag header verbatim: it goes straight back out as If-Match.
    version: opts.version,
    allocationSummary: { fullyAllocated: ro?.fullyAllocated === true, shortLines },
  };
}

// ---------------------------------------------------------------------------
// Receipts (receivers / ASNs)
// ---------------------------------------------------------------------------

/** Same WarehouseTransactionApiStatus enum as orders (SOURCE https://3w.extensiv.com/rels/inventory/receiver). */
export function toReceiptStatus(status: number | undefined): ReceiptStatus {
  switch (status) {
    case WIRE_STATUS.cancelled:
      return 'cancelled';
    case WIRE_STATUS.closed:
      return 'closed';
    default:
      return 'open';
  }
}

export function receiveItemsOf(w: WireReceiver): WireReceiveItem[] {
  const emb = embedded<WireReceiveItem>(w, REL.receiveItem);
  return emb.length > 0 ? emb : (w.receiveItems ?? []);
}

/**
 * SOURCE https://3w.extensiv.com/rels/inventory/receiveitems: a receive item has
 * `readOnly.expectedQty` and `qty`.
 * INFERRED: on a plain receiver expectedQty is null and `qty` is both the expected
 * and the entered quantity; on a Receive-Against ASN expectedQty is the ASN line and
 * `qty` what the warehouse keyed in. Variance is therefore received - expected,
 * and is 0 for a receiver that was never an ASN.
 */
export function toReceiptLine(item: WireReceiveItem): ReceiptLine {
  const received = num(item.qty) ?? 0;
  const expected = num(item.readOnly?.expectedQty) ?? received;
  return {
    lineId: item.readOnly?.receiveItemId !== undefined ? String(item.readOnly.receiveItemId) : undefined,
    sku: nameOf(item.itemIdentifier) ?? '',
    qtyExpected: expected,
    qtyReceived: received,
    variance: received - expected,
    lotNumber: str(item.lotNumber),
    expirationDate: str(item.expirationDate),
    location: str(item.locationInfo?.display),
  };
}

export function toReceiptSummary(w: WireReceiver, names?: RefMaps): ReceiptSummary {
  const ro = w.readOnly;
  const lines = receiveItemsOf(w).map(toReceiptLine);
  const status = toReceiptStatus(ro?.status);
  return {
    id: ro?.receiverId !== undefined ? String(ro.receiverId) : '',
    referenceNum: str(w.referenceNum) ?? '',
    poNum: str(w.poNum),
    customer: refOf(ro?.customerIdentifier, names?.customers),
    facility: refOf(ro?.facilityIdentifier, names?.facilities),
    status,
    createdAt: str(ro?.creationDate) ?? '',
    expectedDate: str(w.expectedDate),
    arrivalDate: str(w.arrivalDate),
    // INFERRED: the receiver model has no closed/confirmed timestamp; once the status is
    // Closed the last modification is the confirmation that closed it.
    closedAt: status === 'closed' ? str(ro?.lastModifiedDate) : undefined,
    lineCount: lines.length,
    totalExpectedQty: lines.reduce((s, l) => s + l.qtyExpected, 0),
    totalReceivedQty: lines.reduce((s, l) => s + l.qtyReceived, 0),
    carrier: str(w.carrier),
    trackingNumber: str(w.trackingNumber),
  };
}

export function toReceiptDetail(w: WireReceiver, opts: { version?: string; names?: RefMaps } = {}): ReceiptDetail {
  const ro = w.readOnly;
  const summary = toReceiptSummary(w, opts.names);
  const events: TimelineEvent[] = [];
  const created = str(ro?.creationDate);
  if (created) events.push({ at: created, event: 'receipt created' });
  const expected = str(w.expectedDate);
  if (expected) events.push({ at: expected, event: 'expected at warehouse' });
  const arrived = str(w.arrivalDate);
  if (arrived) events.push({ at: arrived, event: 'arrived' });
  const modified = str(ro?.lastModifiedDate);
  if (modified) events.push({ at: modified, event: summary.status === 'closed' ? 'confirmed (stock on hand)' : 'last modified' });
  return {
    ...summary,
    lines: receiveItemsOf(w).map(toReceiptLine),
    notes: str(w.notes),
    version: opts.version,
    timeline: sortTimeline(events),
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryContext {
  /** Stock summary rows carry no customer, so the caller supplies the one it queried for. */
  customer: CustomerRef;
  facilities?: ReadonlyMap<string, string>;
  /** Used when a row omits facilityId (single-facility query). */
  facility?: FacilityRef;
  /** sku -> description, from the item master; summaries carry no description. */
  descriptions?: ReadonlyMap<string, string>;
}

/** SOURCE https://3w.extensiv.com/rels/inventory/stocksummaries — `summaries[]` rows. */
export function toInventoryPositions(rows: WireStockSummary[], ctx: InventoryContext): InventoryPosition[] {
  return rows.map((r) => {
    const sku = nameOf(r.itemIdentifier) ?? '';
    const facility = r.facilityId !== undefined ? refOfId(String(r.facilityId), ctx.facilities) : (ctx.facility ?? { id: '', name: '' });
    return {
      sku,
      description: ctx.descriptions?.get(sku),
      customer: ctx.customer,
      facility,
      qualifier: str(r.qualifier),
      onHand: num(r.onHand) ?? 0,
      available: num(r.available) ?? 0,
      allocated: num(r.allocated) ?? 0,
      onHold: num(r.onHold) ?? 0,
    };
  });
}

/** SOURCE https://3w.extensiv.com/rels/inventory/stockdetails — one on-hand receive-item row. */
export function toLotPosition(d: WireStockDetail): LotPosition {
  const onHand = num(d.onHand) ?? 0;
  const available = num(d.available) ?? 0;
  return {
    lotNumber: str(d.lotNumber),
    expirationDate: str(d.expirationDate),
    location: str(d.locationIdentifier?.nameKey?.name),
    onHand,
    available,
    // INFERRED: stock details expose received/on-hand/available but no allocated column, so
    // allocated is inferred from the gap. A held lot has nothing available yet nothing is
    // allocated to an order either, so counting the whole lot as allocated would tell an
    // operator their stock is committed to orders when it is actually frozen.
    allocated: d.isOnHold === true ? 0 : Math.max(0, onHand - available),
    onHold: d.isOnHold === true ? onHand : 0,
    receivedAt: str(d.receivedDate),
  };
}

/** Groups lot rows onto their positions by sku+qualifier+facility, in place. */
export function attachLots(positions: InventoryPosition[], details: WireStockDetail[], facilityIdOf: (d: WireStockDetail) => string | undefined): void {
  for (const d of details) {
    const sku = nameOf(d.itemIdentifier) ?? '';
    const qualifier = str(d.qualifier);
    const facilityId = facilityIdOf(d);
    const pos = positions.find((p) => p.sku === sku && (p.qualifier ?? undefined) === qualifier && (facilityId === undefined || p.facility.id === facilityId));
    if (!pos) continue;
    if (!pos.lots) pos.lots = [];
    pos.lots.push(toLotPosition(d));
    if (pos.description === undefined) pos.description = str(d.description);
  }
}
