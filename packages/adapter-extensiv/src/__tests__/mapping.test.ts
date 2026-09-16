import { describe, expect, it } from 'vitest';
import {
  attachLots,
  toCustomer,
  toFacility,
  toInventoryPositions,
  toItem,
  toOrderDetail,
  toOrderStatus,
  toOrderSummary,
  toReceiptDetail,
  toReceiptSummary,
  trackingNumbersOf,
} from '../mapping.js';
import { REL, embedded } from '../hal.js';
import type { WireCustomer, WireFacility, WireItem, WireOrder, WireReceiver, WireStockDetail, WireStockSummary } from '../wire.js';
import { fixture } from './fake_api.js';

const openOrder = () => fixture<WireOrder>('order_open.json');
const closedOrder = () => fixture<WireOrder>('order_closed.json');
const cancelledOrder = () => fixture<WireOrder>('order_cancelled.json');

describe('customers, facilities, items', () => {
  it('maps customers including the deactivated flag and facility list', () => {
    const rows = embedded<WireCustomer>(fixture('customers_page.json'), REL.customer);
    const [acme, old] = rows.map(toCustomer);
    expect(acme).toMatchObject({ id: '143', name: 'Acme Distribution', active: true, externalId: 'ACME' });
    expect(acme!.facilities).toEqual([
      { id: '10', name: 'LAX-1' },
      { id: '11', name: 'DFW-2' },
    ]);
    expect(old).toMatchObject({ id: '144', name: 'Old Client LLC', active: false });
  });

  it('maps facilities with time zone and contact address', () => {
    const rows = embedded<WireFacility>(fixture('facilities_page.json'), REL.facility);
    const [lax, dfw] = rows.map(toFacility);
    expect(lax).toMatchObject({ id: '10', name: 'LAX-1', active: true, timeZone: 'Pacific Standard Time' });
    expect(lax!.address).toMatchObject({ city: 'Los Angeles', state: 'CA', zip: '90001' });
    expect(dfw!.address).toBeUndefined();
  });

  it('maps item tracking rules, reorder point and imperial dimensions', () => {
    const rows = embedded<WireItem>(fixture('items_page.json'), REL.customerItem);
    const items = rows.map((r) => toItem(r));
    expect(items[0]).toMatchObject({
      sku: 'WIDGET-BLUE',
      upc: '0001112223334',
      active: true,
      unitOfMeasure: 'Each',
      trackLots: true,
      trackExpiration: true,
      trackSerials: false,
      reorderPoint: 40,
      dimensions: { length: 6, width: 3, height: 2, unit: 'in' },
      weight: { value: 1.4, unit: 'lb' },
    });
    expect(items[0]!.customer).toEqual({ id: '143', name: 'Acme Distribution' });
    // reorderQuantity is null here, so minimumStock stands in, and there are no dimensions.
    expect(items[1]).toMatchObject({ sku: 'WIDGET-RED', reorderPoint: 12, trackLots: false, weight: { value: 9, unit: 'lb' } });
    expect(items[1]!.dimensions).toBeUndefined();
    expect(items[2]).toMatchObject({ sku: 'WIDGET-LEGACY', active: false });
  });
});

