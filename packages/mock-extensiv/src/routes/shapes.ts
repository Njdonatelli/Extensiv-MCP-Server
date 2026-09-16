/**
 * RQL shapes: which dotted property paths each rel accepts, and the type each leaf coerces to.
 *
 * SOURCE: https://3w.extensiv.com/Rels/rql — "Property names are the API model names ... dotted for
 * nesting"; the only paths quoted verbatim anywhere are `readonly.creationdate`, `readonly.isclosed`,
 * `customeridentifier.id`, `fld1`-style placeholders and the `status` caveat.
 * INFERRED: every other path below is taken from the model on the matching rel page, on the reading
 * that "the API model name" means the wire property name. Lookups are case-insensitive, so the maps
 * are written camelCase to match the wire exactly.
 */
import type { RqlShape } from '../rql.js';

const CONTACT: RqlShape = {
  contactId: 'number',
  companyName: 'string',
  name: 'string',
  title: 'string',
  address1: 'string',
  address2: 'string',
  city: 'string',
  state: 'string',
  zip: 'string',
  country: 'string',
  phoneNumber: 'string',
  fax: 'string',
  emailAddress: 'string',
  dept: 'string',
  isAddressResidential: 'bool',
  code: 'string',
  addressStatus: 'number',
};

const CUSTOMER_IDENT: RqlShape = { externalId: 'string', name: 'string', id: 'number' };
const FACILITY_IDENT: RqlShape = { name: 'string', id: 'number' };
const ITEM_IDENT: RqlShape = { sku: 'string', id: 'number' };
const NAME_ID: RqlShape = { name: 'string', id: 'number' };
const LOCATION_IDENT: RqlShape = { nameKey: { facilityIdentifier: FACILITY_IDENT, name: 'string' }, id: 'number' };
const DIMS: RqlShape = { netWeight: 'number', length: 'number', width: 'number', height: 'number', weight: 'number' };

const ROUTING: RqlShape = {
  isCod: 'bool',
  isInsurance: 'bool',
  requiresDeliveryConf: 'bool',
  scacCode: 'string',
  carrier: 'string',
  mode: 'string',
  account: 'string',
  shipPointZip: 'string',
  loadNumber: 'string',
  billOfLading: 'string',
  trackingNumber: 'string',
  trailerNumber: 'string',
  sealNumber: 'string',
  doorNumber: 'string',
  pickupDate: 'date',
};

export const ORDER_SHAPE: RqlShape = {
  readOnly: {
    orderId: 'number',
    fullyAllocated: 'bool',
    // SOURCE: Rels/rql — "for rql on orders filter on readonly.isclosed"; status is only reliable for Canceled.
    isClosed: 'bool',
    processDate: 'date',
    pickStarted: 'bool',
    pickDoneDate: 'date',
    packStarted: 'bool',
    packDoneDate: 'date',
    asnSentDate: 'date',
    smallParcelShipDate: 'date',
    shipDate: 'date',
    onHoldDate: 'date',
    onHoldReason: 'string',
    customerIdentifier: CUSTOMER_IDENT,
    facilityIdentifier: FACILITY_IDENT,
    warehouseTransactionSourceType: 'number',
    creationDate: 'date',
    createdByIdentifier: NAME_ID,
    lastModifiedDate: 'date',
    lastModifiedByIdentifier: NAME_ID,
    status: 'number',
    chargesPending: 'bool',
  },
  referenceNum: 'string',
  description: 'string',
  poNum: 'string',
  externalId: 'string',
  earliestShipDate: 'date',
  shipCancelDate: 'date',
  notes: 'string',
  numUnits1: 'number',
  totalWeight: 'number',
  totalVolume: 'number',
  billingCode: 'string',
  asnNumber: 'string',
  shippingNotes: 'string',
  invoiceNumber: 'string',
  expectedDeliveryDate: 'date',
  orderType: 'string',
  routingInfo: ROUTING,
  shipTo: CONTACT,
  soldTo: CONTACT,
  billTo: CONTACT,
  // GUESS: the docs quote `customeridentifier.id` as an rql path, but on an order that property lives
  // under readOnly. The mock accepts both spellings rather than guessing which one the real parser takes.
  customerIdentifier: CUSTOMER_IDENT,
  facilityIdentifier: FACILITY_IDENT,
  status: 'number',
  isClosed: 'bool',
};

export const ORDER_SUMMARY_SHAPE: RqlShape = {
  orderId: 'number',
  referenceNum: 'string',
  poNum: 'string',
  fullyAllocated: 'bool',
  customerIdentifier: CUSTOMER_IDENT,
  facilityIdentifier: FACILITY_IDENT,
  creationDate: 'date',
  isClosed: 'bool',
};

export const TRACKING_SHAPE: RqlShape = {
  orderId: 'number',
  customerIdentifier: CUSTOMER_IDENT,
  facilityIdentifier: FACILITY_IDENT,
  referenceNum: 'string',
  poNum: 'string',
  packageId: 'number',
  packageUri: 'string',
  shipTo: CONTACT,
  carrier: 'string',
  carrierService: 'string',
  carrierCode: 'string',
  trackingNumber: 'string',
  trackingUrl: 'string',
  deliveryStatus: 'string',
  shipDate: 'date',
  creationDate: 'date',
  deliveryDate: 'date',
  deliveryDateEstimated: 'date',
  isImperial: 'bool',
  error: 'string',
};

export const CUSTOMER_SHAPE: RqlShape = {
  readOnly: { customerId: 'number', creationDate: 'date', deactivated: 'bool' },
  companyInfo: CONTACT,
  primaryContact: CONTACT,
  webSite: 'string',
  externalId: 'string',
  primaryFacilityIdentifier: FACILITY_IDENT,
  options: {
    receiving: { receiveAgainstAsns: 'number', purchaseOrders: 'bool' },
    shipping: { requireTrackingNumber: 'bool', autoConfirmOrderOnTrackingUpdate: 'bool', orderQueue: 'bool' },
  },
};

