/**
 * All mutable mock state plus the business rules that keep it consistent (stock ⇄ orders ⇄ receivers).
 * Routes are thin; seed data is built by replaying these same operations so the seeded world is
 * exactly as consistent as one produced through the API.
 */
import { randomBytes } from 'node:crypto';
import { modelValidation, operation } from './errors.js';
import { emptyFaults, type FaultConfig } from './faults.js';
import {
  ReceiverType,
  TransactionSource,
  TransactionStatus,
  type Allocation,
  type Carrier,
  type ContactInfo,
  type Customer,
  type CustomerIdentifier,
  type Facility,
  type FacilityIdentifier,
  type InventoryRow,
  type Item,
  type Location,
  type Order,
  type OrderCreateInput,
  type OrderItem,
  type OrderItemInput,
  type OrderSummaryRow,
  type Package,
  type ReceiveItem,
  type ReceiveItemInput,
  type Receiver,
  type ReceiverCreateInput,
  type RoutingInfo,
  type ShipmentTrackingRow,
  type StockDetailRow,
  type StockSummary,
} from './models.js';
import { addDays, ci, clone, etagFor, isBlank, parseCommaList, parseDate, rowVersionString, wireDate } from './util.js';
import { WebhookDispatcher, type EmitInput, type WebhookDelivery, type WebhookOptions } from './webhooks.js';

export interface MockCredentials {
  clientId: string;
  clientSecret: string;
  userLogin: string;
  tplGuid?: string;
}

export interface TokenRecord {
  token: string;
  userLogin: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface RequestLogEntry {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  at: string;
  /** Mock-only: set when a dropConnection fault destroyed the socket after the handler ran. */
  dropped?: boolean;
}

/** One received lot: the unit of stock. onHand = available + allocated + onHold always holds. */
export interface StockLot {
  receiveItemId: number;
  receiverId: number;
  customerId: number;
  facilityId: number;
  itemId: number;
  sku: string;
  qualifier: string | null;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  locationId: number;
  receivedQty: number;
  onHand: number;
  available: number;
  allocated: number;
  onHold: number;
  onHoldReason: string | null;
  onHoldDate: string | null;
  quarantined: boolean;
  receivedDate: string;
  referenceNum: string;
  poNum: string | null;
  trailerNumber: string | null;
  cost: number | null;
  rowVersion: number;
}

export interface OrderRecord {
  order: Order;
  items: OrderItem[];
  packages: Package[];
  rowVersion: number;
}

export interface ReceiverRecord {
  receiver: Receiver;
  items: ReceiveItem[];
  rowVersion: number;
}

export interface StateOptions {
  credentials: MockCredentials;
  tokenTtlSeconds: number;
  webhook: WebhookOptions;
  fetchImpl?: typeof fetch;
}

/** GUESS: the API user identity shown in createdByIdentifier is not documented; the mock uses the user_login. */
const API_USER_ID = 7;

export class MockState {
  readonly options: StateOptions;

  tokens = new Map<string, TokenRecord>();
  facilities: Facility[] = [];
  locations: Location[] = [];
  carriers: Carrier[] = [];
  customers: Customer[] = [];
  items: Item[] = [];
  orders: OrderRecord[] = [];
  receivers: ReceiverRecord[] = [];
  lots: StockLot[] = [];

  requests: RequestLogEntry[] = [];
  faults: FaultConfig = emptyFaults();
  readonly webhooks: WebhookDispatcher;

  private counters = {
    rowVersion: 1000,
    requestSeq: 0,
    orderId: 41000,
    orderItemId: 120000,
    packageId: 30000,
    packageContentId: 60000,
    receiverId: 7000,
    receiveItemId: 90000,
    contactId: 500,
  };

  constructor(options: StateOptions) {
    this.options = options;
    this.webhooks = new WebhookDispatcher(options.webhook, options.fetchImpl);
  }

  now(): Date {
    return new Date();
  }

  // ------------------------------------------------------------------------------------------
  // Reset / seeding hooks
  // ------------------------------------------------------------------------------------------

  clear(): void {
    this.tokens.clear();
    this.facilities = [];
    this.locations = [];
    this.carriers = [];
    this.customers = [];
    this.items = [];
    this.orders = [];
    this.receivers = [];
    this.lots = [];
    this.requests = [];
    this.faults = emptyFaults();
    this.webhooks.reset();
    this.counters = {
      rowVersion: 1000,
      requestSeq: 0,
      orderId: 41000,
      orderItemId: 120000,
      packageId: 30000,
      packageContentId: 60000,
      receiverId: 7000,
      receiveItemId: 90000,
      contactId: 500,
    };
  }

  /** Register the webhook subscriptions declared on seeded customers (customer.options.alerts.webHookParameters). */
  registerCustomerWebhooks(): void {
    for (const customer of this.customers) {
      for (const p of customer.options.alerts.webHookParameters) {
        this.webhooks.addSubscription({
          name: p.name,
          resource: p.resource,
          eventTypes: parseCommaList(p.eventTypes),
          url: p.url,
          includeResource: p.includeResource,
          resourceApiParameters: p.resourceApiParameters,
          customerId: customer.readOnly.customerId,
        });
      }
    }
  }

  get webhookDeliveries(): Promise<WebhookDelivery>[] {
    return this.webhooks.pending;
  }

  flushWebhooks(): Promise<WebhookDelivery[]> {
    return this.webhooks.flush();
  }

  // ------------------------------------------------------------------------------------------
  // Tokens (SOURCE: https://3w.extensiv.com/Rels/auth)
  // ------------------------------------------------------------------------------------------

  issueToken(userLogin: string): TokenRecord {
    const issuedAt = this.now();
    const rec: TokenRecord = {
      // Opaque random token; the real one is a JWT-looking string, but clients must treat it as opaque.
      token: randomBytes(32).toString('base64url'),
      userLogin,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.options.tokenTtlSeconds * 1000),
    };
    this.tokens.set(rec.token, rec);
    return rec;
  }

