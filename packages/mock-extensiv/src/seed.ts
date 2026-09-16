/**
 * Deterministic seed world. No randomness: every value is fixed, and time-relative values are
 * computed from a single `now` captured at seed time. Orders and receivers are created by replaying
 * the same MockState operations the API uses, so stock is consistent by construction
 * (onHand = available + allocated + onHold per lot).
 */
import {
  ReceiverType,
  TransactionSource,
  type Carrier,
  type ContactInfo,
  type Customer,
  type Dimensions,
  type Facility,
  type Item,
  type Location,
} from './models.js';
import type { MockState } from './state.js';
import { addDays, addHours, rowVersionString, wireDate } from './util.js';

type SeedKind = 'default' | 'empty';

const dims = (l: number, w: number, h: number, weight: number): Dimensions => ({ netWeight: weight, length: l, width: w, height: h, weight });
const metric = (d: Dimensions): Dimensions => ({
  netWeight: d.netWeight === null ? null : Math.round(d.netWeight * 0.4536 * 100) / 100,
  length: d.length === null ? null : Math.round(d.length * 2.54 * 10) / 10,
  width: d.width === null ? null : Math.round(d.width * 2.54 * 10) / 10,
  height: d.height === null ? null : Math.round(d.height * 2.54 * 10) / 10,
  weight: d.weight === null ? null : Math.round(d.weight * 0.4536 * 100) / 100,
});

function contact(p: Partial<ContactInfo> & { contactId: number }): ContactInfo {
  return {
    contactId: p.contactId,
    companyName: p.companyName ?? null,
    name: p.name ?? null,
    title: null,
    address1: p.address1 ?? null,
    address2: p.address2 ?? null,
    city: p.city ?? null,
    state: p.state ?? null,
    zip: p.zip ?? null,
    country: p.country ?? 'US',
    phoneNumber: p.phoneNumber ?? null,
    fax: null,
    emailAddress: p.emailAddress ?? null,
    dept: null,
    isAddressResidential: p.isAddressResidential ?? false,
    code: null,
    addressStatus: 1,
  };
}

// ------------------------------------------------------------------------------------------
// Facilities / locations / carriers (SOURCE: rels/properties/facilities, /locationsbyfac, /carriers)
// ------------------------------------------------------------------------------------------

function facilities(now: Date): Facility[] {
  return [
    {
      facilityId: 1,
      name: 'LAX-1',
      deactivated: false,
      code: 'LAX1',
      // SOURCE: rels/properties/facilities timeZoneName sample "Pacific Standard Time" (Windows tz id).
      timeZoneName: 'Pacific Standard Time',
      shippingZip: '90045',
      lastCloseDate: wireDate(addDays(now, -1)),
      contact: contact({ contactId: 11, companyName: 'Mock 3PL — Los Angeles', name: 'Dock Office', address1: '5901 W Century Blvd', city: 'Los Angeles', state: 'CA', zip: '90045', phoneNumber: '310-555-0140', emailAddress: 'lax1@mock3pl.example' }),
      rowVersion: rowVersionString(11),
    },
    {
      facilityId: 2,
      name: 'DFW-2',
      deactivated: false,
      code: 'DFW2',
      timeZoneName: 'Central Standard Time',
      shippingZip: '75261',
      lastCloseDate: wireDate(addDays(now, -1)),
      contact: contact({ contactId: 12, companyName: 'Mock 3PL — Dallas', name: 'Dock Office', address1: '2400 Aviation Dr', city: 'DFW Airport', state: 'TX', zip: '75261', phoneNumber: '972-555-0188', emailAddress: 'dfw2@mock3pl.example' }),
      rowVersion: rowVersionString(12),
    },
  ];
}

function locations(): Location[] {
  const out: Location[] = [];
  const build = (facilityId: number, name: string, base: number, aisles: string[], bays: number, levels: number): void => {
    let id = base;
    let pick = 1;
    for (const aisle of aisles) {
      for (let bay = 1; bay <= bays; bay++) {
        for (let level = 1; level <= levels; level++) {
          out.push({
            locationId: id++,
            name: `${aisle}-${String(bay).padStart(2, '0')}-${String(level).padStart(2, '0')}`,
            field1: aisle,
            field2: String(bay).padStart(2, '0'),
            field3: String(level).padStart(2, '0'),
            field4: null,
            description: null,
            facilityIdentifier: { name, id: facilityId },
            deactivated: false,
            hasInventory: false,
            pickPath: pick++,
            quarantinable: false,
            nonPickable: false,
          });
        }
      }
    }
    out.push({
      locationId: id++,
      name: 'DOCK-RECV',
      field1: 'DOCK',
      field2: 'RECV',
      field3: '',
      field4: null,
      description: 'Receiving dock',
      facilityIdentifier: { name, id: facilityId },
      deactivated: false,
      hasInventory: false,
      pickPath: 999,
      quarantinable: true,
      nonPickable: true,
    });
  };
  build(1, 'LAX-1', 101, ['A', 'B'], 3, 2); // 101..112
  build(2, 'DFW-2', 201, ['A'], 4, 2); // 201..208
  return out;
}

function carriers(): Carrier[] {
  return [
    {
      name: 'UPS',
      description: 'United Parcel Service',
      scacCode: 'UPSN',
      deactivated: false,
      carrierCode: 'UPS',
      displayName: 'UPS',
      shipmentServices: [
        { code: 'Ground', description: 'UPS Ground', deactivated: false },
        { code: '2nd Day Air', description: 'UPS 2nd Day Air', deactivated: false },
        { code: 'Next Day Air', description: 'UPS Next Day Air', deactivated: false },
      ],
      billingCodes: [
        { code: 'Prepaid', billingCodeType: 0 },
        { code: 'ThirdParty', billingCodeType: 2 },
      ],
    },
    {
      name: 'FedEx',
      description: 'Federal Express',
      scacCode: 'FDEG',
      deactivated: false,
      carrierCode: 'FedEx',
      displayName: 'FedEx',
      shipmentServices: [
        { code: 'Ground', description: 'FedEx Ground', deactivated: false },
        { code: 'Home Delivery', description: 'FedEx Home Delivery', deactivated: false },
        { code: '2Day', description: 'FedEx 2Day', deactivated: false },
      ],
      billingCodes: [{ code: 'Prepaid', billingCodeType: 0 }],
    },
    {
      name: 'USPS',
      description: 'United States Postal Service',
      scacCode: 'USPS',
      deactivated: false,
      carrierCode: 'USPS',
      displayName: 'USPS',
      shipmentServices: [
        { code: 'Priority Mail', description: 'USPS Priority Mail', deactivated: false },
        { code: 'First Class', description: 'USPS First-Class Package', deactivated: false },
      ],
      billingCodes: [{ code: 'Prepaid', billingCodeType: 0 }],
    },
    {
      name: 'LTL Freight',
      description: 'Generic less-than-truckload',
      scacCode: null,
      deactivated: false,
      carrierCode: 'LTL',
      displayName: 'LTL Freight',
      shipmentServices: [{ code: 'Standard', description: 'LTL standard', deactivated: false }],
      billingCodes: [
        { code: 'Prepaid', billingCodeType: 0 },
        { code: 'Collect', billingCodeType: 1 },
      ],
    },
  ];
}

