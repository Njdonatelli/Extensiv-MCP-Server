/**
 * Wire models for the subset of the Extensiv 3PL Warehouse Manager REST API that the mock
 * implements. Property names are camelCase on the wire (SOURCE: https://3w.extensiv.com/Rels/hal).
 * Each model mirrors the "Sample accept: application/hal+json" block on its rel page; fields the
 * mock does not simulate are omitted rather than faked, so consumers never see a field the mock
 * cannot keep consistent.
 */

// SOURCE: https://3w.extensiv.com/Rels/identifiers — GET returns every alternate identifier.
export interface CustomerIdentifier {
  externalId: string | null;
  name: string;
  id: number;
}
export interface FacilityIdentifier {
  name: string;
  id: number;
}
export interface ItemIdentifier {
  sku: string;
  id: number;
}
export interface NameIdIdentifier {
  name: string;
  id: number;
}
export interface LocationIdentifier {
  nameKey: { facilityIdentifier: FacilityIdentifier; name: string };
  id: number;
}

/** Contact/address block shared by orders, customers and facilities (SOURCE: https://3w.extensiv.com/rels/orders/order shipTo). */
export interface ContactInfo {
  contactId?: number | null;
  companyName: string | null;
  name: string | null;
  title?: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phoneNumber: string | null;
  fax?: string | null;
  emailAddress: string | null;
  dept?: string | null;
  isAddressResidential?: boolean | null;
  code?: string | null;
  // SOURCE: https://3w.extensiv.com/rels/orders/order — AddressStatus 0 Unconfirmed, 1 Confirmed, 2 UserAccepted.
  addressStatus?: number;
}

