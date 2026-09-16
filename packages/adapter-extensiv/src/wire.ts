/**
 * Wire-model types for the parts of the Extensiv 3PL Warehouse Manager API this
 * adapter reads. Every property is optional because the API omits nulls and the
 * documented models were partly truncated (docs/research/api_reference_notes.md §10).
 * Property names come from the rel pages cited on each type; `// INFERRED:` marks
 * names not seen verbatim.
 */
import type { HalResource, WireIdentifier } from './hal.js';

/** SOURCE https://3w.extensiv.com/rels/orders/order — `readOnly.status` enum WarehouseTransactionApiStatus. */
export const WIRE_STATUS = { open: 0, closed: 1, cancelled: 2 } as const;

export interface WireAddress {
  contactId?: number;
  companyName?: string | null;
  name?: string | null;
  title?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  phoneNumber?: string | null;
  fax?: string | null;
  emailAddress?: string | null;
  dept?: string | null;
  isAddressResidential?: boolean;
  code?: string | null;
  addressStatus?: number;
}

/** SOURCE https://3w.extensiv.com/rels/orders/order (readOnly block). */
export interface WireOrderReadOnly {
  orderId?: number;
  fullyAllocated?: boolean;
  isClosed?: boolean;
  processDate?: string | null;
  // SOURCE: https://3w.extensiv.com/rels/orders/order lists pickStarted / packStarted
  // among the readOnly flags rather than the dated fields. Accept either shape: a bool
  // from the documented model, or a timestamp if a tenant returns one.
  pickStarted?: boolean | string | null;
  pickDoneDate?: string | null;
  packStarted?: boolean | string | null;
  packDoneDate?: string | null;
  asnSentDate?: string | null;
  batchIdentifier?: WireIdentifier | null;
  smallParcelShipDate?: string | null;
  packages?: WirePackage[] | null;
  shipDate?: string | null;
  onHoldDate?: string | null;
  onHoldReason?: string | null;
  customerIdentifier?: WireIdentifier;
  facilityIdentifier?: WireIdentifier;
  warehouseTransactionSourceType?: number;
  creationDate?: string;
  createdByIdentifier?: WireIdentifier;
  lastModifiedDate?: string | null;
  lastModifiedByIdentifier?: WireIdentifier;
  /** 0 Open, 1 Closed (confirmed/shipped), 2 Canceled. */
  status?: number;
  chargesPending?: boolean;
}

/** SOURCE https://3w.extensiv.com/rels/orders/orderrouting (routingInfo block on the order). */
export interface WireRoutingInfo {
  isCod?: boolean;
  isInsurance?: boolean;
  requiresDeliveryConf?: boolean;
  scacCode?: string | null;
  carrier?: string | null;
  mode?: string | null;
  account?: string | null;
  shipPointZip?: string | null;
  capacityTypeIdentifier?: WireIdentifier | null;
  loadNumber?: string | null;
  billOfLading?: string | null;
  trackingNumber?: string | null;
  trailerNumber?: string | null;
  sealNumber?: string | null;
  doorNumber?: string | null;
  pickupDate?: string | null;
}

export interface WirePackageContent {
  packageContentId?: number;
  orderItemId?: number;
  qty?: number;
  lotNumber?: string | null;
  itemIdentifier?: WireIdentifier;
}

/**
 * SOURCE https://3w.extensiv.com/rels/orders/package for the /packages sub-resource.
 * INFERRED: `readOnly.packages[]` on the order carries the same shape.
 */
export interface WirePackage extends HalResource {
  packageId?: number;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  weight?: number | null;
  trackingNumber?: string | null;
  description?: string | null;
  createDate?: string | null;
  /** INFERRED: inline package contents (the sub-resource embeds them under rels/orders/packagecontent). */
  packageContents?: WirePackageContent[] | null;
}

/** SOURCE https://3w.extensiv.com/rels/orders/item */
export interface WireOrderItem extends HalResource {
  readOnly?: {
    orderItemId?: number;
    fullyAllocated?: boolean;
    unitIdentifier?: WireIdentifier;
    allocations?: {
      receiveItemId?: number;
      qty?: number;
      detail?: {
        itemTraits?: { itemIdentifier?: WireIdentifier; qualifier?: string | null; lotNumber?: string | null; serialNumber?: string | null; expirationDate?: string | null };
        locationIdentifier?: WireIdentifier;
      };
    }[];
    rowVersion?: string;
  };
  itemIdentifier?: WireIdentifier;
  qualifier?: string | null;
  externalId?: string | null;
  qty?: number;
  secondaryQty?: number | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expirationDate?: string | null;
  notes?: string | null;
  savedElements?: { name: string; value: string }[];
}

/** SOURCE https://3w.extensiv.com/rels/orders/order */
export interface WireOrder extends HalResource {
  readOnly?: WireOrderReadOnly;
  referenceNum?: string;
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
  routingInfo?: WireRoutingInfo | null;
  shipTo?: WireAddress | null;
  soldTo?: WireAddress | null;
  billTo?: WireAddress | null;
  savedElements?: { name: string; value: string }[];
  parcelResponse?: { orderId?: number; trackingNumbers?: string[] | null; returnTrackingNumbers?: string[] | null } | null;
  expectedDeliveryDate?: string | null;
  orderType?: string | null;
  /** Present on POST bodies only (the GET form embeds items under rels/orders/item). */
  orderItems?: WireOrderItem[];
}