// ------------------------------------------------------------------------------------------
// Customers (SOURCE: rels/customers/customer)
// ------------------------------------------------------------------------------------------

function customers(now: Date): Customer[] {
  const created = wireDate(addDays(now, -400));
  const base = (id: number, name: string, facilityIds: number[], deactivated: boolean, info: Partial<ContactInfo>): Customer => ({
    readOnly: { customerId: id, creationDate: created, deactivated },
    // `...info` first so the explicit contactId/companyName below win (info carries an optional, nullable contactId).
    companyInfo: contact({ ...info, contactId: 20 + id, companyName: name, name: info.name ?? null }),
    primaryContact: contact({ ...info, contactId: 40 + id, companyName: name, name: info.name ?? null }),
    webSite: null,
    externalId: `CUST-${String(id).padStart(3, '0')}`,
    groups: [],
    facilities: facilityIds.map((f) => ({ name: f === 1 ? 'LAX-1' : 'DFW-2', id: f })),
    primaryFacilityIdentifier: { name: facilityIds[0] === 1 ? 'LAX-1' : 'DFW-2', id: facilityIds[0] as number },
    options: {
      alerts: { webHookParameters: [] },
      receiving: { receiveAgainstAsns: 0, purchaseOrders: false },
      shipping: { requireTrackingNumber: false, autoConfirmOrderOnTrackingUpdate: false, orderQueue: false },
    },
  });

  const acme = base(1, 'Acme Outdoor Co', [1, 2], false, { name: 'Dana Whitfield', address1: '1200 Industrial Way', city: 'Boulder', state: 'CO', zip: '80301', phoneNumber: '303-555-0121', emailAddress: 'ops@acmeoutdoor.example' });
  acme.options.receiving.receiveAgainstAsns = 1; // SOURCE: customer.options.receiving.receiveAgainstAsns 1 = Enabled
  acme.options.alerts.webHookParameters.push({
    name: 'acme-order-events',
    resource: 'Order',
    // SOURCE: rels/master/webhooksconfig — comma-delimited list within the resource domain.
    eventTypes: 'OrderCreate,OrderUpdate,OrderCancel,OrderConfirm,OrderComplete',
    // The real API only accepts https:// (configuring-webhooks); the mock relaxes this so a local receiver works.
    url: 'http://127.0.0.1:4020/webhooks/extensiv',
    includeResource: false,
    resourceApiParameters: 'detail=OrderItems',
  });

  const bluebird = base(2, 'Bluebird Cosmetics', [1], false, { name: 'Priya Natarajan', address1: '88 Mercer St', address2: 'Floor 4', city: 'New York', state: 'NY', zip: '10012', phoneNumber: '212-555-0199', emailAddress: 'fulfillment@bluebirdcos.example' });
  const northwind = base(3, 'Northwind Traders', [1], true, { name: 'Andrew Fuller', address1: '1 Northwind Plaza', city: 'Seattle', state: 'WA', zip: '98101', phoneNumber: '206-555-0100', emailAddress: 'ap@northwind.example' });
  const outOfScope = base(9, 'Out Of Scope Co', [2], false, { name: 'Sam Reyes', address1: '4501 Elm St', city: 'Dallas', state: 'TX', zip: '75226', phoneNumber: '214-555-0155', emailAddress: 'ops@outofscope.example' });
  return [acme, bluebird, northwind, outOfScope];
}

// ------------------------------------------------------------------------------------------
// Items (SOURCE: rels/customers/item)
// ------------------------------------------------------------------------------------------

interface ItemSpec {
  sku: string;
  description: string;
  upc: string | null;
  cost: number;
  price: number;
  dims: Dimensions;
  reorder: number;
  lot?: boolean;
  expiration?: boolean;
  deactivated?: boolean;
  category?: string;
}