export interface SavedElement {
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------------------------
// Customers and items (SOURCE: https://3w.extensiv.com/rels/customers/customer ; /rels/customers/item)
// ---------------------------------------------------------------------------------------------

/** SOURCE: https://3w.extensiv.com/rels/master/webhooksconfig — eventTypes is a comma-delimited string. */
export interface WebHookParameters {
  name: string;
  resource: 'Order' | 'Receiver' | 'Adjustment' | 'Assembly' | 'OrderItem' | 'Item' | 'InventorySummary';
  eventTypes: string;
  url: string;
  includeResource: boolean;
  resourceApiParameters: string | null;
}

export interface Customer {
  readOnly: { customerId: number; creationDate: string; deactivated: boolean };
  companyInfo: ContactInfo;
  primaryContact: ContactInfo;
  webSite: string | null;
  externalId: string | null;
  groups: string[];
  facilities: FacilityIdentifier[];
  primaryFacilityIdentifier: FacilityIdentifier;
  options: {
    alerts: { webHookParameters: WebHookParameters[] };
    // SOURCE: https://3w.extensiv.com/rels/customers/customer — receiveAgainstAsns 0 Disabled, 1 Enabled, 2 Blind.
    receiving: { receiveAgainstAsns: number; purchaseOrders: boolean };
    shipping: { requireTrackingNumber: boolean; autoConfirmOrderOnTrackingUpdate: boolean; orderQueue: boolean };
  };
}

export interface Dimensions {
  netWeight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
}

export interface Item {
  readOnly: {
    customerIdentifier: CustomerIdentifier;
    itemId: number;
    creationDate: string;
    lastModifiedDate: string;
    deactivated: boolean;
    rowVersion: string;
  };
  itemId: number;
  sku: string;
  upc: string | null;
  description: string;
  description2: string | null;
  inventoryCategory: string | null;
  cost: number | null;
  price: number | null;
  countryOfManufacture: string | null;
  harmonizedCode: string | null;
  options: {
    inventoryUnit: {
      unitIdentifier: NameIdIdentifier;
      minimumStock: number | null;
      maximumStock: number | null;
      reorderQuantity: number | null;
      // SOURCE: https://3w.extensiv.com/rels/customers/item — 1 FIFO, 2 LIFO, 3 FEFO.
      inventoryMethod: number;
      imperial: Dimensions;
      metric: Dimensions;
    };
    packageUnit: { unitIdentifier: NameIdIdentifier; inventoryUnitsPerUnit: number; imperial: Dimensions; metric: Dimensions };
    trackBys: {
      // SOURCE: https://3w.extensiv.com/rels/customers/item — 0 Disallow, 1 Allow, 2 Require.
      trackLotNumber: number;
      trackSerialNumber: number;
      trackExpirationDate: number;
      trackCost: number;
    };
    hazMat: { isHazMat: boolean };
  };
  tags: string[];
}

// ---------------------------------------------------------------------------------------------
// Properties (SOURCE: https://3w.extensiv.com/rels/properties/facilities ; /locationsbyfac ; /carriers)
// ---------------------------------------------------------------------------------------------

export interface Facility {
  facilityId: number;
  name: string;
  deactivated: boolean;
  code: string;
  timeZoneName: string;
  shippingZip: string;
  lastCloseDate: string | null;
  contact: ContactInfo;
  rowVersion: string;
}

export interface Location {
  locationId: number;
  name: string;
  field1: string;
  field2: string;
  field3: string;
  field4: string | null;
  description: string | null;
  facilityIdentifier: FacilityIdentifier;
  deactivated: boolean;
  hasInventory: boolean;
  pickPath: number;
  quarantinable: boolean;
  nonPickable: boolean;
}

export interface ShipmentService {
  code: string;
  description: string;
  deactivated: boolean;
}
export interface Carrier {
  name: string;
  description: string;
  scacCode: string | null;
  deactivated: boolean;
  carrierCode: string;
  displayName: string;
  shipmentServices: ShipmentService[];
  billingCodes: { code: string; billingCodeType: number }[];
}

// ---------------------------------------------------------------------------------------------
// Orders (SOURCE: https://3w.extensiv.com/rels/orders/order ; /rels/orders/item ; /rels/orders/packages)
// ---------------------------------------------------------------------------------------------

/** SOURCE: https://3w.extensiv.com/rels/orders/order — WarehouseTransactionApiStatus: 0 Open, 1 Closed, 2 Canceled. */
export const TransactionStatus = { Open: 0, Closed: 1, Canceled: 2 } as const;
export type TransactionStatusValue = (typeof TransactionStatus)[keyof typeof TransactionStatus];

/** SOURCE: https://3w.extensiv.com/rels/orders/orders — WarehouseTransactionSourceType: 7 RestApi, 1 UiManual, 2 UiImport. */
export const TransactionSource = { Unknown: 0, UiManual: 1, UiImport: 2, AutomatedImport: 3, RestApi: 7 } as const;

export interface RoutingInfo {
  isCod: boolean;
  isInsurance: boolean;
  requiresDeliveryConf: boolean;
  scacCode: string | null;
  carrier: string | null;
  mode: string | null;
  account: string | null;
  shipPointZip: string | null;
  capacityTypeIdentifier: NameIdIdentifier | null;
  loadNumber: string | null;
  billOfLading: string | null;
  trackingNumber: string | null;
  trailerNumber: string | null;
  sealNumber: string | null;
  doorNumber: string | null;
  pickupDate: string | null;
}

export interface Allocation {
  receiveItemId: number;
  qty: number;
  // null unless itemdetail includes AllocationsWithDetail (SOURCE: https://3w.extensiv.com/rels/orders/orders Allocations.Detail).
  detail: {
    itemTraits: {
      itemIdentifier: ItemIdentifier;
      qualifier: string | null;
      lotNumber: string | null;
      serialNumber: string | null;
      expirationDate: string | null;
    };
    locationIdentifier: LocationIdentifier;
  } | null;
}

export interface OrderItem {
  readOnly: {
    orderItemId: number;
    fullyAllocated: boolean;
    unitIdentifier: NameIdIdentifier;
    originalPrimaryQty: number;
    // GUESS: allocations are emitted only when itemdetail asks for them; otherwise null. The
    // rel page lists "Allocations ... supplied on GET" next to an itemdetail enum that names
    // Allocations explicitly, which reads as opt-in.
    allocations: Allocation[] | null;
    rowVersion: string;
  };
  itemIdentifier: ItemIdentifier;
  qualifier: string | null;
  externalId: string | null;
  qty: number;
  secondaryQty: number | null;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  notes: string | null;
  savedElements: SavedElement[];
}

export interface PackageContent {
  packageContentId: number;
  packageId: number;
  orderItemId: number;
  receiveItemId: number;
  qty: number;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  createDate: string;
  itemIdentifier: ItemIdentifier;
}

export interface Package {
  packageId: number;
  packageTypeId: number | null;
  packageDefIdentifier: NameIdIdentifier | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  trackingNumber: string | null;
  description: string | null;
  createDate: string;
  _embedded: { 'http://api.3plCentral.com/rels/orders/packagecontent': PackageContent[] };
}

export interface OrderReadOnly {
  orderId: number;
  fullyAllocated: boolean;
  isClosed: boolean;
  processDate: string | null;
  pickStarted: boolean;
  pickDoneDate: string | null;
  packStarted: boolean;
  packDoneDate: string | null;
  asnSentDate: string | null;
  batchIdentifier: NameIdIdentifier | null;
  smallParcelShipDate: string | null;
  shipDate: string | null;
  onHoldDate: string | null;
  onHoldReason: string | null;
  customerIdentifier: CustomerIdentifier;
  facilityIdentifier: FacilityIdentifier;
  warehouseTransactionSourceType: number;
  creationDate: string;
  createdByIdentifier: NameIdIdentifier;
  lastModifiedDate: string;
  lastModifiedByIdentifier: NameIdIdentifier;
  status: TransactionStatusValue;
  chargesPending: boolean;
}

/** Order as returned on the wire, before `_embedded` / `_links` are attached. */
export interface Order {
  readOnly: OrderReadOnly;
  referenceNum: string;
  description: string | null;
  poNum: string | null;
  externalId: string | null;
  earliestShipDate: string | null;
  shipCancelDate: string | null;
  notes: string | null;
  numUnits1: number | null;
  totalWeight: number | null;
  totalVolume: number | null;
  billingCode: string | null;
  asnNumber: string | null;
  shippingNotes: string | null;
  invoiceNumber: string | null;
  routingInfo: RoutingInfo;
  billing: { billingCharges: unknown[] };
  shipTo: ContactInfo;
  soldTo: ContactInfo | null;
  billTo: ContactInfo | null;
  savedElements: SavedElement[];
  parcelResponse: { orderId: number; trackingNumbers: string[]; returnTrackingNumbers: string[] } | null;
  expectedDeliveryDate: string | null;
  // SOURCE: https://3w.extensiv.com/rels/orders/order — one of B2B, D2C, AmazonFBA when populated.
  orderType: string | null;
}

/** Writable order fields accepted on POST /orders and PUT /orders/{id} (SOURCE: https://3w.extensiv.com/rels/orders/orders). */
export interface OrderCreateInput {
  customerIdentifier?: Partial<CustomerIdentifier> | null;
  facilityIdentifier?: Partial<FacilityIdentifier> | null;
  referenceNum?: string | null;
  description?: string | null;
  poNum?: string | null;
  externalId?: string | null;
  earliestShipDate?: string | null;
  shipCancelDate?: string | null;
  notes?: string | null;
  numUnits1?: number | null;
  totalWeight?: number | null;
  totalVolume?: number | null;
  billingCode?: string | null;
  asnNumber?: string | null;
  shippingNotes?: string | null;
  invoiceNumber?: string | null;
  routingInfo?: Partial<RoutingInfo> | null;
  shipTo?: Partial<ContactInfo> | null;
  soldTo?: Partial<ContactInfo> | null;
  billTo?: Partial<ContactInfo> | null;
  savedElements?: SavedElement[] | null;
  expectedDeliveryDate?: string | null;
  orderType?: string | null;
  orderItems?: OrderItemInput[] | null;
  deferNotification?: boolean | null;
}
export interface OrderItemInput {
  itemIdentifier?: Partial<ItemIdentifier> | null;
  qualifier?: string | null;
  externalId?: string | null;
  qty?: number | null;
  secondaryQty?: number | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expirationDate?: string | null;
  notes?: string | null;
  savedElements?: SavedElement[] | null;
}

/** SOURCE: https://3w.extensiv.com/rels/orders/summaries */
export interface OrderSummaryRow {
  orderId: number;
  referenceNum: string;
  poNum: string | null;
  fullyAllocated: boolean;
  customerIdentifier: CustomerIdentifier;
  facilityIdentifier: FacilityIdentifier;
  creationDate: string;
  isClosed: boolean;
}

/** SOURCE: https://3w.extensiv.com/rels/orders/shipmentstrackinginfo */
export interface ShipmentTrackingRow {
  orderId: number;
  customerIdentifier: CustomerIdentifier;
  facilityIdentifier: FacilityIdentifier;
  referenceNum: string;
  poNum: string | null;
  packageId: number;
  packageUri: string;
  shipTo: ContactInfo;
  carrier: string | null;
  carrierService: string | null;
  carrierCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  deliveryStatus: string | null;
  shipDate: string | null;
  creationDate: string;
  deliveryDate: string | null;
  deliveryDateEstimated: string | null;
  isImperial: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------------------------
// Receivers (SOURCE: https://3w.extensiv.com/rels/inventory/receiver ; /rels/inventory/receivers)
// ---------------------------------------------------------------------------------------------

/** SOURCE: https://3w.extensiv.com/rels/inventory/receivers — receivertype 0 Normal, 1 Return, 2 ReceiveAgainst (ASN). */
export const ReceiverType = { Normal: 0, Return: 1, ReceiveAgainst: 2 } as const;

export interface ReceiveItem {
  readOnly: {
    receiveItemId: number;
    fullyShippedDate: string | null;
    unitIdentifier: NameIdIdentifier;
    expectedQty: number;
    inventoryLevels: { onHand: number; available: number };
    onHoldDate: string | null;
    facilityIdentifier: FacilityIdentifier;
    referenceNumber: string;
    transactionID: number;
    rowVersion: string;
  };
  itemIdentifier: ItemIdentifier;
  qualifier: string | null;
  externalId: string | null;
  qty: number;
  secondaryQty: number | null;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  cost: number | null;
  supplierIdentifier: NameIdIdentifier | null;
  locationInfo: { locationId: number; display: string } | null;
  weightImperial: number | null;
  onHold: boolean;
  onHoldReason: string | null;
  savedElements: SavedElement[];
}

export interface ReceiverReadOnly {
  receiverId: number;
  receiverType: number;
  customerIdentifier: CustomerIdentifier;
  facilityIdentifier: FacilityIdentifier;
  warehouseTransactionSourceType: number;
  creationDate: string;
  createdByIdentifier: NameIdIdentifier;
  lastModifiedDate: string;
  lastModifiedByIdentifier: NameIdIdentifier;
  status: TransactionStatusValue;
  chargesPending: boolean;
}

export interface Receiver {
  readOnly: ReceiverReadOnly;
  referenceNum: string;
  poNum: string | null;
  externalId: string | null;
  arrivalDate: string | null;
  expectedDate: string | null;
  notes: string | null;
  billing: { billingCharges: unknown[] };
  scacCode: string | null;
  carrier: string | null;
  billOfLading: string | null;
  doorNumber: string | null;
  trackingNumber: string | null;
  trailerNumber: string | null;
  sealNumber: string | null;
  numUnits1: number | null;
  totalWeight: number | null;
  totalVolume: number | null;
  savedElements: SavedElement[];
}

export interface ReceiverCreateInput {
  customerIdentifier?: Partial<CustomerIdentifier> | null;
  facilityIdentifier?: Partial<FacilityIdentifier> | null;
  referenceNum?: string | null;
  poNum?: string | null;
  externalId?: string | null;
  arrivalDate?: string | null;
  expectedDate?: string | null;
  notes?: string | null;
  scacCode?: string | null;
  carrier?: string | null;
  billOfLading?: string | null;
  doorNumber?: string | null;
  trackingNumber?: string | null;
  trailerNumber?: string | null;
  sealNumber?: string | null;
  numUnits1?: number | null;
  totalWeight?: number | null;
  totalVolume?: number | null;
  savedElements?: SavedElement[] | null;
  receiveItems?: ReceiveItemInput[] | null;
  receiverType?: number | null;
}
export interface ReceiveItemInput {
  itemIdentifier?: Partial<ItemIdentifier> | null;
  qualifier?: string | null;
  externalId?: string | null;
  qty?: number | null;
  expectedQty?: number | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expirationDate?: string | null;
  cost?: number | null;
  locationInfo?: { locationId?: number | null; display?: string | null } | null;
  onHold?: boolean | null;
  onHoldReason?: string | null;
  savedElements?: SavedElement[] | null;
}

// ---------------------------------------------------------------------------------------------
// Stock views (SOURCE: https://3w.extensiv.com/rels/inventory/stocksummaries ; /stockdetails ; /inventory)
// ---------------------------------------------------------------------------------------------

export interface StockSummary {
  itemIdentifier: ItemIdentifier;
  qualifier: string | null;
  totalReceived: number;
  allocated: number;
  available: number;
  onHold: number;
  onHand: number;
  orderedNotAllocated: number | null;
  facilityId: number;
}

export interface StockDetailRow {
  receiveItemId: number;
  itemIdentifier: ItemIdentifier;
  description: string;
  description2: string | null;
  upc: string | null;
  qualifier: string | null;
  received: number;
  available: number;
  isOnHold: boolean;
  quarantined: boolean;
  onHand: number;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  cost: number | null;
  supplierIdentifier: NameIdIdentifier | null;
  locationIdentifier: LocationIdentifier;
  inventoryUnitOfMeasureIdentifier: NameIdIdentifier;
  receiverId: number;
  receivedDate: string;
  referenceNum: string;
  poNum: string | null;
  trailerNumber: string | null;
  savedElements: SavedElement[];
  weightImperial: number | null;
}

export interface InventoryRow {
  receiverId: number;
  receivedDate: string;
  receiveItemId: number;
  customerIdentifier: CustomerIdentifier;
  facilityIdentifier: FacilityIdentifier;
  itemIdentifier: ItemIdentifier;
  itemDescription: string;
  description2: string | null;
  upc: string | null;
  qualifier: string | null;
  inventoryUnitOfMeasureIdentifier: NameIdIdentifier;
  receivedQty: number;
  onHandQty: number;
  availableQty: number;
  onHoldQty: number;
  inventoryAgeDays: number;
  lotNumber: string | null;
  serialNumber: string | null;
  expirationDate: string | null;
  cost: number | null;
  supplierIdentifier: NameIdIdentifier | null;
  locationIdentifier: LocationIdentifier;
  onHold: boolean;
  onHoldReason: string | null;
  onHoldDate: string | null;
  quarantined: boolean;
  rowVersion: string;
  referenceNum: string;
  poNum: string | null;
  trailerNumber: string | null;
}

// ---------------------------------------------------------------------------------------------
// Auth (SOURCE: https://3w.extensiv.com/Rels/auth)
// ---------------------------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: null;
  scope: null;
}

// ---------------------------------------------------------------------------------------------
// Webhooks (SOURCE: https://help.extensiv.com/en_US/rest-api/implementing-webhooks)
// ---------------------------------------------------------------------------------------------

export interface WebhookPayload {
  tplId: number;
  wmsEventId: number;
  /** Deprecated on the real API; still sent (SOURCE: implementing-webhooks "dateTime (deprecated)"). */
  dateTime: string;
  eventDateTimeUtc: string;
  warehouseTransactionEventId: number;
  createDateTimeUtc: string;
  eventType: string;
  resource: { rel: string; href: string; body?: string };
  /** Escaped JSON string (SOURCE: implementing-webhooks). */
  links: string;
  /** Escaped JSON string, e.g. {"OrderId":"206568"} (SOURCE: implementing-webhooks). */
  data: string;
  /** Comma-delimited (SOURCE: implementing-webhooks "tags": "Shipped"). */
  tags: string;
}