  validateToken(token: string): TokenRecord | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt.getTime() <= this.now().getTime()) {
      this.tokens.delete(token);
      return null;
    }
    return rec;
  }

  expireAllTokens(): void {
    this.tokens.clear();
  }

  // ------------------------------------------------------------------------------------------
  // Row versions / ETags
  // ------------------------------------------------------------------------------------------

  nextRowVersion(): number {
    return ++this.counters.rowVersion;
  }

  etagOfOrder(rec: OrderRecord): string {
    return etagFor(rec.rowVersion);
  }
  etagOfReceiver(rec: ReceiverRecord): string {
    return etagFor(rec.rowVersion);
  }
  etagOfItem(item: Item): string {
    return `"${item.readOnly.rowVersion}"`;
  }
  etagOfCustomer(customer: Customer): string {
    // Customers have no rowVersion on the wire; derive a stable one from creation date + id.
    // GUESS: shape of the customer ETag.
    return etagFor(1_000_000 + customer.readOnly.customerId);
  }

  nextRequestSeq(): number {
    return ++this.counters.requestSeq;
  }

  // ------------------------------------------------------------------------------------------
  // Lookups
  // ------------------------------------------------------------------------------------------

  customerById(id: number): Customer | undefined {
    return this.customers.find((c) => c.readOnly.customerId === id);
  }

  /** SOURCE: Rels/identifiers — id wins if supplied, otherwise name/externalId. */
  resolveCustomer(ident: Partial<CustomerIdentifier> | null | undefined): Customer | undefined {
    if (!ident) return undefined;
    if (ident.id !== undefined && ident.id !== null) return this.customerById(Number(ident.id));
    if (!isBlank(ident.name)) return this.customers.find((c) => ci(c.companyInfo.companyName, ident.name));
    if (!isBlank(ident.externalId)) return this.customers.find((c) => ci(c.externalId, ident.externalId));
    return undefined;
  }

  facilityById(id: number): Facility | undefined {
    return this.facilities.find((f) => f.facilityId === id);
  }

  resolveFacility(ident: Partial<FacilityIdentifier> | null | undefined): Facility | undefined {
    if (!ident) return undefined;
    if (ident.id !== undefined && ident.id !== null) return this.facilityById(Number(ident.id));
    if (!isBlank(ident.name)) return this.facilities.find((f) => ci(f.name, ident.name));
    return undefined;
  }

  itemsOfCustomer(customerId: number): Item[] {
    return this.items.filter((i) => i.readOnly.customerIdentifier.id === customerId);
  }

  resolveItem(customerId: number, ident: { sku?: string | null; id?: number | null } | null | undefined): Item | undefined {
    if (!ident) return undefined;
    const pool = this.itemsOfCustomer(customerId);
    if (ident.id !== undefined && ident.id !== null) return pool.find((i) => i.itemId === Number(ident.id));
    if (!isBlank(ident.sku)) return pool.find((i) => ci(i.sku, ident.sku));
    return undefined;
  }

  orderById(id: number): OrderRecord | undefined {
    return this.orders.find((o) => o.order.readOnly.orderId === id);
  }

  receiverById(id: number): ReceiverRecord | undefined {
    return this.receivers.find((r) => r.receiver.readOnly.receiverId === id);
  }

  lotByReceiveItemId(id: number): StockLot | undefined {
    return this.lots.find((l) => l.receiveItemId === id);
  }

  locationById(id: number): Location | undefined {
    return this.locations.find((l) => l.locationId === id);
  }

  customerIdentifier(c: Customer): CustomerIdentifier {
    return { externalId: c.externalId, name: c.companyInfo.companyName ?? '', id: c.readOnly.customerId };
  }
  facilityIdentifier(f: Facility): FacilityIdentifier {
    return { name: f.name, id: f.facilityId };
  }

  private apiUser(): { name: string; id: number } {
    return { name: this.options.credentials.userLogin, id: API_USER_ID };
  }

  // ------------------------------------------------------------------------------------------
  // Stock
  // ------------------------------------------------------------------------------------------

  /** Lots with available stock for an item at a facility, FIFO by received date (SOURCE: item inventoryMethod 1 FIFO). */
  private availableLots(customerId: number, facilityId: number, itemId: number, lotNumber: string | null): StockLot[] {
    return this.lots
      .filter(
        (l) =>
          l.customerId === customerId &&
          l.facilityId === facilityId &&
          l.itemId === itemId &&
          l.available > 0 &&
          (lotNumber === null || ci(l.lotNumber, lotNumber)),
      )
      .sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.receiveItemId - b.receiveItemId);
  }

  private allocateItem(rec: OrderRecord, item: OrderItem): void {
    const { customerIdentifier, facilityIdentifier } = rec.order.readOnly;
    let remaining = item.qty;
    const allocations: Allocation[] = [];
    for (const lot of this.availableLots(customerIdentifier.id, facilityIdentifier.id, item.itemIdentifier.id, item.lotNumber)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.available);
      lot.available -= take;
      lot.allocated += take;
      lot.rowVersion = this.nextRowVersion();
      remaining -= take;
      allocations.push({ receiveItemId: lot.receiveItemId, qty: take, detail: null });
    }
    item.readOnly.allocations = allocations;
    item.readOnly.fullyAllocated = remaining <= 0;
  }

  private releaseItem(item: OrderItem): void {
    for (const a of item.readOnly.allocations ?? []) {
      const lot = this.lotByReceiveItemId(a.receiveItemId);
      if (!lot) continue;
      lot.available += a.qty;
      lot.allocated -= a.qty;
      lot.rowVersion = this.nextRowVersion();
    }
    item.readOnly.allocations = [];
    item.readOnly.fullyAllocated = false;
  }

  /** Shipping consumes the allocation: onHand and allocated both drop so the invariant holds. */
  private shipItem(item: OrderItem): void {
    for (const a of item.readOnly.allocations ?? []) {
      const lot = this.lotByReceiveItemId(a.receiveItemId);
      if (!lot) continue;
      lot.onHand -= a.qty;
      lot.allocated -= a.qty;
      lot.rowVersion = this.nextRowVersion();
    }
  }

  private recomputeFullyAllocated(rec: OrderRecord): void {
    rec.order.readOnly.fullyAllocated = rec.items.length > 0 && rec.items.every((i) => i.readOnly.fullyAllocated);
  }

  allocateOrder(rec: OrderRecord): void {
    for (const item of rec.items) this.allocateItem(rec, item);
    this.recomputeFullyAllocated(rec);
  }

  releaseOrder(rec: OrderRecord): void {
    for (const item of rec.items) this.releaseItem(item);
    this.recomputeFullyAllocated(rec);
  }

  /** Mock-only stock adjustment used by /__mock/stock; creates a synthetic lot when needed. Re-allocates open short orders. */
  adjustStock(customerId: number, facilityId: number, sku: string, onHandDelta: number): StockLot {
    const item = this.resolveItem(customerId, { sku });
    if (!item) throw modelValidation('DoesNotExist', [{ Name: 'Sku', Value: sku }], 'Unknown sku for customer');
    let lot = this.lots.find((l) => l.customerId === customerId && l.facilityId === facilityId && l.itemId === item.itemId && l.lotNumber === null);
    if (!lot) {
      const location = this.locations.find((l) => l.facilityIdentifier.id === facilityId);
      lot = {
        receiveItemId: ++this.counters.receiveItemId,
        receiverId: 0,
        customerId,
        facilityId,
        itemId: item.itemId,
        sku: item.sku,
        qualifier: null,
        lotNumber: null,
        serialNumber: null,
        expirationDate: null,
        locationId: location?.locationId ?? 0,
        receivedQty: 0,
        onHand: 0,
        available: 0,
        allocated: 0,
        onHold: 0,
        onHoldReason: null,
        onHoldDate: null,
        quarantined: false,
        receivedDate: wireDate(this.now()),
        referenceNum: 'MOCK-ADJ',
        poNum: null,
        trailerNumber: null,
        cost: item.cost,
        rowVersion: this.nextRowVersion(),
      };
      this.lots.push(lot);
    }
    if (onHandDelta < 0 && lot.available + onHandDelta < 0) {
      throw modelValidation('ValueNotSupported', [{ Name: 'OnHandDelta', Value: onHandDelta }], 'Cannot reduce below available');
    }
    lot.onHand += onHandDelta;
    lot.available += onHandDelta;
    if (onHandDelta > 0) lot.receivedQty += onHandDelta;
    lot.rowVersion = this.nextRowVersion();
    if (onHandDelta > 0) this.reallocateShortOrders(customerId, facilityId, item.itemId);
    return lot;
  }

  /** New stock lets short open orders fill (the real WMS re-allocates on receipt; SOURCE: help center "Overallocated" settings — GUESS on timing). */
  private reallocateShortOrders(customerId: number, facilityId: number, itemId: number): void {
    for (const rec of this.orders) {
      const ro = rec.order.readOnly;
      if (ro.status !== TransactionStatus.Open || ro.customerIdentifier.id !== customerId || ro.facilityIdentifier.id !== facilityId) continue;
      for (const item of rec.items) {
        if (item.itemIdentifier.id !== itemId || item.readOnly.fullyAllocated) continue;
        const already = (item.readOnly.allocations ?? []).reduce((s, a) => s + a.qty, 0);
        let remaining = item.qty - already;
        for (const lot of this.availableLots(customerId, facilityId, itemId, item.lotNumber)) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, lot.available);
          lot.available -= take;
          lot.allocated += take;
          remaining -= take;
          (item.readOnly.allocations ??= []).push({ receiveItemId: lot.receiveItemId, qty: take, detail: null });
        }
        item.readOnly.fullyAllocated = remaining <= 0;
      }
      this.recomputeFullyAllocated(rec);
    }
  }

  /** SOURCE: https://3w.extensiv.com/rels/inventory/inventoryhold — PUT /inventory/holder{?holdReason,release}. */
  holdLots(receiveItemIds: number[], holdReason: string | null, release: boolean): number[] {
    const done: number[] = [];
    for (const id of receiveItemIds) {
      const lot = this.lotByReceiveItemId(id);
      if (!lot) continue;
      if (release) {
        lot.available += lot.onHold;
        lot.onHold = 0;
        lot.onHoldReason = null;
        lot.onHoldDate = null;
      } else {
        // GUESS: holding a lot moves everything not already allocated onto hold.
        lot.onHold += lot.available;
        lot.available = 0;
        lot.onHoldReason = holdReason;
        lot.onHoldDate = wireDate(this.now());
      }
      lot.rowVersion = this.nextRowVersion();
      done.push(id);
      const receiver = this.receiverById(lot.receiverId);
      const ri = receiver?.items.find((i) => i.readOnly.receiveItemId === id);
      if (ri) {
        ri.onHold = !release;
        ri.onHoldReason = release ? null : holdReason;
        ri.readOnly.onHoldDate = lot.onHoldDate;
        ri.readOnly.inventoryLevels = { onHand: lot.onHand, available: lot.available };
      }
      this.emitWebhook({
        // GUESS: event names for Inventory Hold are inferred from the help-center labels
        // "Inventory Hold (Place on Hold, Release from Hold)"; only Order* names are shown verbatim.
        eventType: release ? 'InventoryHoldRelease' : 'InventoryHoldPlace',
        resource: 'InventorySummary',
        resourceRel: 'inventory/inventory',
        resourceId: id,
        resourcePath: `/inventory/stockdetails?customerid=${lot.customerId}&facilityid=${lot.facilityId}`,
        customerId: lot.customerId,
        facilityId: lot.facilityId,
        data: { ReceiveItemId: String(id) },
      });
    }
    return done;
  }

  // ------------------------------------------------------------------------------------------
  // Stock views (SOURCE: https://3w.extensiv.com/rels/inventory/stocksummaries ; /stockdetails ; /inventory)
  // ------------------------------------------------------------------------------------------

  /** Summary rows, augmented with customerIdentifier for rql scoping (stripped before output). */
  stockSummaries(): (StockSummary & { customerIdentifier: CustomerIdentifier })[] {
    const groups = new Map<string, StockSummary & { customerIdentifier: CustomerIdentifier }>();
    for (const lot of this.lots) {
      const key = `${lot.customerId}|${lot.facilityId}|${lot.itemId}|${lot.qualifier ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        const customer = this.customerById(lot.customerId);
        if (!customer) continue;
        g = {
          itemIdentifier: { sku: lot.sku, id: lot.itemId },
          qualifier: lot.qualifier,
          totalReceived: 0,
          allocated: 0,
          available: 0,
          onHold: 0,
          onHand: 0,
          orderedNotAllocated: null,
          facilityId: lot.facilityId,
          customerIdentifier: this.customerIdentifier(customer),
        };
        groups.set(key, g);
      }
      g.totalReceived += lot.receivedQty;
      g.allocated += lot.allocated;
      g.available += lot.available;
      g.onHold += lot.onHold;
      g.onHand += lot.onHand;
    }
    // orderedNotAllocated = open order demand not covered by allocations for that item/facility.
    for (const g of groups.values()) {
      let unallocated = 0;
      for (const rec of this.orders) {
        const ro = rec.order.readOnly;
        if (ro.status !== TransactionStatus.Open || ro.customerIdentifier.id !== g.customerIdentifier.id || ro.facilityIdentifier.id !== g.facilityId) continue;
        for (const item of rec.items) {
          if (item.itemIdentifier.id !== g.itemIdentifier.id) continue;
          const allocated = (item.readOnly.allocations ?? []).reduce((s, a) => s + a.qty, 0);
          unallocated += Math.max(0, item.qty - allocated);
        }
      }
      g.orderedNotAllocated = unallocated;
    }
    return [...groups.values()];
  }

  private locationIdentifierOf(lot: StockLot): StockDetailRow['locationIdentifier'] {
    const loc = this.locationById(lot.locationId);
    const fac = this.facilityById(lot.facilityId);
    return {
      nameKey: { facilityIdentifier: { name: fac?.name ?? '', id: lot.facilityId }, name: loc?.name ?? '' },
      id: lot.locationId,
    };
  }

  stockDetails(customerId: number, facilityId: number): StockDetailRow[] {
    const rows: StockDetailRow[] = [];
    for (const lot of this.lots) {
      if (lot.customerId !== customerId || lot.facilityId !== facilityId) continue;
      // SOURCE: stockdetails — rows are receive items with stock; fully shipped lots vanish (GUESS: onHand 0 rows are omitted).
      if (lot.onHand <= 0) continue;
      const item = this.items.find((i) => i.itemId === lot.itemId);
      const receiver = this.receiverById(lot.receiverId);
      rows.push({
        receiveItemId: lot.receiveItemId,
        itemIdentifier: { sku: lot.sku, id: lot.itemId },
        description: item?.description ?? '',
        description2: item?.description2 ?? null,
        upc: item?.upc ?? null,
        qualifier: lot.qualifier,
        received: lot.receivedQty,
        available: lot.available,
        isOnHold: lot.onHold > 0,
        quarantined: lot.quarantined,
        onHand: lot.onHand,
        lotNumber: lot.lotNumber,
        serialNumber: lot.serialNumber,
        expirationDate: lot.expirationDate,
        cost: lot.cost,
        supplierIdentifier: null,
        locationIdentifier: this.locationIdentifierOf(lot),
        inventoryUnitOfMeasureIdentifier: item?.options.inventoryUnit.unitIdentifier ?? { name: 'Each', id: 1 },
        receiverId: lot.receiverId,
        receivedDate: lot.receivedDate,
        referenceNum: lot.referenceNum,
        poNum: lot.poNum,
        trailerNumber: receiver?.receiver.trailerNumber ?? lot.trailerNumber,
        savedElements: [],
        weightImperial: item?.options.inventoryUnit.imperial.weight ?? null,
      });
    }
    return rows;
  }

  inventoryRows(): InventoryRow[] {
    const now = this.now();
    const rows: InventoryRow[] = [];
    for (const lot of this.lots) {
      if (lot.onHand <= 0) continue;
      const item = this.items.find((i) => i.itemId === lot.itemId);
      const customer = this.customerById(lot.customerId);
      const facility = this.facilityById(lot.facilityId);
      if (!customer || !facility) continue;
      const receiver = this.receiverById(lot.receiverId);
      rows.push({
        receiverId: lot.receiverId,
        receivedDate: lot.receivedDate,
        receiveItemId: lot.receiveItemId,
        customerIdentifier: this.customerIdentifier(customer),
        facilityIdentifier: this.facilityIdentifier(facility),
        itemIdentifier: { sku: lot.sku, id: lot.itemId },
        itemDescription: item?.description ?? '',
        description2: item?.description2 ?? null,
        upc: item?.upc ?? null,
        qualifier: lot.qualifier,
        inventoryUnitOfMeasureIdentifier: item?.options.inventoryUnit.unitIdentifier ?? { name: 'Each', id: 1 },
        receivedQty: lot.receivedQty,
        onHandQty: lot.onHand,
        availableQty: lot.available,
        onHoldQty: lot.onHold,
        inventoryAgeDays: Math.max(0, Math.floor((now.getTime() - Date.parse(`${lot.receivedDate}Z`)) / 86_400_000)),
        lotNumber: lot.lotNumber,
        serialNumber: lot.serialNumber,
        expirationDate: lot.expirationDate,
        cost: lot.cost,
        supplierIdentifier: null,
        locationIdentifier: this.locationIdentifierOf(lot),
        onHold: lot.onHold > 0,
        onHoldReason: lot.onHoldReason,
        onHoldDate: lot.onHoldDate,
        quarantined: lot.quarantined,
        rowVersion: rowVersionString(lot.rowVersion),
        referenceNum: lot.referenceNum,
        poNum: lot.poNum,
        trailerNumber: receiver?.receiver.trailerNumber ?? lot.trailerNumber,
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------------------------------
  // Orders (SOURCE: https://3w.extensiv.com/rels/orders/orders ; /rels/orders/order and operator rels)
  // ------------------------------------------------------------------------------------------

  private normalizeContact(input: Partial<ContactInfo> | null | undefined, assignId: boolean): ContactInfo | null {
    if (!input) return null;
    return {
      contactId: input.contactId ?? (assignId ? ++this.counters.contactId : null),
      companyName: input.companyName ?? null,
      name: input.name ?? null,
      title: input.title ?? null,
      address1: input.address1 ?? null,
      address2: input.address2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      country: input.country ?? null,
      phoneNumber: input.phoneNumber ?? null,
      fax: input.fax ?? null,
      emailAddress: input.emailAddress ?? null,
      dept: input.dept ?? null,
      isAddressResidential: input.isAddressResidential ?? null,
      code: input.code ?? null,
      addressStatus: input.addressStatus ?? 0,
    };
  }

  private normalizeRouting(input: Partial<RoutingInfo> | null | undefined): RoutingInfo {
    return {
      isCod: input?.isCod ?? false,
      isInsurance: input?.isInsurance ?? false,
      requiresDeliveryConf: input?.requiresDeliveryConf ?? false,
      scacCode: input?.scacCode ?? null,
      carrier: input?.carrier ?? null,
      mode: input?.mode ?? null,
      account: input?.account ?? null,
      shipPointZip: input?.shipPointZip ?? null,
      capacityTypeIdentifier: input?.capacityTypeIdentifier ?? null,
      loadNumber: input?.loadNumber ?? null,
      billOfLading: input?.billOfLading ?? null,
      trackingNumber: input?.trackingNumber ?? null,
      trailerNumber: input?.trailerNumber ?? null,
      sealNumber: input?.sealNumber ?? null,
      doorNumber: input?.doorNumber ?? null,
      pickupDate: input?.pickupDate ?? null,
    };
  }

  private buildOrderItems(customer: Customer, inputs: OrderItemInput[]): OrderItem[] {
    const items: OrderItem[] = [];
    inputs.forEach((input, idx) => {
      const prefix = `OrderItems[${idx}]`;
      if (!input.itemIdentifier || (isBlank(input.itemIdentifier.sku) && input.itemIdentifier.id == null)) {
        throw modelValidation('Required', [{ Name: `${prefix}.ItemIdentifier`, Value: null }], 'Each order item needs an itemIdentifier (sku or id)');
      }
      const item = this.resolveItem(customer.readOnly.customerId, input.itemIdentifier);
      if (!item || item.readOnly.deactivated) {
        // GUESS: a deactivated item is reported as DoesNotExist; the docs only name the unknown-sku case.
        throw modelValidation(
          'DoesNotExist',
          [{ Name: `${prefix}.ItemIdentifier.Sku`, Value: input.itemIdentifier.sku ?? String(input.itemIdentifier.id) }],
          `Sku does not exist for customer ${customer.readOnly.customerId}`,
        );
      }
      if (input.qty === undefined || input.qty === null) {
        throw modelValidation('Required', [{ Name: `${prefix}.Qty`, Value: null }], 'Qty is required');
      }
      if (typeof input.qty !== 'number' || !Number.isFinite(input.qty) || input.qty <= 0) {
        // SOURCE: Rels/exceptions ValueNotSupported "such as a negative number not allowed".
        throw modelValidation('ValueNotSupported', [{ Name: `${prefix}.Qty`, Value: String(input.qty) }], 'Qty must be a positive number');
      }
      // SOURCE: rels/customers/item trackLotNumber 2 = Require.
      if (item.options.trackBys.trackLotNumber === 2 && isBlank(input.lotNumber)) {
        throw modelValidation('Required', [{ Name: `${prefix}.LotNumber`, Value: null }], `Sku ${item.sku} requires a lot number`);
      }
      const rv = this.nextRowVersion();
      items.push({
        readOnly: {
          orderItemId: ++this.counters.orderItemId,
          fullyAllocated: false,
          unitIdentifier: item.options.inventoryUnit.unitIdentifier,
          originalPrimaryQty: input.qty,
          allocations: [],
          rowVersion: rowVersionString(rv),
        },
        itemIdentifier: { sku: item.sku, id: item.itemId },
        qualifier: input.qualifier ?? null,
        externalId: input.externalId ?? null,
        qty: input.qty,
        secondaryQty: input.secondaryQty ?? null,
        lotNumber: input.lotNumber ?? null,
        serialNumber: input.serialNumber ?? null,
        expirationDate: input.expirationDate ?? null,
        notes: input.notes ?? null,
        savedElements: input.savedElements ?? [],
      });
    });
    return items;
  }

  private assertUniqueReferenceNum(customerId: number, referenceNum: string, exceptOrderId: number | null): void {
    // SOURCE: Rels/exceptions Duplicate "such as a duplicate order ReferenceNum".
    // GUESS: the uniqueness scope is per customer and includes cancelled orders; the docs do not say.
    const dup = this.orders.find(
      (o) => o.order.readOnly.customerIdentifier.id === customerId && ci(o.order.referenceNum, referenceNum) && o.order.readOnly.orderId !== exceptOrderId,
    );
    if (dup) {
      throw modelValidation('Duplicate', [{ Name: 'ReferenceNum', Value: referenceNum }], `ReferenceNum already exists on order ${dup.order.readOnly.orderId}`);
    }
  }

  createOrder(input: OrderCreateInput, opts: { at?: Date; source?: number; emit?: boolean } = {}): OrderRecord {
    const at = opts.at ?? this.now();
    if (isBlank(input.referenceNum)) throw modelValidation('Required', [{ Name: 'ReferenceNum', Value: null }], 'ReferenceNum is required');
    if (!input.customerIdentifier) throw modelValidation('Required', [{ Name: 'CustomerIdentifier', Value: null }], 'CustomerIdentifier is required');
    const customer = this.resolveCustomer(input.customerIdentifier);
    if (!customer || customer.readOnly.deactivated) {
      throw modelValidation(
        'DoesNotExist',
        [{ Name: 'CustomerIdentifier', Value: JSON.stringify(input.customerIdentifier) }],
        'Customer does not exist or is deactivated',
      );
    }
    if (!input.facilityIdentifier) throw modelValidation('Required', [{ Name: 'FacilityIdentifier', Value: null }], 'FacilityIdentifier is required');
    const facility = this.resolveFacility(input.facilityIdentifier);
    if (!facility || !customer.facilities.some((f) => f.id === facility.facilityId)) {
      throw modelValidation(
        'DoesNotExist',
        [{ Name: 'FacilityIdentifier', Value: JSON.stringify(input.facilityIdentifier) }],
        'Facility does not exist or is not assigned to the customer',
      );
    }
    if (!input.shipTo) throw modelValidation('Required', [{ Name: 'ShipTo', Value: null }], 'ShipTo is required');
    if (!input.orderItems || input.orderItems.length === 0) {
      throw modelValidation('Required', [{ Name: 'OrderItems', Value: null }], 'At least one order item is required');
    }
    const referenceNum = (input.referenceNum as string).trim();
    this.assertUniqueReferenceNum(customer.readOnly.customerId, referenceNum, null);
    if (input.orderType != null && !['B2B', 'D2C', 'AmazonFBA'].includes(input.orderType)) {
      // SOURCE: rels/orders/order — OrderType must be one of B2B, D2C, AmazonFBA.
      throw modelValidation('ValueNotSupported', [{ Name: 'OrderType', Value: input.orderType }], 'OrderType must be B2B, D2C or AmazonFBA');
    }

    const items = this.buildOrderItems(customer, input.orderItems);
    const orderId = ++this.counters.orderId;
    const stamp = wireDate(at);
    const order: Order = {
      readOnly: {
        orderId,
        fullyAllocated: false,
        isClosed: false,
        processDate: null,
        pickStarted: false,
        pickDoneDate: null,
        packStarted: false,
        packDoneDate: null,
        asnSentDate: null,
        batchIdentifier: null,
        smallParcelShipDate: null,
        shipDate: null,
        onHoldDate: null,
        onHoldReason: null,
        customerIdentifier: this.customerIdentifier(customer),
        facilityIdentifier: this.facilityIdentifier(facility),
        // SOURCE: rels/orders/orders WarehouseTransactionSourceType 7 = RestApi.
        warehouseTransactionSourceType: opts.source ?? TransactionSource.RestApi,
        creationDate: stamp,
        createdByIdentifier: this.apiUser(),
        lastModifiedDate: stamp,
        lastModifiedByIdentifier: this.apiUser(),
        status: TransactionStatus.Open,
        chargesPending: false,
      },
      referenceNum,
      description: input.description ?? null,
      poNum: input.poNum ?? null,
      externalId: input.externalId ?? null,
      earliestShipDate: input.earliestShipDate ?? null,
      shipCancelDate: input.shipCancelDate ?? null,
      notes: input.notes ?? null,
      numUnits1: input.numUnits1 ?? null,
      totalWeight: input.totalWeight ?? null,
      totalVolume: input.totalVolume ?? null,
      billingCode: input.billingCode ?? null,
      asnNumber: input.asnNumber ?? null,
      shippingNotes: input.shippingNotes ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      routingInfo: this.normalizeRouting(input.routingInfo),
      billing: { billingCharges: [] },
      shipTo: this.normalizeContact(input.shipTo, true) as ContactInfo,
      soldTo: this.normalizeContact(input.soldTo, true),
      billTo: this.normalizeContact(input.billTo, true),
      savedElements: input.savedElements ?? [],
      parcelResponse: null,
      expectedDeliveryDate: input.expectedDeliveryDate ?? null,
      orderType: input.orderType ?? null,
    };
    const rec: OrderRecord = { order, items, packages: [], rowVersion: this.nextRowVersion() };
    this.orders.push(rec);
    this.allocateOrder(rec);
    if (opts.emit !== false) this.emitOrderEvent(rec, 'OrderCreate', at);
    return rec;
  }

  /** SOURCE: rels/orders/order PUT "Updates an unconfirmed order"; replaces writable fields. */
  updateOrder(rec: OrderRecord, input: OrderCreateInput, replaceItems: boolean, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    this.assertOpen(rec, 'order');
    const order = rec.order;
    if (input.referenceNum !== undefined) {
      if (isBlank(input.referenceNum)) throw modelValidation('Required', [{ Name: 'ReferenceNum', Value: null }], 'ReferenceNum is required');
      const referenceNum = (input.referenceNum as string).trim();
      this.assertUniqueReferenceNum(order.readOnly.customerIdentifier.id, referenceNum, order.readOnly.orderId);
      order.referenceNum = referenceNum;
    }
    const scalar = [
      'description',
      'poNum',
      'externalId',
      'earliestShipDate',
      'shipCancelDate',
      'notes',
      'numUnits1',
      'totalWeight',
      'totalVolume',
      'billingCode',
      'asnNumber',
      'shippingNotes',
      'invoiceNumber',
      'expectedDeliveryDate',
      'orderType',
    ] as const;
    for (const key of scalar) {
      if (key in input) (order as unknown as Record<string, unknown>)[key] = input[key] ?? null;
    }
    if (input.routingInfo !== undefined) order.routingInfo = this.normalizeRouting({ ...order.routingInfo, ...(input.routingInfo ?? {}) });
    if (input.shipTo !== undefined && input.shipTo !== null) order.shipTo = this.normalizeContact(input.shipTo, true) as ContactInfo;
    if (input.soldTo !== undefined) order.soldTo = this.normalizeContact(input.soldTo, true);
    if (input.billTo !== undefined) order.billTo = this.normalizeContact(input.billTo, true);
    if (input.savedElements !== undefined) order.savedElements = input.savedElements ?? [];
    if (replaceItems && input.orderItems) {
      const customer = this.customerById(order.readOnly.customerIdentifier.id) as Customer;
      const newItems = this.buildOrderItems(customer, input.orderItems);
      this.releaseOrder(rec);
      rec.items = newItems;
      this.allocateOrder(rec);
    }
    order.readOnly.lastModifiedDate = wireDate(at);
    order.readOnly.lastModifiedByIdentifier = this.apiUser();
    rec.rowVersion = this.nextRowVersion();
    this.emitOrderEvent(rec, 'OrderUpdate', at);
  }

  private assertOpen(rec: OrderRecord, actionName: string): void {
    const s = rec.order.readOnly.status;
    // SOURCE: Rels/exceptions OperationException codes OrderConfirmed / OrderCanceled.
    if (s === TransactionStatus.Closed) throw operation('OrderConfirmed', actionName, `Order ${rec.order.readOnly.orderId} is confirmed (closed)`);
    if (s === TransactionStatus.Canceled) throw operation('OrderCanceled', actionName, `Order ${rec.order.readOnly.orderId} is canceled`);
  }

  /** SOURCE: https://3w.extensiv.com/rels/orders/ordercancel — "Cancel an open order"; reason required. */
  cancelOrder(rec: OrderRecord, reason: string | null | undefined, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    if (isBlank(reason)) throw modelValidation('Required', [{ Name: 'Reason', Value: null }], 'Reason is required');
    this.assertOpen(rec, 'ordercancel');
    this.releaseOrder(rec);
    rec.order.readOnly.status = TransactionStatus.Canceled;
    rec.order.readOnly.lastModifiedDate = wireDate(at);
    rec.order.notes = rec.order.notes ? `${rec.order.notes}\nCanceled: ${reason}` : `Canceled: ${reason}`;
    rec.rowVersion = this.nextRowVersion();
    this.emitOrderEvent(rec, 'OrderCancel', at);
  }

  /** SOURCE: https://3w.extensiv.com/rels/orders/orderconfirm — ship & close; 403 NotFullyAllocated / DateInFuture. */
  confirmOrder(
    rec: OrderRecord,
    body: { confirmDate?: string | null; trackingNumber?: string | null; trailerNumber?: string | null; sealNumber?: string | null; billOfLading?: string | null; loadNumber?: string | null; doorNumber?: string | null; pickupDate?: string | null },
    opts: { at?: Date } = {},
  ): void {
    const at = opts.at ?? this.now();
    this.assertOpen(rec, 'orderconfirm');
    const ro = rec.order.readOnly;
    if (ro.onHoldDate !== null) throw operation('OnHold', 'orderconfirm', `Order ${ro.orderId} is on hold: ${ro.onHoldReason ?? ''}`);
    if (!ro.fullyAllocated) throw operation('NotFullyAllocated', 'orderconfirm', `Order ${ro.orderId} is not fully allocated`);
    const confirmDate = body.confirmDate ? parseDate(body.confirmDate) : null;
    if (body.confirmDate && !confirmDate) {
      throw modelValidation('ValueNotSupported', [{ Name: 'ConfirmDate', Value: body.confirmDate }], 'ConfirmDate is not a date');
    }
    if (confirmDate && confirmDate.getTime() > this.now().getTime() + 60_000) throw operation('DateInFuture', 'orderconfirm', 'ConfirmDate is in the future');
    const shipDate = confirmDate ?? at;
    for (const item of rec.items) this.shipItem(item);
    ro.isClosed = true;
    ro.status = TransactionStatus.Closed;
    ro.shipDate = wireDate(shipDate);
    ro.processDate ??= wireDate(shipDate);
    ro.pickStarted = true;
    ro.pickDoneDate = wireDate(shipDate);
    ro.packStarted = true;
    ro.packDoneDate = wireDate(shipDate);
    ro.lastModifiedDate = wireDate(at);
    const r = rec.order.routingInfo;
    if (body.trackingNumber !== undefined) r.trackingNumber = body.trackingNumber ?? null;
    if (body.trailerNumber !== undefined) r.trailerNumber = body.trailerNumber ?? null;
    if (body.sealNumber !== undefined) r.sealNumber = body.sealNumber ?? null;
    if (body.billOfLading !== undefined) r.billOfLading = body.billOfLading ?? null;
    if (body.loadNumber !== undefined) r.loadNumber = body.loadNumber ?? null;
    if (body.doorNumber !== undefined) r.doorNumber = body.doorNumber ?? null;
    if (body.pickupDate !== undefined) r.pickupDate = body.pickupDate ?? null;
    // GUESS: confirming through the API yields one package holding every line; real packages come from packing.
    if (rec.packages.length === 0) this.buildSinglePackage(rec, r.trackingNumber, shipDate);
    if (r.trackingNumber) rec.order.parcelResponse = { orderId: ro.orderId, trackingNumbers: [r.trackingNumber], returnTrackingNumbers: [] };
    rec.rowVersion = this.nextRowVersion();
    // SOURCE: implementing-webhooks sample — OrderConfirm carries tags "Shipped".
    this.emitOrderEvent(rec, 'OrderConfirm', at, 'Shipped');
  }

  private buildSinglePackage(rec: OrderRecord, trackingNumber: string | null, at: Date): void {
    const packageId = ++this.counters.packageId;
    const contents = rec.items.flatMap((item) =>
      (item.readOnly.allocations ?? []).map((a) => {
        const lot = this.lotByReceiveItemId(a.receiveItemId);
        return {
          packageContentId: ++this.counters.packageContentId,
          packageId,
          orderItemId: item.readOnly.orderItemId,
          receiveItemId: a.receiveItemId,
          qty: a.qty,
          lotNumber: lot?.lotNumber ?? null,
          serialNumber: lot?.serialNumber ?? null,
          expirationDate: lot?.expirationDate ?? null,
          createDate: wireDate(at),
          itemIdentifier: item.itemIdentifier,
        };
      }),
    );
    const weight = rec.items.reduce((s, item) => {
      const it = this.items.find((i) => i.itemId === item.itemIdentifier.id);
      return s + (it?.options.inventoryUnit.imperial.weight ?? 0) * item.qty;
    }, 0);
    rec.packages.push({
      packageId,
      packageTypeId: 1,
      packageDefIdentifier: { name: 'Box', id: 1 },
      length: 18,
      width: 12,
      height: 10,
      weight: Math.round(weight * 100) / 100,
      trackingNumber,
      description: null,
      createDate: wireDate(at),
      _embedded: { 'http://api.3plCentral.com/rels/orders/packagecontent': contents },
    });
  }

  /** SOURCE: https://3w.extensiv.com/rels/orders/ordercomplete — POST /orders/{id}/completer, If-Match, 204. */
  completeOrder(rec: OrderRecord, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    this.assertOpen(rec, 'ordercomplete');
    // SOURCE: Rels/exceptions AlreadyCompleted. GUESS: "complete" is modelled as readOnly.processDate being set.
    if (rec.order.readOnly.processDate !== null) throw operation('AlreadyCompleted', 'ordercomplete', `Order ${rec.order.readOnly.orderId} already completed`);
    rec.order.readOnly.processDate = wireDate(at);
    rec.order.readOnly.lastModifiedDate = wireDate(at);
    rec.rowVersion = this.nextRowVersion();
    this.emitOrderEvent(rec, 'OrderComplete', at);
  }

  /** SOURCE: https://3w.extensiv.com/rels/orders/orderholder — PUT /orders/orderholder{?holdReason,release}. */
  holdOrders(ids: number[], holdReason: string | null, release: boolean, opts: { at?: Date } = {}): { heldOrderIds: number[]; faults: { entryNumber: number; entryInfo: string }[] } {
    const at = opts.at ?? this.now();
    const held: number[] = [];
    const faults: { entryNumber: number; entryInfo: string }[] = [];
    ids.forEach((id, idx) => {
      const rec = this.orderById(id);
      if (!rec) {
        faults.push({ entryNumber: idx + 1, entryInfo: `Order ${id} does not exist` });
        return;
      }
      const ro = rec.order.readOnly;
      if (ro.status !== TransactionStatus.Open) {
        faults.push({ entryNumber: idx + 1, entryInfo: `Order ${id} is not open` });
        return;
      }
      if (release) {
        ro.onHoldDate = null;
        ro.onHoldReason = null;
      } else {
        ro.onHoldDate = wireDate(at);
        ro.onHoldReason = holdReason;
      }
      ro.lastModifiedDate = wireDate(at);
      rec.rowVersion = this.nextRowVersion();
      held.push(id);
      // GUESS: a hold/release is surfaced to webhooks as OrderUpdate; no dedicated event name is documented.
      this.emitOrderEvent(rec, 'OrderUpdate', at);
    });
    return { heldOrderIds: held, faults };
  }

  private emitOrderEvent(rec: OrderRecord, eventType: string, at: Date, tags = ''): void {
    const ro = rec.order.readOnly;
    this.emitWebhook(
      {
        eventType,
        resource: 'Order',
        resourceRel: 'orders/order',
        resourceId: ro.orderId,
        resourcePath: `/orders/${ro.orderId}`,
        customerId: ro.customerIdentifier.id,
        facilityId: ro.facilityIdentifier.id,
        tags,
        resourceBody: this.renderOrder(rec, { items: true, packages: false, allocations: false }),
      },
      at,
    );
  }

  emitWebhook(input: EmitInput, at: Date = this.now()): WebhookDelivery[] {
    return this.webhooks.emit(input, at);
  }

  /** Wire rendering of an order with optional embedded children and state-conditional links. */
  renderOrder(rec: OrderRecord, detail: { items: boolean; packages: boolean; allocations: boolean; allocationDetail?: boolean }): Record<string, unknown> {
    const order = clone(rec.order);
    const ro = order.readOnly;
    const id = ro.orderId;
    const links: Record<string, { href: string }> = { self: { href: `/orders/${id}` } };
    const open = ro.status === TransactionStatus.Open;
    // SOURCE: Rels/billboard "Operator rels are present only if the state change is valid for the given resource"
    // and the link list on rels/orders/order. GUESS: the exact conditions per link.
    if (open) links.edit = { href: `/orders/${id}` };
    links['http://api.3plCentral.com/rels/orders/items'] = { href: `/orders/${id}/items` };
    links['http://api.3plCentral.com/rels/orders/packages'] = { href: `/orders/${id}/packages` };
    links['http://api.3plCentral.com/rels/customers/customer'] = { href: `/customers/${ro.customerIdentifier.id}` };
    links['http://api.3plCentral.com/rels/properties/facility'] = { href: `/properties/facilities/${ro.facilityIdentifier.id}` };
    if (open) {
      links['http://api.3plCentral.com/rels/orders/ordercancel'] = { href: `/orders/${id}/canceler` };
      if (ro.fullyAllocated && ro.onHoldDate === null) links['http://api.3plCentral.com/rels/orders/orderconfirm'] = { href: `/orders/${id}/confirmer` };
      if (ro.processDate === null) links['http://api.3plCentral.com/rels/orders/ordercomplete'] = { href: `/orders/${id}/completer` };
      if (!ro.fullyAllocated) links['http://api.3plCentral.com/rels/orders/orderallocate'] = { href: `/orders/${id}/allocator` };
      if (rec.items.some((i) => (i.readOnly.allocations ?? []).length > 0)) links['http://api.3plCentral.com/rels/orders/orderdeallocate'] = { href: `/orders/${id}/deallocator` };
    }
    if (ro.status === TransactionStatus.Closed) links['http://api.3plCentral.com/rels/orders/orderunconfirm'] = { href: `/orders/${id}/unconfirmer` };

    const out: Record<string, unknown> = { ...order };
    const embedded: Record<string, unknown> = {};
    if (detail.items) {
      embedded['http://api.3plCentral.com/rels/orders/item'] = rec.items.map((i) => this.renderOrderItem(rec, i, detail.allocations, detail.allocationDetail ?? false));
    }
    if (detail.packages) {
      embedded['http://api.3plCentral.com/rels/orders/package'] = clone(rec.packages);
    }
    if (Object.keys(embedded).length > 0) out._embedded = embedded;
    out._links = links;
    return out;
  }

  renderOrderItem(rec: OrderRecord, item: OrderItem, withAllocations: boolean, withDetail: boolean): Record<string, unknown> {
    const copy = clone(item);
    if (!withAllocations) {
      copy.readOnly.allocations = null;
    } else if (withDetail) {
      copy.readOnly.allocations = (copy.readOnly.allocations ?? []).map((a) => {
        const lot = this.lotByReceiveItemId(a.receiveItemId);
        return {
          ...a,
          detail: lot
            ? {
                itemTraits: {
                  itemIdentifier: { sku: lot.sku, id: lot.itemId },
                  qualifier: lot.qualifier,
                  lotNumber: lot.lotNumber,
                  serialNumber: lot.serialNumber,
                  expirationDate: lot.expirationDate,
                },
                locationIdentifier: this.locationIdentifierOf(lot),
              }
            : null,
        };
      });
    }
    return {
      ...copy,
      _links: {
        self: { href: `/orders/${rec.order.readOnly.orderId}/items/${item.readOnly.orderItemId}` },
        'http://api.3plCentral.com/rels/orders/order': { href: `/orders/${rec.order.readOnly.orderId}` },
        'http://api.3plCentral.com/rels/customers/item': { href: `/customers/${rec.order.readOnly.customerIdentifier.id}/items/${item.itemIdentifier.id}` },
      },
    };
  }

  orderSummaries(): OrderSummaryRow[] {
    return this.orders.map(({ order }) => ({
      orderId: order.readOnly.orderId,
      referenceNum: order.referenceNum,
      poNum: order.poNum,
      fullyAllocated: order.readOnly.fullyAllocated,
      customerIdentifier: order.readOnly.customerIdentifier,
      facilityIdentifier: order.readOnly.facilityIdentifier,
      creationDate: order.readOnly.creationDate,
      isClosed: order.readOnly.isClosed,
    }));
  }

  shipmentTrackingRows(): ShipmentTrackingRow[] {
    const rows: ShipmentTrackingRow[] = [];
    for (const rec of this.orders) {
      const ro = rec.order.readOnly;
      if (ro.status !== TransactionStatus.Closed) continue;
      for (const pkg of rec.packages) {
        const carrier = this.carriers.find((c) => ci(c.name, rec.order.routingInfo.carrier));
        rows.push({
          orderId: ro.orderId,
          customerIdentifier: ro.customerIdentifier,
          facilityIdentifier: ro.facilityIdentifier,
          referenceNum: rec.order.referenceNum,
          poNum: rec.order.poNum,
          packageId: pkg.packageId,
          packageUri: `/orders/${ro.orderId}/packages/${pkg.packageId}`,
          shipTo: rec.order.shipTo,
          carrier: rec.order.routingInfo.carrier,
          carrierService: rec.order.routingInfo.mode,
          carrierCode: carrier?.carrierCode ?? null,
          trackingNumber: pkg.trackingNumber,
          // GUESS: tracking URL / delivery status come from the carrier-tracking add-on; the mock fabricates a UPS/FedEx-shaped URL.
          trackingUrl: pkg.trackingNumber ? trackingUrlFor(carrier?.carrierCode ?? null, pkg.trackingNumber) : null,
          deliveryStatus: pkg.trackingNumber ? 'In Transit' : null,
          shipDate: ro.shipDate,
          creationDate: ro.creationDate,
          deliveryDate: null,
          deliveryDateEstimated: ro.shipDate ? wireDate(addDays(new Date(`${ro.shipDate}Z`), 3)) : null,
          isImperial: true,
          error: null,
        });
      }
    }
    return rows;
  }

  // ------------------------------------------------------------------------------------------
  // Receivers (SOURCE: https://3w.extensiv.com/rels/inventory/receivers ; /receiver ; /receiverconfirm ; /receivercancel)
  // ------------------------------------------------------------------------------------------

  private buildReceiveItems(customer: Customer, facility: Facility, referenceNum: string, inputs: ReceiveItemInput[]): ReceiveItem[] {
    const items: ReceiveItem[] = [];
    inputs.forEach((input, idx) => {
      const prefix = `ReceiveItems[${idx}]`;
      if (!input.itemIdentifier || (isBlank(input.itemIdentifier.sku) && input.itemIdentifier.id == null)) {
        throw modelValidation('Required', [{ Name: `${prefix}.ItemIdentifier`, Value: null }], 'Each receive item needs an itemIdentifier');
      }
      const item = this.resolveItem(customer.readOnly.customerId, input.itemIdentifier);
      if (!item || item.readOnly.deactivated) {
        throw modelValidation(
          'DoesNotExist',
          [{ Name: `${prefix}.ItemIdentifier.Sku`, Value: input.itemIdentifier.sku ?? String(input.itemIdentifier.id) }],
          `Sku does not exist for customer ${customer.readOnly.customerId}`,
        );
      }
      const qty = input.qty ?? input.expectedQty;
      if (qty === undefined || qty === null) throw modelValidation('Required', [{ Name: `${prefix}.Qty`, Value: null }], 'Qty is required');
      if (typeof qty !== 'number' || qty <= 0) throw modelValidation('ValueNotSupported', [{ Name: `${prefix}.Qty`, Value: String(qty) }], 'Qty must be positive');
      if (item.options.trackBys.trackLotNumber === 2 && isBlank(input.lotNumber)) {
        throw modelValidation('Required', [{ Name: `${prefix}.LotNumber`, Value: null }], `Sku ${item.sku} requires a lot number`);
      }
      if (item.options.trackBys.trackExpirationDate === 2 && isBlank(input.expirationDate)) {
        throw modelValidation('Required', [{ Name: `${prefix}.ExpirationDate`, Value: null }], `Sku ${item.sku} requires an expiration date`);
      }
      let location = input.locationInfo?.locationId != null ? this.locationById(Number(input.locationInfo.locationId)) : undefined;
      if (input.locationInfo?.locationId != null && (!location || location.facilityIdentifier.id !== facility.facilityId)) {
        throw modelValidation('DoesNotExist', [{ Name: `${prefix}.LocationInfo.LocationId`, Value: String(input.locationInfo.locationId) }], 'Location not in facility');
      }
      if (!location && !isBlank(input.locationInfo?.display)) {
        location = this.locations.find((l) => l.facilityIdentifier.id === facility.facilityId && ci(l.name, input.locationInfo?.display));
      }
      const rv = this.nextRowVersion();
      items.push({
        readOnly: {
          receiveItemId: ++this.counters.receiveItemId,
          fullyShippedDate: null,
          unitIdentifier: item.options.inventoryUnit.unitIdentifier,
          // SOURCE: rels/inventory/receiver ReceiveItem.readOnly.expectedQty (ASN expected quantity).
          expectedQty: input.expectedQty ?? qty,
          inventoryLevels: { onHand: 0, available: 0 },
          onHoldDate: null,
          facilityIdentifier: this.facilityIdentifier(facility),
          referenceNumber: referenceNum,
          transactionID: 0,
          rowVersion: rowVersionString(rv),
        },
        itemIdentifier: { sku: item.sku, id: item.itemId },
        qualifier: input.qualifier ?? null,
        externalId: input.externalId ?? null,
        qty,
        secondaryQty: null,
        lotNumber: input.lotNumber ?? null,
        serialNumber: input.serialNumber ?? null,
        expirationDate: input.expirationDate ?? null,
        cost: input.cost ?? item.cost,
        supplierIdentifier: null,
        locationInfo: location ? { locationId: location.locationId, display: location.name } : null,
        weightImperial: item.options.inventoryUnit.imperial.weight,
        onHold: input.onHold ?? false,
        onHoldReason: input.onHoldReason ?? null,
        savedElements: input.savedElements ?? [],
      });
    });
    return items;
  }

  private assertUniqueReceiverReferenceNum(customerId: number, referenceNum: string, exceptId: number | null): void {
    // GUESS: receivers reject duplicate referenceNums per customer like orders; the receivers rel only says referenceNum is required.
    const dup = this.receivers.find(
      (r) => r.receiver.readOnly.customerIdentifier.id === customerId && ci(r.receiver.referenceNum, referenceNum) && r.receiver.readOnly.receiverId !== exceptId,
    );
    if (dup) throw modelValidation('Duplicate', [{ Name: 'ReferenceNum', Value: referenceNum }], `ReferenceNum already exists on receiver ${dup.receiver.readOnly.receiverId}`);
  }

  createReceiver(input: ReceiverCreateInput, opts: { at?: Date; source?: number; emit?: boolean } = {}): ReceiverRecord {
    const at = opts.at ?? this.now();
    if (isBlank(input.referenceNum)) throw modelValidation('Required', [{ Name: 'ReferenceNum', Value: null }], 'ReferenceNum is required');
    if (!input.customerIdentifier) throw modelValidation('Required', [{ Name: 'CustomerIdentifier', Value: null }], 'CustomerIdentifier is required');
    const customer = this.resolveCustomer(input.customerIdentifier);
    if (!customer || customer.readOnly.deactivated) {
      throw modelValidation('DoesNotExist', [{ Name: 'CustomerIdentifier', Value: JSON.stringify(input.customerIdentifier) }], 'Customer does not exist or is deactivated');
    }
    if (!input.facilityIdentifier) throw modelValidation('Required', [{ Name: 'FacilityIdentifier', Value: null }], 'FacilityIdentifier is required');
    const facility = this.resolveFacility(input.facilityIdentifier);
    if (!facility || !customer.facilities.some((f) => f.id === facility.facilityId)) {
      throw modelValidation('DoesNotExist', [{ Name: 'FacilityIdentifier', Value: JSON.stringify(input.facilityIdentifier) }], 'Facility does not exist or is not assigned to the customer');
    }
    if (!input.receiveItems || input.receiveItems.length === 0) {
      throw modelValidation('Required', [{ Name: 'ReceiveItems', Value: null }], 'At least one receive item is required');
    }
    const referenceNum = (input.referenceNum as string).trim();
    this.assertUniqueReceiverReferenceNum(customer.readOnly.customerId, referenceNum, null);
    const items = this.buildReceiveItems(customer, facility, referenceNum, input.receiveItems);
    const receiverId = ++this.counters.receiverId;
    const stamp = wireDate(at);
    // SOURCE: rels/inventory/receivers — customers configured for Receive Against get an ASN (receiverType 2).
    const receiverType = input.receiverType ?? (customer.options.receiving.receiveAgainstAsns !== 0 ? ReceiverType.ReceiveAgainst : ReceiverType.Normal);
    const receiver: Receiver = {
      readOnly: {
        receiverId,
        receiverType,
        customerIdentifier: this.customerIdentifier(customer),
        facilityIdentifier: this.facilityIdentifier(facility),
        warehouseTransactionSourceType: opts.source ?? TransactionSource.RestApi,
        creationDate: stamp,
        createdByIdentifier: this.apiUser(),
        lastModifiedDate: stamp,
        lastModifiedByIdentifier: this.apiUser(),
        status: TransactionStatus.Open,
        chargesPending: false,
      },
      referenceNum,
      poNum: input.poNum ?? null,
      externalId: input.externalId ?? null,
      arrivalDate: input.arrivalDate ?? null,
      expectedDate: input.expectedDate ?? null,
      notes: input.notes ?? null,
      billing: { billingCharges: [] },
      scacCode: input.scacCode ?? null,
      carrier: input.carrier ?? null,
      billOfLading: input.billOfLading ?? null,
      doorNumber: input.doorNumber ?? null,
      trackingNumber: input.trackingNumber ?? null,
      trailerNumber: input.trailerNumber ?? null,
      sealNumber: input.sealNumber ?? null,
      numUnits1: input.numUnits1 ?? null,
      totalWeight: input.totalWeight ?? null,
      totalVolume: input.totalVolume ?? null,
      savedElements: input.savedElements ?? [],
    };
    for (const it of items) it.readOnly.transactionID = receiverId;
    const rec: ReceiverRecord = { receiver, items, rowVersion: this.nextRowVersion() };
    this.receivers.push(rec);
    if (opts.emit !== false) this.emitReceiverEvent(rec, 'ReceiverCreate', at);
    return rec;
  }

  private assertReceiverOpen(rec: ReceiverRecord, actionName: string): void {
    const s = rec.receiver.readOnly.status;
    // GUESS: receivers reuse the order-flavoured OperationException codes; no receiver-specific codes are documented.
    if (s === TransactionStatus.Closed) throw operation('OrderConfirmed', actionName, `Receiver ${rec.receiver.readOnly.receiverId} is confirmed (closed)`);
    if (s === TransactionStatus.Canceled) throw operation('OrderCanceled', actionName, `Receiver ${rec.receiver.readOnly.receiverId} is canceled`);
  }

  /** SOURCE: rels/inventory/receiver PUT "Updates an unconfirmed receiver". */
  updateReceiver(rec: ReceiverRecord, input: ReceiverCreateInput, replaceItems: boolean, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    this.assertReceiverOpen(rec, 'receiver');
    const r = rec.receiver;
    if (input.referenceNum !== undefined) {
      if (isBlank(input.referenceNum)) throw modelValidation('Required', [{ Name: 'ReferenceNum', Value: null }], 'ReferenceNum is required');
      const referenceNum = (input.referenceNum as string).trim();
      this.assertUniqueReceiverReferenceNum(r.readOnly.customerIdentifier.id, referenceNum, r.readOnly.receiverId);
      r.referenceNum = referenceNum;
    }
    const scalar = ['poNum', 'externalId', 'arrivalDate', 'expectedDate', 'notes', 'scacCode', 'carrier', 'billOfLading', 'doorNumber', 'trackingNumber', 'trailerNumber', 'sealNumber', 'numUnits1', 'totalWeight', 'totalVolume'] as const;
    for (const key of scalar) {
      if (key in input) (r as unknown as Record<string, unknown>)[key] = input[key] ?? null;
    }
    if (input.savedElements !== undefined) r.savedElements = input.savedElements ?? [];
    if (replaceItems && input.receiveItems) {
      const customer = this.customerById(r.readOnly.customerIdentifier.id) as Customer;
      const facility = this.facilityById(r.readOnly.facilityIdentifier.id) as Facility;
      rec.items = this.buildReceiveItems(customer, facility, r.referenceNum, input.receiveItems);
      for (const it of rec.items) it.readOnly.transactionID = r.readOnly.receiverId;
    }
    r.readOnly.lastModifiedDate = wireDate(at);
    rec.rowVersion = this.nextRowVersion();
    this.emitReceiverEvent(rec, 'ReceiverUpdate', at);
  }

  /** SOURCE: rels/inventory/receiverconfirm — confirming makes inventory on-hand (help center receipt statuses). */
  confirmReceiver(rec: ReceiverRecord, body: { arrivalDate?: string | null; trackingNumber?: string | null; trailerNumber?: string | null; sealNumber?: string | null; billOfLading?: string | null; loadNumber?: string | null }, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    this.assertReceiverOpen(rec, 'receiverconfirm');
    const arrival = body.arrivalDate ? parseDate(body.arrivalDate) : null;
    if (body.arrivalDate && !arrival) throw modelValidation('ValueNotSupported', [{ Name: 'ArrivalDate', Value: body.arrivalDate }], 'ArrivalDate is not a date');
    // SOURCE: rels/inventory/receiverconfirm — arrivalDate "not future"; Rels/exceptions DateInFuture.
    if (arrival && arrival.getTime() > this.now().getTime() + 60_000) throw operation('DateInFuture', 'receiverconfirm', 'ArrivalDate is in the future');
    const r = rec.receiver;
    const receivedAt = arrival ?? at;
    r.arrivalDate = wireDate(receivedAt);
    if (body.trackingNumber !== undefined) r.trackingNumber = body.trackingNumber ?? null;
    if (body.trailerNumber !== undefined) r.trailerNumber = body.trailerNumber ?? null;
    if (body.sealNumber !== undefined) r.sealNumber = body.sealNumber ?? null;
    if (body.billOfLading !== undefined) r.billOfLading = body.billOfLading ?? null;
    const facility = this.facilityById(r.readOnly.facilityIdentifier.id);
    const defaultLocation = this.locations.find((l) => l.facilityIdentifier.id === facility?.facilityId && !l.nonPickable);
    for (const item of rec.items) {
      const locationId = item.locationInfo?.locationId ?? defaultLocation?.locationId ?? 0;
      if (!item.locationInfo && defaultLocation) item.locationInfo = { locationId: defaultLocation.locationId, display: defaultLocation.name };
      const lot: StockLot = {
        receiveItemId: item.readOnly.receiveItemId,
        receiverId: r.readOnly.receiverId,
        customerId: r.readOnly.customerIdentifier.id,
        facilityId: r.readOnly.facilityIdentifier.id,
        itemId: item.itemIdentifier.id,
        sku: item.itemIdentifier.sku,
        qualifier: item.qualifier,
        lotNumber: item.lotNumber,
        serialNumber: item.serialNumber,
        expirationDate: item.expirationDate,
        locationId,
        receivedQty: item.qty,
        onHand: item.qty,
        available: item.onHold ? 0 : item.qty,
        allocated: 0,
        onHold: item.onHold ? item.qty : 0,
        onHoldReason: item.onHold ? item.onHoldReason : null,
        onHoldDate: item.onHold ? wireDate(receivedAt) : null,
        quarantined: false,
        receivedDate: wireDate(receivedAt),
        referenceNum: r.referenceNum,
        poNum: r.poNum,
        trailerNumber: r.trailerNumber,
        cost: item.cost,
        rowVersion: this.nextRowVersion(),
      };
      this.lots.push(lot);
      item.readOnly.inventoryLevels = { onHand: lot.onHand, available: lot.available };
      this.reallocateShortOrders(lot.customerId, lot.facilityId, lot.itemId);
    }
    r.readOnly.status = TransactionStatus.Closed;
    r.readOnly.lastModifiedDate = wireDate(at);
    rec.rowVersion = this.nextRowVersion();
    this.emitReceiverEvent(rec, 'ReceiverConfirm', at);
  }

  /** SOURCE: rels/inventory/receivercancel — POST /inventory/receivers/{id}/canceler, body reason required. */
  cancelReceiver(rec: ReceiverRecord, reason: string | null | undefined, opts: { at?: Date } = {}): void {
    const at = opts.at ?? this.now();
    if (isBlank(reason)) throw modelValidation('Required', [{ Name: 'Reason', Value: null }], 'Reason is required');
    this.assertReceiverOpen(rec, 'receivercancel');
    rec.receiver.readOnly.status = TransactionStatus.Canceled;
    rec.receiver.readOnly.lastModifiedDate = wireDate(at);
    rec.receiver.notes = rec.receiver.notes ? `${rec.receiver.notes}\nCanceled: ${reason}` : `Canceled: ${reason}`;
    rec.rowVersion = this.nextRowVersion();
    this.emitReceiverEvent(rec, 'ReceiverCancel', at);
  }

  private emitReceiverEvent(rec: ReceiverRecord, eventType: string, at: Date): void {
    const ro = rec.receiver.readOnly;
    // GUESS: receiver event names follow the "<Resource><Verb>" pattern; only OrderConfirm is shown verbatim
    // and the help center lists the Receipt events as Create/Complete/Update/Confirm/Unconfirm/Cancel.
    this.emitWebhook(
      {
        eventType,
        resource: 'Receiver',
        resourceRel: 'inventory/receiver',
        resourceId: ro.receiverId,
        resourcePath: `/inventory/receivers/${ro.receiverId}`,
        customerId: ro.customerIdentifier.id,
        facilityId: ro.facilityIdentifier.id,
        resourceBody: this.renderReceiver(rec, { items: true }),
      },
      at,
    );
  }

  renderReceiver(rec: ReceiverRecord, detail: { items: boolean }): Record<string, unknown> {
    const receiver = clone(rec.receiver);
    const id = receiver.readOnly.receiverId;
    const open = receiver.readOnly.status === TransactionStatus.Open;
    const links: Record<string, { href: string }> = { self: { href: `/inventory/receivers/${id}` } };
    if (open) links.edit = { href: `/inventory/receivers/${id}` };
    links['http://api.3plCentral.com/rels/customers/customer'] = { href: `/customers/${receiver.readOnly.customerIdentifier.id}` };
    links['http://api.3plCentral.com/rels/properties/facility'] = { href: `/properties/facilities/${receiver.readOnly.facilityIdentifier.id}` };
    if (open) {
      links['http://api.3plCentral.com/rels/inventory/receiverconfirm'] = { href: `/inventory/receivers/${id}/confirmer` };
      links['http://api.3plCentral.com/rels/inventory/receivercancel'] = { href: `/inventory/receivers/${id}/canceler` };
    }
    const out: Record<string, unknown> = { ...receiver };
    if (detail.items) {
      out._embedded = {
        'http://api.3plCentral.com/rels/inventory/receiveritem': rec.items.map((i) => {
          const lot = this.lotByReceiveItemId(i.readOnly.receiveItemId);
          const copy = clone(i);
          if (lot) copy.readOnly.inventoryLevels = { onHand: lot.onHand, available: lot.available };
          return copy;
        }),
      };
    }
    out._links = links;
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Debug dump for /__mock/state
  // ------------------------------------------------------------------------------------------

  dump(): Record<string, unknown> {
    return {
      counters: { ...this.counters },
      tokens: [...this.tokens.values()].map((t) => ({ userLogin: t.userLogin, issuedAt: t.issuedAt.toISOString(), expiresAt: t.expiresAt.toISOString() })),
      facilities: this.facilities,
      locations: this.locations.length,
      carriers: this.carriers.map((c) => c.name),
      customers: this.customers.map((c) => ({ id: c.readOnly.customerId, name: c.companyInfo.companyName, deactivated: c.readOnly.deactivated })),
      items: this.items.map((i) => ({ id: i.itemId, customerId: i.readOnly.customerIdentifier.id, sku: i.sku, deactivated: i.readOnly.deactivated })),
      orders: this.orders.map((o) => ({
        orderId: o.order.readOnly.orderId,
        referenceNum: o.order.referenceNum,
        customerId: o.order.readOnly.customerIdentifier.id,
        facilityId: o.order.readOnly.facilityIdentifier.id,
        status: o.order.readOnly.status,
        fullyAllocated: o.order.readOnly.fullyAllocated,
        onHoldReason: o.order.readOnly.onHoldReason,
        etag: this.etagOfOrder(o),
      })),
      receivers: this.receivers.map((r) => ({
        receiverId: r.receiver.readOnly.receiverId,
        referenceNum: r.receiver.referenceNum,
        customerId: r.receiver.readOnly.customerIdentifier.id,
        status: r.receiver.readOnly.status,
        etag: this.etagOfReceiver(r),
      })),
      lots: this.lots,
      faults: this.faults,
      webhookSubscriptions: this.webhooks.subscriptions,
      webhookDeliveries: this.webhooks.deliveries.length,
    };
  }
}

function trackingUrlFor(carrierCode: string | null, trackingNumber: string): string {
  switch ((carrierCode ?? '').toLowerCase()) {
    case 'ups':
      return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    default:
      return `https://track.example.invalid/${trackingNumber}`;
  }
}