const ACME_ITEMS: ItemSpec[] = [
  { sku: 'ACME-TENT-2P', description: '2-Person Backpacking Tent', upc: '810001230011', cost: 89, price: 219, dims: dims(20, 7, 7, 4.2), reorder: 20, category: 'Shelter' },
  { sku: 'ACME-TENT-4P', description: '4-Person Family Tent', upc: '810001230028', cost: 140, price: 349, dims: dims(26, 10, 10, 11.5), reorder: 10, category: 'Shelter' },
  { sku: 'ACME-STOVE-01', description: 'Canister Backpacking Stove', upc: '810001230035', cost: 18, price: 49.95, dims: dims(4, 3, 3, 0.4), reorder: 40, category: 'Kitchen' },
  { sku: 'ACME-BAG-20F', description: '20°F Down Sleeping Bag', upc: '810001230042', cost: 110, price: 279, dims: dims(16, 9, 9, 2.6), reorder: 15, category: 'Sleep' },
  { sku: 'ACME-BAG-0F', description: '0°F Down Sleeping Bag', upc: '810001230059', cost: 160, price: 399, dims: dims(18, 10, 10, 3.9), reorder: 10, category: 'Sleep' },
  { sku: 'ACME-PAD-REG', description: 'Insulated Sleeping Pad, Regular', upc: '810001230066', cost: 45, price: 129, dims: dims(10, 5, 5, 1.1), reorder: 25, category: 'Sleep' },
  { sku: 'ACME-PAD-LONG', description: 'Insulated Sleeping Pad, Long', upc: '810001230073', cost: 52, price: 149, dims: dims(11, 5, 5, 1.3), reorder: 15, category: 'Sleep' },
  { sku: 'ACME-HDLMP-300', description: '300-Lumen Headlamp', upc: '810001230080', cost: 12, price: 34.95, dims: dims(3, 2.5, 2, 0.2), reorder: 50, category: 'Lighting' },
  { sku: 'ACME-FILTER-SQZ', description: 'Squeeze Water Filter', upc: '810001230097', cost: 15, price: 39.95, dims: dims(6, 3, 3, 0.3), reorder: 30, lot: true, category: 'Water' },
  { sku: 'ACME-BOTTLE-1L', description: '1L Wide-Mouth Bottle', upc: '810001230103', cost: 4, price: 14.95, dims: dims(9, 3.5, 3.5, 0.4), reorder: 60, category: 'Water' },
  { sku: 'ACME-CHAIR-LT', description: 'Ultralight Camp Chair', upc: '810001230110', cost: 38, price: 99, dims: dims(14, 5, 5, 2.0), reorder: 20, category: 'Furniture' },
  { sku: 'ACME-COOLER-20', description: '20 Qt Hard Cooler', upc: '810001230127', cost: 70, price: 199, dims: dims(21, 14, 15, 12.0), reorder: 8, category: 'Coolers' },
  { sku: 'ACME-COOLER-45', description: '45 Qt Hard Cooler', upc: '810001230134', cost: 120, price: 299, dims: dims(26, 16, 16, 22.0), reorder: 6, category: 'Coolers' },
  { sku: 'ACME-TREKPOLE-PR', description: 'Carbon Trekking Poles, Pair', upc: '810001230141', cost: 42, price: 119, dims: dims(26, 4, 4, 1.0), reorder: 20, category: 'Hiking' },
  { sku: 'ACME-FIRSTAID-M', description: 'First Aid Kit, Medium', upc: '810001230158', cost: 9, price: 29.95, dims: dims(8, 6, 3, 0.7), reorder: 30, category: 'Safety' },
  { sku: 'ACME-MEAL-CHILI', description: 'Freeze-Dried Chili Mac, 2 Servings', upc: '810001230165', cost: 4.5, price: 11.95, dims: dims(8, 6, 2, 0.35), reorder: 100, expiration: true, category: 'Food' },
  { sku: 'ACME-JACKET-RAIN-M', description: 'Rain Shell Jacket, Medium', upc: '810001230172', cost: 55, price: 159, dims: dims(12, 10, 2, 0.8), reorder: 15, category: 'Apparel' },
  { sku: 'ACME-JACKET-RAIN-L', description: 'Rain Shell Jacket, Large', upc: '810001230189', cost: 55, price: 159, dims: dims(12, 10, 2, 0.85), reorder: 15, category: 'Apparel' },
  { sku: 'ACME-LANTERN-LED', description: 'LED Camp Lantern (discontinued)', upc: '810001230196', cost: 14, price: 39.95, dims: dims(5, 5, 7, 0.9), reorder: 0, deactivated: true, category: 'Lighting' },
  { sku: 'ACME-STAKES-10PK', description: 'Aluminum Tent Stakes, 10 Pack', upc: '810001230202', cost: 3, price: 12.95, dims: dims(8, 2, 1, 0.3), reorder: 80, category: 'Shelter' },
];

const BLUEBIRD_ITEMS: ItemSpec[] = [
  { sku: 'BLB-LIP-ROSE', description: 'Tinted Lip Balm — Rose', upc: '860002340017', cost: 2.1, price: 12, dims: dims(3, 1, 1, 0.05), reorder: 200, category: 'Lips' },
  { sku: 'BLB-LIP-CORAL', description: 'Tinted Lip Balm — Coral', upc: '860002340024', cost: 2.1, price: 12, dims: dims(3, 1, 1, 0.05), reorder: 200, category: 'Lips' },
  { sku: 'BLB-SERUM-30ML', description: 'Vitamin C Serum 30ml', upc: '860002340031', cost: 6.5, price: 42, dims: dims(4, 1.5, 1.5, 0.2), reorder: 100, expiration: true, category: 'Skin' },
  { sku: 'BLB-MASK-SHEET-5PK', description: 'Hydrating Sheet Mask, 5 Pack', upc: '860002340048', cost: 3.2, price: 18, dims: dims(6, 4, 1, 0.3), reorder: 150, category: 'Skin' },
  { sku: 'BLB-BRUSH-SET', description: '8-Piece Brush Set', upc: '860002340055', cost: 7.8, price: 36, dims: dims(9, 4, 2, 0.5), reorder: 50, category: 'Tools' },
  { sku: 'BLB-PALETTE-NUDE', description: 'Eyeshadow Palette — Nude', upc: '860002340062', cost: 5.4, price: 32, dims: dims(6, 4, 1, 0.35), reorder: 80, category: 'Eyes' },
  { sku: 'BLB-CLEANSER-150', description: 'Gel Cleanser 150ml', upc: '860002340079', cost: 3.9, price: 24, dims: dims(6, 2, 2, 0.45), reorder: 100, category: 'Skin' },
  { sku: 'BLB-GIFTBOX-A', description: 'Holiday Gift Box A', upc: '860002340086', cost: 12, price: 65, dims: dims(10, 8, 4, 1.4), reorder: 40, category: 'Sets' },
];

const OOS_ITEMS: ItemSpec[] = [
  { sku: 'OOS-WIDGET-A', description: 'Widget A', upc: null, cost: 1, price: 5, dims: dims(4, 4, 4, 0.5), reorder: 50 },
  { sku: 'OOS-WIDGET-B', description: 'Widget B', upc: null, cost: 2, price: 8, dims: dims(4, 4, 4, 0.6), reorder: 50 },
  { sku: 'OOS-GADGET-C', description: 'Gadget C', upc: null, cost: 9, price: 30, dims: dims(8, 6, 4, 1.5), reorder: 10 },
];