/** SOURCE https://3w.extensiv.com/rels/inventory/receiver */
export interface WireReceiverReadOnly {
  receiverId?: number;
  receiverType?: number;
  customerIdentifier?: WireIdentifier;
  facilityIdentifier?: WireIdentifier;
  creationDate?: string;
  createdByIdentifier?: WireIdentifier;
  lastModifiedDate?: string | null;
  /** 0 Open, 1 Closed, 2 Canceled. */
  status?: number;
  chargesPending?: boolean;
}

/** SOURCE https://3w.extensiv.com/rels/inventory/receiveitems */
export interface WireReceiveItem extends HalResource {
  readOnly?: {
    receiveItemId?: number;
    expectedQty?: number | null;
    inventoryLevels?: { onHand?: number; available?: number };
    rowVersion?: string;
  };
  itemIdentifier?: WireIdentifier;
  qualifier?: string | null;
  qty?: number;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expirationDate?: string | null;
  cost?: number | null;
  locationInfo?: { locationId?: number; display?: string | null } | null;
  onHold?: boolean;
  onHoldReason?: string | null;
}

export interface WireReceiver extends HalResource {
  readOnly?: WireReceiverReadOnly;
  referenceNum?: string;
  poNum?: string | null;
  externalId?: string | null;
  arrivalDate?: string | null;
  expectedDate?: string | null;
  notes?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  trailerNumber?: string | null;
  /** Present on POST bodies only. */
  receiveItems?: WireReceiveItem[];
}

/** SOURCE https://3w.extensiv.com/rels/customers/item */
export interface WireItem extends HalResource {
  readOnly?: {
    customerIdentifier?: WireIdentifier;
    itemId?: number;
    creationDate?: string;
    lastModifiedDate?: string | null;
    deactivated?: boolean;
    rowVersion?: string;
  };
  itemId?: number;
  sku?: string;
  upc?: string | null;
  description?: string | null;
  description2?: string | null;
  inventoryCategory?: string | null;
  cost?: number | null;
  price?: number | null;
  options?: {
    inventoryUnit?: {
      unitIdentifier?: WireIdentifier;
      minimumStock?: number | null;
      maximumStock?: number | null;
      reorderQuantity?: number | null;
      inventoryMethod?: number;
      imperial?: { netWeight?: number | null; length?: number | null; width?: number | null; height?: number | null; weight?: number | null };
      metric?: { netWeight?: number | null; length?: number | null; width?: number | null; height?: number | null; weight?: number | null };
    };
    trackBys?: {
      /** 0 Disallow, 1 Allow, 2 Require. */
      trackLotNumber?: number;
      trackSerialNumber?: number;
      trackExpirationDate?: number;
      trackCost?: number;
    };
  };
  tags?: string[];
}

/** SOURCE https://3w.extensiv.com/rels/customers/customer */
export interface WireCustomer extends HalResource {
  readOnly?: { customerId?: number; creationDate?: string; deactivated?: boolean };
  companyInfo?: WireAddress | null;
  primaryContact?: WireAddress | null;
  externalId?: string | null;
  facilities?: WireIdentifier[] | null;
  primaryFacilityIdentifier?: WireIdentifier | null;
}

/** SOURCE https://3w.extensiv.com/rels/properties/facilities */
export interface WireFacility extends HalResource {
  facilityId?: number;
  name?: string;
  deactivated?: boolean;
  code?: string | null;
  timeZoneName?: string | null;
  shippingZip?: string | null;
  /** INFERRED: contact block shares the address shape used by companyInfo. */
  contact?: WireAddress | null;
  lastCloseDate?: string | null;
  rowVersion?: string;
}

/** SOURCE https://3w.extensiv.com/rels/inventory/stocksummaries — one row of `summaries[]`. */
export interface WireStockSummary {
  itemIdentifier?: WireIdentifier;
  qualifier?: string | null;
  totalReceived?: number;
  allocated?: number;
  available?: number;
  onHold?: number;
  onHand?: number;
  orderedNotAllocated?: number;
  facilityId?: number;
}

/** SOURCE https://3w.extensiv.com/rels/inventory/stockdetails — one row of `_embedded.item[]`. */
export interface WireStockDetail {
  receiveItemId?: number;
  itemIdentifier?: WireIdentifier;
  description?: string | null;
  upc?: string | null;
  qualifier?: string | null;
  received?: number;
  available?: number;
  isOnHold?: boolean;
  quarantined?: boolean;
  onHand?: number;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expirationDate?: string | null;
  cost?: number | null;
  locationIdentifier?: { nameKey?: { facilityIdentifier?: WireIdentifier; name?: string }; id?: number } | null;
  receiverId?: number;
  receivedDate?: string | null;
  referenceNum?: string | null;
  poNum?: string | null;
}

/** SOURCE https://3w.extensiv.com/Rels/exceptions — Newtonsoft `$type` body on 400/403. */
export interface WireErrorBody {
  $type?: string;
  ErrorCode?: string;
  Hint?: string;
  Message?: string;
  Parameters?: string[];
  ModelType?: string;
  Properties?: { Name?: string; Value?: unknown }[];
  ActionNameType?: string;
  ActionName?: string;
  Faults?: { EntryNumber?: number; EntryInfo?: string; WmsException?: { ErrorCode?: string; Hint?: string; Message?: string } }[];
}