export const ITEM_SHAPE: RqlShape = {
  readOnly: {
    customerIdentifier: CUSTOMER_IDENT,
    itemId: 'number',
    creationDate: 'date',
    lastModifiedDate: 'date',
    deactivated: 'bool',
    rowVersion: 'string',
  },
  itemId: 'number',
  sku: 'string',
  upc: 'string',
  description: 'string',
  description2: 'string',
  inventoryCategory: 'string',
  cost: 'number',
  price: 'number',
  countryOfManufacture: 'string',
  harmonizedCode: 'string',
  options: {
    inventoryUnit: {
      unitIdentifier: NAME_ID,
      minimumStock: 'number',
      maximumStock: 'number',
      reorderQuantity: 'number',
      inventoryMethod: 'number',
      imperial: DIMS,
      metric: DIMS,
    },
    packageUnit: { unitIdentifier: NAME_ID, inventoryUnitsPerUnit: 'number', imperial: DIMS, metric: DIMS },
    trackBys: { trackLotNumber: 'number', trackSerialNumber: 'number', trackExpirationDate: 'number', trackCost: 'number' },
    hazMat: { isHazMat: 'bool' },
  },
};

export const FACILITY_SHAPE: RqlShape = {
  facilityId: 'number',
  name: 'string',
  deactivated: 'bool',
  code: 'string',
  timeZoneName: 'string',
  shippingZip: 'string',
  lastCloseDate: 'date',
  contact: CONTACT,
  rowVersion: 'string',
};

export const LOCATION_SHAPE: RqlShape = {
  locationId: 'number',
  name: 'string',
  field1: 'string',
  field2: 'string',
  field3: 'string',
  field4: 'string',
  description: 'string',
  facilityIdentifier: FACILITY_IDENT,
  deactivated: 'bool',
  hasInventory: 'bool',
  pickPath: 'number',
  quarantinable: 'bool',
  nonPickable: 'bool',
};

export const RECEIVER_SHAPE: RqlShape = {
  readOnly: {
    receiverId: 'number',
    receiverType: 'number',
    customerIdentifier: CUSTOMER_IDENT,
    facilityIdentifier: FACILITY_IDENT,
    warehouseTransactionSourceType: 'number',
    creationDate: 'date',
    createdByIdentifier: NAME_ID,
    lastModifiedDate: 'date',
    lastModifiedByIdentifier: NAME_ID,
    status: 'number',
    chargesPending: 'bool',
  },
  referenceNum: 'string',
  poNum: 'string',
  externalId: 'string',
  arrivalDate: 'date',
  expectedDate: 'date',
  notes: 'string',
  scacCode: 'string',
  carrier: 'string',
  billOfLading: 'string',
  doorNumber: 'string',
  trackingNumber: 'string',
  trailerNumber: 'string',
  sealNumber: 'string',
  numUnits1: 'number',
  totalWeight: 'number',
  totalVolume: 'number',
  // GUESS: same both-spellings tolerance as orders.
  customerIdentifier: CUSTOMER_IDENT,
  facilityIdentifier: FACILITY_IDENT,
  status: 'number',
};

export const STOCK_SUMMARY_SHAPE: RqlShape = {
  itemIdentifier: ITEM_IDENT,
  qualifier: 'string',
  totalReceived: 'number',
  allocated: 'number',
  available: 'number',
  onHold: 'number',
  onHand: 'number',
  orderedNotAllocated: 'number',
  facilityId: 'number',
  // SOURCE: Rels/rql quotes `customeridentifier.id` as a supported path; a summary row does not carry
  // one on the wire, so the mock filters on a hidden one and strips it from the response.
  customerIdentifier: CUSTOMER_IDENT,
};

export const STOCK_DETAIL_SHAPE: RqlShape = {
  receiveItemId: 'number',
  itemIdentifier: ITEM_IDENT,
  description: 'string',
  description2: 'string',
  upc: 'string',
  qualifier: 'string',
  received: 'number',
  available: 'number',
  isOnHold: 'bool',
  quarantined: 'bool',
  onHand: 'number',
  lotNumber: 'string',
  serialNumber: 'string',
  expirationDate: 'date',
  cost: 'number',
  locationIdentifier: LOCATION_IDENT,
  inventoryUnitOfMeasureIdentifier: NAME_ID,
  receiverId: 'number',
  receivedDate: 'date',
  referenceNum: 'string',
  poNum: 'string',
  trailerNumber: 'string',
  weightImperial: 'number',
};

export const INVENTORY_SHAPE: RqlShape = {
  receiverId: 'number',
  receivedDate: 'date',
  receiveItemId: 'number',
  customerIdentifier: CUSTOMER_IDENT,
  facilityIdentifier: FACILITY_IDENT,
  itemIdentifier: ITEM_IDENT,
  itemDescription: 'string',
  description2: 'string',
  upc: 'string',
  qualifier: 'string',
  inventoryUnitOfMeasureIdentifier: NAME_ID,
  receivedQty: 'number',
  onHandQty: 'number',
  availableQty: 'number',
  onHoldQty: 'number',
  inventoryAgeDays: 'number',
  lotNumber: 'string',
  serialNumber: 'string',
  expirationDate: 'date',
  cost: 'number',
  locationIdentifier: LOCATION_IDENT,
  onHold: 'bool',
  onHoldReason: 'string',
  onHoldDate: 'date',
  quarantined: 'bool',
  rowVersion: 'string',
  referenceNum: 'string',
  poNum: 'string',
  trailerNumber: 'string',
};