function items(now: Date, customerList: Customer[]): Item[] {
  const out: Item[] = [];
  const created = wireDate(addDays(now, -300));
  const build = (customer: Customer, specs: ItemSpec[], baseId: number): void => {
    specs.forEach((spec, idx) => {
      const itemId = baseId + idx;
      out.push({
        readOnly: {
          customerIdentifier: { externalId: customer.externalId, name: customer.companyInfo.companyName ?? '', id: customer.readOnly.customerId },
          itemId,
          creationDate: created,
          lastModifiedDate: created,
          deactivated: spec.deactivated ?? false,
          rowVersion: rowVersionString(itemId),
        },
        itemId,
        sku: spec.sku,
        upc: spec.upc,
        description: spec.description,
        description2: null,
        inventoryCategory: spec.category ?? null,
        cost: spec.cost,
        price: spec.price,
        countryOfManufacture: 'CN',
        harmonizedCode: null,
        options: {
          inventoryUnit: {
            unitIdentifier: { name: 'Each', id: 1 },
            minimumStock: Math.floor(spec.reorder / 2),
            maximumStock: spec.reorder * 10,
            reorderQuantity: spec.reorder,
            inventoryMethod: spec.expiration ? 3 : 1,
            imperial: spec.dims,
            metric: metric(spec.dims),
          },
          packageUnit: { unitIdentifier: { name: 'Case', id: 2 }, inventoryUnitsPerUnit: 6, imperial: dims(24, 16, 12, spec.dims.weight ? spec.dims.weight * 6 : 0), metric: metric(dims(24, 16, 12, spec.dims.weight ? spec.dims.weight * 6 : 0)) },
          trackBys: {
            trackLotNumber: spec.lot ? 2 : 0,
            trackSerialNumber: 0,
            trackExpirationDate: spec.expiration ? 2 : 0,
            trackCost: 0,
          },
          hazMat: { isHazMat: false },
        },
        tags: [],
      });
    });
  };
  build(customerList[0] as Customer, ACME_ITEMS, 1001);
  build(customerList[1] as Customer, BLUEBIRD_ITEMS, 2001);
  build(customerList[3] as Customer, OOS_ITEMS, 9001);
  return out;
}

// ------------------------------------------------------------------------------------------
// Ship-to addresses
// ------------------------------------------------------------------------------------------

const SHIP_TOS: Partial<ContactInfo>[] = [
  { name: 'Jordan Ellis', address1: '742 Evergreen Terrace', city: 'Springfield', state: 'IL', zip: '62704', phoneNumber: '217-555-0134', emailAddress: 'jordan.ellis@example.com', isAddressResidential: true },
  { name: 'Maya Chen', address1: '1520 Pine St', address2: 'Apt 3B', city: 'San Francisco', state: 'CA', zip: '94109', phoneNumber: '415-555-0162', emailAddress: 'maya.chen@example.com', isAddressResidential: true },
  { companyName: 'Summit Supply Co', name: 'Receiving', address1: '300 Commerce Dr', city: 'Denver', state: 'CO', zip: '80239', phoneNumber: '720-555-0110', emailAddress: 'receiving@summitsupply.example', isAddressResidential: false },
  { name: 'Luis Ortega', address1: '9814 Bayview Ave', city: 'Tampa', state: 'FL', zip: '33611', phoneNumber: '813-555-0177', emailAddress: 'luis.ortega@example.com', isAddressResidential: true },
  { name: 'Hannah Kim', address1: '55 W 25th St', address2: 'Unit 12', city: 'New York', state: 'NY', zip: '10010', phoneNumber: '646-555-0149', emailAddress: 'hannah.kim@example.com', isAddressResidential: true },
  { companyName: 'Trailhead Outfitters', name: 'Store Manager', address1: '4100 N Lamar Blvd', city: 'Austin', state: 'TX', zip: '78756', phoneNumber: '512-555-0128', emailAddress: 'orders@trailheadoutfitters.example', isAddressResidential: false },
  { name: 'Aiden Murphy', address1: '2201 Lakeshore Dr', city: 'Chicago', state: 'IL', zip: '60616', phoneNumber: '312-555-0193', emailAddress: 'aiden.murphy@example.com', isAddressResidential: true },
  { name: 'Grace Okafor', address1: '801 Peachtree St NE', city: 'Atlanta', state: 'GA', zip: '30308', phoneNumber: '404-555-0156', emailAddress: 'grace.okafor@example.com', isAddressResidential: true },
  { companyName: 'Cascade Camping Rentals', name: 'Warehouse', address1: '1900 SE Powell Blvd', city: 'Portland', state: 'OR', zip: '97202', phoneNumber: '503-555-0102', emailAddress: 'wh@cascadecamping.example', isAddressResidential: false },
  { name: 'Noah Patel', address1: '6300 Wilshire Blvd', address2: 'Suite 900', city: 'Los Angeles', state: 'CA', zip: '90048', phoneNumber: '323-555-0119', emailAddress: 'noah.patel@example.com', isAddressResidential: false },
  { name: 'Sofia Rossi', address1: '18 Beacon St', city: 'Boston', state: 'MA', zip: '02108', phoneNumber: '617-555-0187', emailAddress: 'sofia.rossi@example.com', isAddressResidential: true },
  { name: 'Ethan Brooks', address1: '4477 Desert Inn Rd', city: 'Las Vegas', state: 'NV', zip: '89121', phoneNumber: '702-555-0171', emailAddress: 'ethan.brooks@example.com', isAddressResidential: true },
];

// ------------------------------------------------------------------------------------------
// Receivers and orders replayed through MockState
// ------------------------------------------------------------------------------------------

interface ReceiverSpec {
  customerId: number;
  facilityId: number;
  referenceNum: string;
  poNum: string;
  createdDaysAgo: number;
  expectedDaysFromNow: number;
  /** 'closed' confirms with arrival = expected date; variance overrides received qty for a sku. */
  state: 'open' | 'closed' | 'cancelled';
  receiverType?: number;
  lines: { sku: string; qty: number; received?: number; lot?: string; exp?: string; location?: string }[];
  carrier?: string;
  trailer?: string;
}