describe('order mapping', () => {
  it('maps the WarehouseTransactionApiStatus enum', () => {
    expect(toOrderStatus({ status: 0 })).toBe('open');
    expect(toOrderStatus({ status: 1 })).toBe('closed');
    expect(toOrderStatus({ status: 2 })).toBe('cancelled');
    // No "complete" member exists upstream, so a missing status falls back to isClosed.
    expect(toOrderStatus({ isClosed: true })).toBe('closed');
    expect(toOrderStatus(undefined)).toBe('open');
  });

  it('maps an open, on-hold, partially allocated order', () => {
    const d = toOrderDetail(openOrder(), { version: 'W/"etag-1001"' });
    expect(d).toMatchObject({
      id: '1001',
      referenceNum: 'PO-1001',
      status: 'open',
      onHold: true,
      holdReason: 'Credit hold',
      customer: { id: '143', name: 'Acme Distribution' },
      facility: { id: '10', name: 'LAX-1' },
      lineCount: 2,
      totalQty: 30,
      carrier: 'FedEx',
      service: 'Ground',
      shipToName: 'Dana Receiver',
      shipToCity: 'San Francisco',
      version: 'W/"etag-1001"',
    });
    expect(d.shippedAt).toBeUndefined();
    expect(d.trackingNumbers).toEqual([]);
    expect(d.lines[0]).toMatchObject({ lineId: '90001', sku: 'WIDGET-BLUE', qtyOrdered: 10, qtyAllocated: 6 });
    expect(d.lines[1]).toMatchObject({ lineId: '90002', sku: 'WIDGET-RED', qtyOrdered: 20, qtyAllocated: 20, expirationDate: '2027-01-31T00:00:00Z' });
    expect(d.allocationSummary).toEqual({ fullyAllocated: false, shortLines: [{ sku: 'WIDGET-BLUE', short: 4 }] });
    expect(d.shipTo).toMatchObject({ address1: '500 Market St', zip: '94105', phone: '415-555-0101', email: 'dock@widgets.example' });
    expect(d.billTo).toMatchObject({ name: 'AP Dept' });
  });

  it('builds a chronological timeline with human event names', () => {
    const d = toOrderDetail(openOrder());
    expect(d.timeline).toEqual([
      { at: '2026-09-11T18:30:00Z', event: 'order created', detail: undefined },
      { at: '2026-09-12T15:04:00Z', event: 'picking started', detail: undefined },
      { at: '2026-09-12T16:00:00Z', event: 'placed on hold', detail: 'Credit hold' },
      { at: '2026-09-12T16:00:05Z', event: 'last modified', detail: undefined },
    ]);
    const closed = toOrderDetail(closedOrder());
    expect(closed.timeline.map((e) => e.event)).toEqual([
      'order created',
      'picking started',
      'picking done',
      'packing started',
      'packing done',
      'shipped',
      'last modified',
    ]);
  });

  it('dedupes tracking numbers across routingInfo, packages and parcelResponse', () => {
    expect(trackingNumbersOf(closedOrder())).toEqual(['1Z999AA10123456784', '1Z999AA10123456791']);
  });

  it('maps a closed order with packages and packed quantities', () => {
    const d = toOrderDetail(closedOrder(), { version: 'etag-1002' });
    expect(d.status).toBe('closed');
    expect(d.shippedAt).toBe('2026-09-09T22:00:00Z');
    expect(d.pickDone).toBe(true);
    expect(d.packDone).toBe(true);
    expect(d.packages).toEqual([{ id: '55001', trackingNumber: '1Z999AA10123456784', weight: 14.5, skus: [{ sku: 'WIDGET-BLUE', qty: 4 }] }]);
    expect(d.lines[0]).toMatchObject({ sku: 'WIDGET-BLUE', qtyOrdered: 4, qtyAllocated: 4, qtyPicked: 4, qtyShipped: 4 });
    expect(d.allocationSummary).toEqual({ fullyAllocated: true, shortLines: [] });
  });

  it('maps a cancelled order and falls back to numUnits1 when items are not embedded', () => {
    expect(toOrderSummary(cancelledOrder()).status).toBe('cancelled');
    const noItems = { ...openOrder(), _embedded: undefined };
    const s = toOrderSummary(noItems);
    expect(s.lineCount).toBe(0);
    expect(s.totalQty).toBe(30);
  });

  it('uses the cached id->name maps when an identifier carries no name', () => {
    const wire = openOrder();
    wire.readOnly!.customerIdentifier = { id: 143 };
    wire.readOnly!.facilityIdentifier = { id: 10 };
    const s = toOrderSummary(wire, { customers: new Map([['143', 'Acme Distribution']]), facilities: new Map([['10', 'LAX-1']]) });
    expect(s.customer).toEqual({ id: '143', name: 'Acme Distribution' });
    expect(s.facility).toEqual({ id: '10', name: 'LAX-1' });
  });

  it('maps a list row into a summary', () => {
    const rows = embedded<WireOrder>(fixture('orders_page.json'), REL.order);
    const summaries = rows.map((r) => toOrderSummary(r));
    expect(summaries.map((s) => [s.id, s.status, s.lineCount, s.totalQty])).toEqual([
      ['1001', 'open', 2, 30],
      ['1002', 'closed', 1, 4],
    ]);
    expect(summaries[1]!.trackingNumbers).toEqual(['1Z999AA10123456784']);
  });
});

