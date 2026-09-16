/**
 * WMS-agnostic domain model. Adapters translate their system's wire format
 * into these shapes; tools are written only against them. Field naming follows
 * the vocabulary a 3PL operator uses, not any vendor's API.
 */

export interface CustomerRef {
  id: string;
  name: string;
}

export interface FacilityRef {
  id: string;
  name: string;
}

export interface Customer extends CustomerRef {
  active: boolean;
  facilities: FacilityRef[];
  externalId?: string;
}

export interface Facility extends FacilityRef {
  active: boolean;
  timeZone?: string;
  address?: Address;
}

export interface Address {
  name?: string;
  companyName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  email?: string;
}

/**
 * Order lifecycle as documented for 3PL Warehouse Manager:
 * Open -> Complete -> Closed, or Cancelled. Hold is orthogonal (onHold flag).
 * Source: https://help.extensiv.com/en_US/order-management/understanding-order-statuses
 */
export type OrderStatus = 'open' | 'complete' | 'closed' | 'cancelled';

export interface OrderSummary {
  id: string;
  referenceNum: string;
  customer: CustomerRef;
  facility: FacilityRef;
  status: OrderStatus;
  onHold: boolean;
  holdReason?: string;
  createdAt: string;
  updatedAt?: string;
  shippedAt?: string;
  earliestShipDate?: string;
  carrier?: string;
  service?: string;
  trackingNumbers: string[];
  lineCount: number;
  totalQty: number;
  fullyAllocated?: boolean;
  pickStarted?: boolean;
  pickDone?: boolean;
  packStarted?: boolean;
  packDone?: boolean;
  shipToName?: string;
  shipToCity?: string;
  shipToState?: string;
}

export interface OrderLine {
  lineId?: string;
  sku: string;
  description?: string;
  qtyOrdered: number;
  qtyAllocated?: number;
  qtyPicked?: number;
  qtyShipped?: number;
  qualifier?: string;
  lotNumber?: string;
  expirationDate?: string;
}

export interface TimelineEvent {
  at: string;
  event: string;
  detail?: string;
}

export interface Package {
  id?: string;
  trackingNumber?: string;
  weight?: number;
  weightUnit?: string;
  skus?: { sku: string; qty: number }[];
}

export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
  shipTo: Address;
  billTo?: Address;
  notes?: string;
  packages: Package[];
  timeline: TimelineEvent[];
  /** Opaque concurrency token from the upstream system (Extensiv: ETag). */
  version?: string;
  allocationSummary?: { fullyAllocated: boolean; shortLines: { sku: string; short: number }[] };
}

export interface OrderQuery {
  customerId?: string;
  facilityId?: string;
  statuses?: OrderStatus[];
  onHold?: boolean;
  referenceNum?: string;
  referenceNumContains?: string;
  sku?: string;
  createdAfter?: string;
  createdBefore?: string;
  shippedAfter?: string;
  shippedBefore?: string;
  shipToNameContains?: string;
  limit?: number;
  page?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface LotPosition {
  lotNumber?: string;
  expirationDate?: string;
  location?: string;
  onHand: number;
  available: number;
  allocated: number;
  onHold: number;
  receivedAt?: string;
}

export interface InventoryPosition {
  sku: string;
  description?: string;
  customer: CustomerRef;
  facility: FacilityRef;
  qualifier?: string;
  onHand: number;
  available: number;
  allocated: number;
  onHold: number;
  lots?: LotPosition[];
}

export interface InventoryQuery {
  customerId?: string;
  facilityId?: string;
  skus?: string[];
  skuContains?: string;
  includeLots?: boolean;
  includeZero?: boolean;
  limit?: number;
}

export interface Item {
  sku: string;
  description?: string;
  upc?: string;
  customer: CustomerRef;
  active: boolean;
  unitOfMeasure?: string;
  dimensions?: { length?: number; width?: number; height?: number; unit?: string };
  weight?: { value?: number; unit?: string };
  trackLots?: boolean;
  trackExpiration?: boolean;
  trackSerials?: boolean;
  reorderPoint?: number;
}

export interface ItemQuery {
  customerId?: string;
  sku?: string;
  upc?: string;
  textSearch?: string;
  activeOnly?: boolean;
  limit?: number;
}

/**
 * Receipt (inbound ASN / receiver) lifecycle:
 * Open -> Complete -> Closed (Confirm Receipt), or Cancelled.
 * Source: https://help.extensiv.com/en_US/receipt-management/understanding-receipt-statuses
 */
export type ReceiptStatus = 'open' | 'complete' | 'closed' | 'cancelled';

export interface ReceiptSummary {
  id: string;
  referenceNum: string;
  poNum?: string;
  customer: CustomerRef;
  facility: FacilityRef;
  status: ReceiptStatus;
  createdAt: string;
  expectedDate?: string;
  arrivalDate?: string;
  closedAt?: string;
  lineCount: number;
  totalExpectedQty: number;
  totalReceivedQty: number;
  carrier?: string;
  trackingNumber?: string;
}

export interface ReceiptLine {
  lineId?: string;
  sku: string;
  description?: string;
  qtyExpected: number;
  qtyReceived: number;
  variance: number;
  lotNumber?: string;
  expirationDate?: string;
  location?: string;
}

export interface ReceiptDetail extends ReceiptSummary {
  lines: ReceiptLine[];
  supplier?: Address;
  notes?: string;
  version?: string;
  timeline: TimelineEvent[];
}

export interface ReceiptQuery {
  customerId?: string;
  facilityId?: string;
  statuses?: ReceiptStatus[];
  referenceNum?: string;
  poNum?: string;
  expectedAfter?: string;
  expectedBefore?: string;
  createdAfter?: string;
  limit?: number;
  page?: number;
}

export interface ConnectionStatus {
  ok: boolean;
  system: string;
  baseUrl: string;
  environmentLabel: string;
  authenticated: boolean;
  tokenExpiresInSeconds?: number;
  identity?: { userLogin?: string; tplId?: string; clientIdMasked?: string };
  reachableCustomers?: number;
  reachableFacilities?: number;
  latencyMs?: number;
  problems: string[];
}

/** An event ingested from the upstream system's webhooks (see webhook-ingest package). */
export interface WmsEvent {
  id: string;
  receivedAt: string;
  occurredAt: string;
  eventType: string;
  tags?: string;
  resourceType?: string;
  resourceId?: string;
  resourceHref?: string;
  customerId?: string;
  facilityId?: string;
  referenceNum?: string;
  summary: string;
  verified: boolean;
  raw?: unknown;
}