function receiverSpecs(now: Date): ReceiverSpec[] {
  const exp = (days: number): string => wireDate(addDays(now, days)).slice(0, 10) + 'T00:00:00';
  return [
    {
      customerId: 1,
      facilityId: 1,
      referenceNum: 'ACME-ASN-5001',
      poNum: 'PO-ACME-2201',
      createdDaysAgo: 28,
      expectedDaysFromNow: -25,
      state: 'closed',
      carrier: 'LTL Freight',
      trailer: 'TRL-4471',
      lines: [
        { sku: 'ACME-TENT-2P', qty: 60, location: 'A-01-01' },
        { sku: 'ACME-TENT-4P', qty: 20, location: 'A-01-02' },
        { sku: 'ACME-STOVE-01', qty: 120, location: 'A-02-01' },
        { sku: 'ACME-BAG-20F', qty: 40, location: 'A-02-02' },
        { sku: 'ACME-BAG-0F', qty: 24, location: 'A-03-01' },
        { sku: 'ACME-PAD-REG', qty: 80, received: 76, location: 'A-03-02' }, // variance: 4 short
        { sku: 'ACME-PAD-LONG', qty: 30, location: 'B-01-01' },
        { sku: 'ACME-HDLMP-300', qty: 60, location: 'B-01-02' },
        { sku: 'ACME-BOTTLE-1L', qty: 200, location: 'B-02-01' },
        { sku: 'ACME-CHAIR-LT', qty: 50, location: 'B-02-02' },
        { sku: 'ACME-COOLER-20', qty: 24, location: 'B-03-01' },
        { sku: 'ACME-COOLER-45', qty: 6, location: 'B-03-02' },
        { sku: 'ACME-TREKPOLE-PR', qty: 40, location: 'A-01-01' },
        { sku: 'ACME-FIRSTAID-M', qty: 90, location: 'A-01-02' },
        { sku: 'ACME-JACKET-RAIN-M', qty: 35, location: 'A-02-01' },
        { sku: 'ACME-JACKET-RAIN-L', qty: 35, location: 'A-02-02' },
        { sku: 'ACME-STAKES-10PK', qty: 150, location: 'A-03-01' },
      ],
    },
    {
      customerId: 1,
      facilityId: 2,
      referenceNum: 'ACME-ASN-5002',
      poNum: 'PO-ACME-2202',
      createdDaysAgo: 22,
      expectedDaysFromNow: -20,
      state: 'closed',
      carrier: 'LTL Freight',
      trailer: 'TRL-9012',
      lines: [
        { sku: 'ACME-TENT-2P', qty: 30, location: 'A-01-01' },
        { sku: 'ACME-STOVE-01', qty: 60, location: 'A-01-02' },
        { sku: 'ACME-BAG-20F', qty: 20, location: 'A-02-01' },
        { sku: 'ACME-HDLMP-300', qty: 40, location: 'A-02-02' },
        { sku: 'ACME-BOTTLE-1L', qty: 100, location: 'A-03-01' },
        { sku: 'ACME-COOLER-20', qty: 12, location: 'A-03-02' },
      ],
    },
    {
      customerId: 2,
      facilityId: 1,
      referenceNum: 'BLB-RCV-3001',
      poNum: 'PO-BLB-771',
      createdDaysAgo: 19,
      expectedDaysFromNow: -18,
      state: 'closed',
      carrier: 'UPS',
      lines: [
        { sku: 'BLB-LIP-ROSE', qty: 500, location: 'B-01-01' },
        { sku: 'BLB-LIP-CORAL', qty: 500, received: 480, location: 'B-01-01' }, // variance
        { sku: 'BLB-SERUM-30ML', qty: 240, exp: exp(540), location: 'B-01-02' },
        { sku: 'BLB-MASK-SHEET-5PK', qty: 300, location: 'B-02-01' },
        { sku: 'BLB-BRUSH-SET', qty: 120, location: 'B-02-02' },
        { sku: 'BLB-PALETTE-NUDE', qty: 160, location: 'B-03-01' },
        { sku: 'BLB-CLEANSER-150', qty: 200, location: 'B-03-02' },
        { sku: 'BLB-GIFTBOX-A', qty: 25, location: 'B-03-02' },
      ],
    },
    {
      customerId: 9,
      facilityId: 2,
      referenceNum: 'OOS-RCV-100',
      poNum: 'PO-OOS-1',
      createdDaysAgo: 16,
      expectedDaysFromNow: -15,
      state: 'closed',
      lines: [
        { sku: 'OOS-WIDGET-A', qty: 100, location: 'A-04-01' },
        { sku: 'OOS-WIDGET-B', qty: 100, location: 'A-04-02' },
        { sku: 'OOS-GADGET-C', qty: 20, location: 'A-04-02' },
      ],
    },
    {
      customerId: 1,
      facilityId: 1,
      referenceNum: 'ACME-ASN-5003',
      poNum: 'PO-ACME-2203',
      createdDaysAgo: 6,
      expectedDaysFromNow: -5,
      state: 'closed',
      carrier: 'FedEx',
      lines: [
        { sku: 'ACME-FILTER-SQZ', qty: 40, lot: 'LOT-2409A', location: 'B-01-02' },
        { sku: 'ACME-FILTER-SQZ', qty: 40, lot: 'LOT-2409B', location: 'B-01-02' },
        { sku: 'ACME-MEAL-CHILI', qty: 50, received: 48, exp: exp(365), location: 'B-02-01' }, // variance
        { sku: 'ACME-MEAL-CHILI', qty: 50, exp: exp(30), location: 'B-02-01' }, // near-expiry lot
      ],
    },
    {
      customerId: 1,
      facilityId: 1,
      referenceNum: 'ACME-ASN-5004',
      poNum: 'PO-ACME-2204',
      createdDaysAgo: 4,
      expectedDaysFromNow: 1, // ASN due tomorrow
      state: 'open',
      receiverType: ReceiverType.ReceiveAgainst,
      carrier: 'LTL Freight',
      lines: [
        { sku: 'ACME-COOLER-45', qty: 24 },
        { sku: 'ACME-TENT-4P', qty: 30 },
        { sku: 'ACME-HDLMP-300', qty: 100 },
      ],
    },
    {
      customerId: 1,
      facilityId: 2,
      referenceNum: 'ACME-ASN-5005',
      poNum: 'PO-ACME-2205',
      createdDaysAgo: 9,
      expectedDaysFromNow: -3, // overdue
      state: 'open',
      receiverType: ReceiverType.ReceiveAgainst,
      carrier: 'LTL Freight',
      lines: [
        { sku: 'ACME-PAD-REG', qty: 40 },
        { sku: 'ACME-CHAIR-LT', qty: 30 },
      ],
    },
    {
      customerId: 2,
      facilityId: 1,
      referenceNum: 'BLB-RCV-3002',
      poNum: 'PO-BLB-772',
      createdDaysAgo: 10,
      expectedDaysFromNow: -7,
      state: 'cancelled',
      lines: [{ sku: 'BLB-GIFTBOX-A', qty: 100 }],
    },
    {
      customerId: 2,
      facilityId: 1,
      referenceNum: 'BLB-RCV-3003',
      poNum: 'PO-BLB-773',
      createdDaysAgo: 2,
      expectedDaysFromNow: 5,
      state: 'open',
      carrier: 'UPS',
      lines: [
        { sku: 'BLB-SERUM-30ML', qty: 120, exp: exp(600) },
        { sku: 'BLB-LIP-CORAL', qty: 200 },
      ],
    },
  ];
}