describe('receipt mapping', () => {
  it('maps expected vs received with a per-line variance and summed totals', () => {
    const d = toReceiptDetail(fixture<WireReceiver>('receiver_open.json'), { version: 'etag-3001' });
    expect(d).toMatchObject({
      id: '3001',
      referenceNum: 'ASN-3001',
      poNum: 'PO-88',
      status: 'open',
      expectedDate: '2026-09-18T00:00:00Z',
      lineCount: 2,
      totalExpectedQty: 150,
      totalReceivedQty: 146,
      carrier: 'Old Dominion',
      trackingNumber: 'OD-55512',
      version: 'etag-3001',
    });
    expect(d.lines[0]).toMatchObject({ lineId: '8001', sku: 'WIDGET-BLUE', qtyExpected: 100, qtyReceived: 96, variance: -4, lotNumber: 'L-90', location: 'RCV-DOCK' });
    expect(d.lines[1]!.variance).toBe(0);
    expect(d.closedAt).toBeUndefined();
    expect(d.timeline.map((e) => e.event)).toEqual(['receipt created', 'last modified', 'expected at warehouse']);
  });

  it('treats a receiver without expectedQty as having no variance and stamps closedAt', () => {
    const s = toReceiptSummary(fixture<WireReceiver>('receiver_closed.json'));
    expect(s).toMatchObject({ id: '3002', status: 'closed', totalExpectedQty: 200, totalReceivedQty: 200, closedAt: '2026-09-02T17:30:00Z', arrivalDate: '2026-09-02T14:00:00Z' });
  });

  it('maps a receiver list page', () => {
    const rows = embedded<WireReceiver>(fixture('receivers_page.json'), REL.receiver);
    expect(rows.map((r) => toReceiptSummary(r)).map((s) => [s.id, s.status, s.totalExpectedQty, s.totalReceivedQty])).toEqual([
      ['3001', 'open', 150, 146],
      ['3002', 'closed', 200, 200],
    ]);
  });
});

describe('inventory mapping', () => {
  const summaries = () => (fixture<{ summaries: WireStockSummary[] }>('stocksummaries.json')).summaries;
  const details = () => embedded<WireStockDetail>(fixture('stockdetails.json'), REL.item);

  it('maps stock summary rows against the customer the adapter queried for', () => {
    const positions = toInventoryPositions(summaries(), { customer: { id: '143', name: 'Acme Distribution' }, facilities: new Map([['10', 'LAX-1']]) });
    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({
      sku: 'WIDGET-BLUE',
      customer: { id: '143', name: 'Acme Distribution' },
      facility: { id: '10', name: 'LAX-1' },
      onHand: 200,
      available: 174,
      allocated: 26,
      onHold: 0,
    });
    expect(positions[2]).toMatchObject({ sku: 'WIDGET-GONE', onHand: 0 });
  });

  it('attaches lot rows to the matching position', () => {
    const positions = toInventoryPositions(summaries(), { customer: { id: '143', name: 'Acme Distribution' }, facilities: new Map([['10', 'LAX-1']]) });
    attachLots(positions, details(), () => '10');
    expect(positions[0]!.lots).toEqual([
      { lotNumber: 'L-77', expirationDate: '2027-03-31T00:00:00Z', location: 'A-01-02', onHand: 120, available: 94, allocated: 26, onHold: 0, receivedAt: '2026-08-20T10:00:00Z' },
      { lotNumber: 'L-90', expirationDate: '2027-06-30T00:00:00Z', location: 'QC-HOLD', onHand: 80, available: 80, allocated: 0, onHold: 80, receivedAt: '2026-09-02T14:00:00Z' },
    ]);
    expect(positions[0]!.description).toBe('Blue widget, 6 inch');
    expect(positions[1]!.lots).toBeUndefined();
  });
});
