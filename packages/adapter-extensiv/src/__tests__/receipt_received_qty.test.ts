import { describe, expect, it } from 'vitest';
import { receiptArrived, toReceiptDetail, toReceiptSummary } from '../mapping.js';
import type { WireReceiveItem, WireReceiver } from '../wire.js';
import { fixture } from './fake_api.js';

/** An ASN line as the API returns it before anything is keyed: qty mirrors expectedQty. */
function asnLine(id: number, sku: string, qty: number, expectedQty: number | null = qty): WireReceiveItem {
  return {
    readOnly: { receiveItemId: id, expectedQty, inventoryLevels: { onHand: 0, available: 0 } },
    itemIdentifier: { sku, id },
    qty,
  };
}

function receiver(over: Partial<WireReceiver> & { status: number; items: WireReceiveItem[] }): WireReceiver {
  const { status, items, ...rest } = over;
  return {
    readOnly: {
      receiverId: 7006,
      receiverType: 2,
      customerIdentifier: { name: 'Acme Distribution', id: 1 },
      facilityIdentifier: { name: 'LAX-1', id: 1 },
      creationDate: '2026-09-17T08:00:00Z',
      lastModifiedDate: '2026-09-17T08:00:00Z',
      status,
    },
    referenceNum: 'ACME-ASN-5004',
    poNum: 'PO-ACME-2204',
    expectedDate: '2026-09-22T00:00:00Z',
    arrivalDate: null,
    receiveItems: items,
    ...rest,
  };
}

const asnItems = () => [asnLine(9001, 'ACME-COOLER-45', 24), asnLine(9002, 'ACME-TENT-4P', 30), asnLine(9003, 'ACME-HDLMP-300', 100)];

describe('received quantities on a receiver that has not arrived', () => {
  it('reports nothing received for an open ASN whose qty mirrors expectedQty', () => {
    const s = toReceiptSummary(receiver({ status: 0, items: asnItems() }));
    expect(s).toMatchObject({ status: 'open', totalExpectedQty: 154, totalReceivedQty: 0 });
  });

  it('shows the whole line as outstanding rather than a zero variance', () => {
    const d = toReceiptDetail(receiver({ status: 0, items: asnItems() }));
    expect(d.lines).toEqual([
      expect.objectContaining({ sku: 'ACME-COOLER-45', qtyExpected: 24, qtyReceived: 0, variance: -24 }),
      expect.objectContaining({ sku: 'ACME-TENT-4P', qtyExpected: 30, qtyReceived: 0, variance: -30 }),
      expect.objectContaining({ sku: 'ACME-HDLMP-300', qtyExpected: 100, qtyReceived: 0, variance: -100 }),
    ]);
  });

  it('treats a plain receiver without expectedQty the same way', () => {
    const d = toReceiptDetail(receiver({ status: 0, items: [asnLine(9010, 'ACME-PAD-REG', 40, null)] }));
    expect(d.lines[0]).toMatchObject({ qtyExpected: 40, qtyReceived: 0, variance: -40 });
    expect(d.totalReceivedQty).toBe(0);
  });

  it('reports nothing received for a cancelled receiver even with an arrival date', () => {
    const s = toReceiptSummary(receiver({ status: 2, arrivalDate: '2026-09-18T14:00:00Z', items: asnItems() }));
    expect(s).toMatchObject({ status: 'cancelled', totalExpectedQty: 154, totalReceivedQty: 0 });
  });

  it('keeps the open receiver fixture consistent: nothing on hand, nothing reported received', () => {
    const d = toReceiptDetail(fixture<WireReceiver>('receiver_open.json'));
    expect(d.status).toBe('open');
    expect(d.arrivalDate).toBeUndefined();
    expect(d.totalReceivedQty).toBe(0);
    expect(d.lines.map((l) => l.qtyReceived)).toEqual([0, 0]);
  });
});

describe('received quantities once the record says the goods arrived', () => {
  it('counts qty on a confirmed receiver', () => {
    const s = toReceiptSummary(fixture<WireReceiver>('receiver_closed.json'));
    expect(s).toMatchObject({ status: 'closed', totalExpectedQty: 200, totalReceivedQty: 200 });
  });

  it('keeps the short-receipt variance on a confirmed ASN', () => {
    const d = toReceiptDetail(receiver({ status: 1, arrivalDate: '2026-09-22T14:00:00Z', items: [asnLine(9001, 'ACME-COOLER-45', 20, 24)] }));
    expect(d.lines[0]).toMatchObject({ qtyExpected: 24, qtyReceived: 20, variance: -4 });
    expect(d.totalReceivedQty).toBe(20);
  });

  it('counts qty on an open receiver that already carries an arrival date', () => {
    const w = receiver({ status: 0, arrivalDate: '2026-09-20T09:00:00Z', items: [asnLine(9001, 'ACME-COOLER-45', 24), asnLine(9002, 'ACME-TENT-4P', 10, 30)] });
    expect(receiptArrived(w)).toBe(true);
    expect(toReceiptSummary(w)).toMatchObject({ status: 'open', totalExpectedQty: 54, totalReceivedQty: 34 });
  });

  it('does not treat an expected date as an arrival', () => {
    expect(receiptArrived(receiver({ status: 0, items: asnItems() }))).toBe(false);
  });
});