interface OrderSpec {
  customerId: number;
  facilityId: number;
  ref: string;
  poNum?: string;
  createdDaysAgo: number;
  /** Fractional hours offset so orders on the same day keep distinct timestamps. */
  hourOffset?: number;
  shipTo: number;
  carrier: string;
  mode: string;
  lines: { sku: string; qty: number; lot?: string }[];
  state: 'open' | 'hold' | 'closed' | 'cancelled' | 'complete';
  shipDaysAgo?: number;
  tracking?: string;
  earliestShipDaysFromNow?: number;
  holdReason?: string;
  orderType?: string;
}

function orderSpecs(): OrderSpec[] {
  // Chronological (oldest first) so FIFO allocation replays naturally.
  return [
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10001', poNum: 'ACME-PO-88001', createdDaysAgo: 29, shipTo: 0, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TENT-2P', qty: 2 }, { sku: 'ACME-STOVE-01', qty: 2 }], state: 'closed', shipDaysAgo: 27, tracking: '1Z999AA10123456784', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10002', createdDaysAgo: 28, shipTo: 1, carrier: 'FedEx', mode: 'Home Delivery', lines: [{ sku: 'ACME-BAG-20F', qty: 1 }, { sku: 'ACME-PAD-REG', qty: 1 }], state: 'closed', shipDaysAgo: 26, tracking: '794644790132', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10003', poNum: 'SUMMIT-4471', createdDaysAgo: 27, shipTo: 2, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-TENT-4P', qty: 6 }, { sku: 'ACME-COOLER-20', qty: 8 }, { sku: 'ACME-CHAIR-LT', qty: 12 }], state: 'closed', shipDaysAgo: 24, tracking: 'PRO-88231045', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10004', createdDaysAgo: 26, shipTo: 3, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-HDLMP-300', qty: 3 }, { sku: 'ACME-BOTTLE-1L', qty: 4 }], state: 'cancelled', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20001', createdDaysAgo: 17, shipTo: 4, carrier: 'USPS', mode: 'First Class', lines: [{ sku: 'BLB-LIP-ROSE', qty: 2 }, { sku: 'BLB-LIP-CORAL', qty: 1 }], state: 'closed', shipDaysAgo: 16, tracking: '9400111899223197428490', orderType: 'D2C' },
    { customerId: 1, facilityId: 2, ref: 'ACME-SO-10005', createdDaysAgo: 19, shipTo: 5, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-TENT-2P', qty: 10 }, { sku: 'ACME-STOVE-01', qty: 20 }, { sku: 'ACME-BOTTLE-1L', qty: 40 }], state: 'closed', shipDaysAgo: 17, tracking: 'PRO-88231099', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10006', createdDaysAgo: 18, shipTo: 6, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-COOLER-45', qty: 1 }], state: 'closed', shipDaysAgo: 16, tracking: '1Z999AA10123456791', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20002', createdDaysAgo: 16, shipTo: 7, carrier: 'USPS', mode: 'Priority Mail', lines: [{ sku: 'BLB-SERUM-30ML', qty: 1 }, { sku: 'BLB-CLEANSER-150', qty: 1 }], state: 'closed', shipDaysAgo: 15, tracking: '9400111899223197428506', orderType: 'D2C' },
    { customerId: 9, facilityId: 2, ref: 'OOS-SO-1', createdDaysAgo: 14, shipTo: 5, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'OOS-WIDGET-A', qty: 10 }], state: 'closed', shipDaysAgo: 13, tracking: '1Z999AA10123456800' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10007', createdDaysAgo: 14, shipTo: 8, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-TENT-2P', qty: 12 }, { sku: 'ACME-BAG-0F', qty: 8 }, { sku: 'ACME-PAD-LONG', qty: 8 }], state: 'closed', shipDaysAgo: 12, tracking: 'PRO-88231150', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10008', createdDaysAgo: 13, shipTo: 9, carrier: 'FedEx', mode: '2Day', lines: [{ sku: 'ACME-JACKET-RAIN-M', qty: 1 }, { sku: 'ACME-JACKET-RAIN-L', qty: 1 }], state: 'closed', shipDaysAgo: 12, tracking: '794644790149', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10009', createdDaysAgo: 12, shipTo: 10, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-STOVE-01', qty: 1 }, { sku: 'ACME-FIRSTAID-M', qty: 1 }], state: 'cancelled', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20003', createdDaysAgo: 12, shipTo: 11, carrier: 'USPS', mode: 'First Class', lines: [{ sku: 'BLB-MASK-SHEET-5PK', qty: 2 }], state: 'closed', shipDaysAgo: 11, tracking: '9400111899223197428513', orderType: 'D2C' },
    { customerId: 1, facilityId: 2, ref: 'ACME-SO-10010', createdDaysAgo: 11, shipTo: 0, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-HDLMP-300', qty: 2 }, { sku: 'ACME-COOLER-20', qty: 1 }], state: 'closed', shipDaysAgo: 9, tracking: '1Z999AA10123456815', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10011', poNum: 'CASCADE-2210', createdDaysAgo: 10, shipTo: 8, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-CHAIR-LT', qty: 10 }, { sku: 'ACME-TREKPOLE-PR', qty: 10 }], state: 'closed', shipDaysAgo: 7, tracking: 'PRO-88231201', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10012', createdDaysAgo: 9, shipTo: 1, carrier: 'FedEx', mode: 'Ground', lines: [{ sku: 'ACME-COOLER-45', qty: 2 }], state: 'closed', shipDaysAgo: 6, tracking: '794644790156', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20004', createdDaysAgo: 9, shipTo: 2, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'BLB-GIFTBOX-A', qty: 12 }, { sku: 'BLB-BRUSH-SET', qty: 24 }], state: 'closed', shipDaysAgo: 6, tracking: '1Z999AA10123456822', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10013', createdDaysAgo: 8, shipTo: 3, carrier: 'UPS', mode: '2nd Day Air', lines: [{ sku: 'ACME-HDLMP-300', qty: 2 }, { sku: 'ACME-STAKES-10PK', qty: 2 }], state: 'closed', shipDaysAgo: 5, tracking: '1Z999AA10123456839', orderType: 'D2C' },
    { customerId: 9, facilityId: 2, ref: 'OOS-SO-2', createdDaysAgo: 8, shipTo: 5, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'OOS-GADGET-C', qty: 2 }], state: 'open' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10014', createdDaysAgo: 7, shipTo: 4, carrier: 'USPS', mode: 'Priority Mail', lines: [{ sku: 'ACME-BOTTLE-1L', qty: 2 }, { sku: 'ACME-FIRSTAID-M', qty: 1 }], state: 'closed', shipDaysAgo: 4, tracking: '9400111899223197428520', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10015', createdDaysAgo: 7, hourOffset: 3, shipTo: 6, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TENT-2P', qty: 1 }, { sku: 'ACME-PAD-REG', qty: 1 }, { sku: 'ACME-BAG-20F', qty: 1 }], state: 'closed', shipDaysAgo: 3, tracking: '1Z999AA10123456846', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20005', createdDaysAgo: 6, shipTo: 7, carrier: 'USPS', mode: 'First Class', lines: [{ sku: 'BLB-LIP-ROSE', qty: 3 }], state: 'closed', shipDaysAgo: 3, tracking: '9400111899223197428537', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10016', createdDaysAgo: 6, shipTo: 9, carrier: 'FedEx', mode: 'Home Delivery', lines: [{ sku: 'ACME-COOLER-45', qty: 1 }], state: 'closed', shipDaysAgo: 2, tracking: '794644790163', orderType: 'D2C' },
    { customerId: 1, facilityId: 2, ref: 'ACME-SO-10017', createdDaysAgo: 5, shipTo: 10, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-STOVE-01', qty: 3 }], state: 'closed', shipDaysAgo: 1, tracking: '1Z999AA10123456853', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10018', createdDaysAgo: 5, hourOffset: 2, shipTo: 11, carrier: 'UPS', mode: 'Next Day Air', lines: [{ sku: 'ACME-HDLMP-300', qty: 1 }, { sku: 'ACME-FILTER-SQZ', qty: 2, lot: 'LOT-2409A' }], state: 'closed', shipDaysAgo: 1, tracking: '1Z999AA10123456860', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20006', createdDaysAgo: 4, shipTo: 0, carrier: 'USPS', mode: 'Priority Mail', lines: [{ sku: 'BLB-PALETTE-NUDE', qty: 1 }, { sku: 'BLB-BRUSH-SET', qty: 1 }], state: 'closed', shipDaysAgo: 0, tracking: '9400111899223197428544', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10019', createdDaysAgo: 4, shipTo: 1, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TENT-2P', qty: 1 }, { sku: 'ACME-STAKES-10PK', qty: 1 }], state: 'closed', shipDaysAgo: 0, tracking: '1Z999AA10123456877', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10020', createdDaysAgo: 4, hourOffset: 5, shipTo: 2, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-COOLER-45', qty: 2 }, { sku: 'ACME-COOLER-20', qty: 4 }], state: 'open', orderType: 'B2B' }, // consumes the last two COOLER-45 -> zero available
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10021', createdDaysAgo: 3, shipTo: 3, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-COOLER-45', qty: 1 }], state: 'open', orderType: 'D2C' }, // short: no COOLER-45 left
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10022', createdDaysAgo: 3, hourOffset: 1, shipTo: 4, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TENT-4P', qty: 30 }], state: 'open', orderType: 'B2B' }, // short: only 14 TENT-4P left
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10023', createdDaysAgo: 3, hourOffset: 4, shipTo: 5, carrier: 'FedEx', mode: 'Ground', lines: [{ sku: 'ACME-BAG-20F', qty: 2 }, { sku: 'ACME-PAD-REG', qty: 2 }], state: 'hold', holdReason: 'Address verification', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10024', createdDaysAgo: 2, shipTo: 6, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-STOVE-01', qty: 4 }, { sku: 'ACME-BOTTLE-1L', qty: 4 }], state: 'open', earliestShipDaysFromNow: -1, orderType: 'D2C' }, // earliestShipDate in the past, still open
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10025', createdDaysAgo: 2, hourOffset: 2, shipTo: 7, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-HDLMP-300', qty: 20 }], state: 'open', orderType: 'B2B' }, // pushes HDLMP below reorder
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20007', createdDaysAgo: 2, hourOffset: 6, shipTo: 8, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'BLB-LIP-ROSE', qty: 50 }, { sku: 'BLB-LIP-CORAL', qty: 50 }, { sku: 'BLB-CLEANSER-150', qty: 30 }], state: 'open', orderType: 'B2B' },
    { customerId: 1, facilityId: 2, ref: 'ACME-SO-10026', createdDaysAgo: 1, shipTo: 9, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-BAG-20F', qty: 1 }, { sku: 'ACME-HDLMP-300', qty: 1 }], state: 'open', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10027', createdDaysAgo: 1, hourOffset: 3, shipTo: 10, carrier: 'FedEx', mode: '2Day', lines: [{ sku: 'ACME-MEAL-CHILI', qty: 6 }, { sku: 'ACME-FILTER-SQZ', qty: 1, lot: 'LOT-2409B' }], state: 'open', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10028', createdDaysAgo: 1, hourOffset: 5, shipTo: 11, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TREKPOLE-PR', qty: 1 }], state: 'complete', orderType: 'D2C' },
    { customerId: 2, facilityId: 1, ref: 'BLB-SO-20008', createdDaysAgo: 1, hourOffset: 7, shipTo: 0, carrier: 'USPS', mode: 'First Class', lines: [{ sku: 'BLB-SERUM-30ML', qty: 2 }], state: 'cancelled', orderType: 'D2C' },
    { customerId: 9, facilityId: 2, ref: 'OOS-SO-3', createdDaysAgo: 0, hourOffset: -6, shipTo: 5, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'OOS-WIDGET-B', qty: 5 }], state: 'open' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10029', createdDaysAgo: 0, hourOffset: -4, shipTo: 1, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-TENT-2P', qty: 1 }, { sku: 'ACME-BAG-20F', qty: 1 }, { sku: 'ACME-PAD-REG', qty: 1 }], state: 'open', orderType: 'D2C' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10030', createdDaysAgo: 0, hourOffset: -2, shipTo: 2, carrier: 'LTL Freight', mode: 'Standard', lines: [{ sku: 'ACME-STOVE-01', qty: 24 }, { sku: 'ACME-BOTTLE-1L', qty: 48 }], state: 'hold', holdReason: 'Address verification', orderType: 'B2B' },
    { customerId: 1, facilityId: 1, ref: 'ACME-SO-10031', createdDaysAgo: 0, hourOffset: -1, shipTo: 3, carrier: 'UPS', mode: 'Ground', lines: [{ sku: 'ACME-JACKET-RAIN-M', qty: 1 }], state: 'open', orderType: 'D2C' },
  ];
}

function replayReceivers(state: MockState, now: Date): void {
  for (const spec of receiverSpecs(now)) {
    const createdAt = addDays(now, -spec.createdDaysAgo);
    const expected = addDays(now, spec.expectedDaysFromNow);
    const rec = state.createReceiver(
      {
        customerIdentifier: { id: spec.customerId },
        facilityIdentifier: { id: spec.facilityId },
        referenceNum: spec.referenceNum,
        poNum: spec.poNum,
        expectedDate: wireDate(expected),
        carrier: spec.carrier ?? null,
        trailerNumber: spec.trailer ?? null,
        receiverType: spec.receiverType ?? null,
        receiveItems: spec.lines.map((l) => ({
          itemIdentifier: { sku: l.sku },
          qty: l.qty,
          expectedQty: l.qty,
          lotNumber: l.lot ?? null,
          expirationDate: l.exp ?? null,
          locationInfo: l.location ? { display: l.location } : null,
        })),
      },
      { at: createdAt, source: TransactionSource.UiImport, emit: false },
    );
    if (spec.state === 'closed') {
      // Apply received-quantity variances before confirming so the lot reflects what actually arrived.
      spec.lines.forEach((l, idx) => {
        const item = rec.items[idx];
        if (item && l.received !== undefined) item.qty = l.received;
      });
      state.confirmReceiver(rec, { arrivalDate: wireDate(expected) }, { at: expected });
    } else if (spec.state === 'cancelled') {
      state.cancelReceiver(rec, 'Supplier shipment canceled', { at: addDays(createdAt, 1) });
    }
  }
}

function replayOrders(state: MockState, now: Date): void {
  for (const spec of orderSpecs()) {
    const createdAt = addHours(addDays(now, -spec.createdDaysAgo), spec.hourOffset ?? 0);
    const shipTo = SHIP_TOS[spec.shipTo] as Partial<ContactInfo>;
    const rec = state.createOrder(
      {
        customerIdentifier: { id: spec.customerId },
        facilityIdentifier: { id: spec.facilityId },
        referenceNum: spec.ref,
        poNum: spec.poNum ?? null,
        earliestShipDate: spec.earliestShipDaysFromNow === undefined ? null : wireDate(addDays(now, spec.earliestShipDaysFromNow)),
        routingInfo: { carrier: spec.carrier, mode: spec.mode },
        shipTo,
        orderType: spec.orderType ?? null,
        orderItems: spec.lines.map((l) => ({ itemIdentifier: { sku: l.sku }, qty: l.qty, lotNumber: l.lot ?? null })),
      },
      { at: createdAt, source: spec.customerId === 9 ? TransactionSource.UiManual : TransactionSource.RestApi, emit: false },
    );
    switch (spec.state) {
      case 'closed': {
        const shipAt = addHours(addDays(now, -(spec.shipDaysAgo ?? 0)), spec.shipDaysAgo === 0 ? -1 : 10);
        state.confirmOrder(rec, { confirmDate: wireDate(shipAt), trackingNumber: spec.tracking ?? null }, { at: shipAt });
        break;
      }
      case 'cancelled':
        state.cancelOrder(rec, 'Customer requested cancellation', { at: addHours(createdAt, 6) });
        break;
      case 'hold':
        state.holdOrders([rec.order.readOnly.orderId], spec.holdReason ?? 'Hold', false, { at: addHours(createdAt, 1) });
        break;
      case 'complete':
        state.completeOrder(rec, { at: addHours(createdAt, 1) });
        break;
      default:
        break;
    }
  }
}

/** Populate `state` in place. */
export function seed(state: MockState, kind: SeedKind = 'default'): void {
  state.clear();
  if (kind === 'empty') return;
  const now = state.now();
  state.facilities = facilities(now);
  state.locations = locations();
  state.carriers = carriers();
  state.customers = customers(now);
  state.items = items(now, state.customers);
  state.registerCustomerWebhooks();
  replayReceivers(state, now);
  replayOrders(state, now);
  // Seeding must not leave webhook traffic behind (orders were replayed with emit: false, but the
  // hold/confirm/cancel operators emit; drop those deliveries so the log starts empty).
  state.webhooks.deliveries = [];
  state.webhooks.pending = [];
  for (const loc of state.locations) loc.hasInventory = state.lots.some((l) => l.locationId === loc.locationId && l.onHand > 0);
}
