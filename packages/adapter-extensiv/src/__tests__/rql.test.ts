import { describe, expect, it } from 'vitest';
import { orderRql, orderStatusRql, receiptRql, receiptStatusRql } from '../adapter.js';
import { and, contains, eq, escapeValue, formatValue, ge, hv, inList, le, ne, or, outList, prop, rql, startsWith } from '../rql.js';

describe('rql builder', () => {
  it('builds the documented operators', () => {
    expect(eq('referenceNum', 'PO-1')).toBe('referencenum==PO-1');
    expect(ne('readonly.status', 2)).toBe('readonly.status!=2');
    expect(ge('readonly.creationdate', '2026-09-01T00:00:00Z')).toBe('readonly.creationdate=ge=2026-09-01T00:00:00Z');
    expect(le('qty', 5)).toBe('qty=le=5');
    expect(inList('sku', ['A', 'B'])).toBe('sku=in=(A,B)');
    expect(outList('sku', ['A'])).toBe('sku=out=(A)');
    expect(hv('readonly.onholddate', true)).toBe('readonly.onholddate=hv=true');
    expect(contains('shipto.name', 'acme')).toBe('shipto.name==*acme*');
    expect(startsWith('referencenum', 'PO')).toBe('referencenum==PO*');
    expect(prop('ReadOnly.CreationDate')).toBe('readonly.creationdate');
  });

  it('escapes only the reserved characters, once', () => {
    expect(escapeValue('PLAIN-SKU')).toBe('PLAIN-SKU');
    expect(escapeValue('a,b')).toBe('a%2Cb');
    expect(escapeValue('a;b')).toBe('a%3Bb');
    expect(escapeValue('50%')).toBe('50%25');
    expect(escapeValue('x(y)*z=!')).toBe('x%28y%29%2Az%3D%21');
  });

  it('escapes values inside lists and wildcards so a comma cannot split a list', () => {
    expect(inList('sku', ['a,b', 'c'])).toBe('sku=in=(a%2Cb,c)');
    expect(contains('referencenum', 'PO*1')).toBe('referencenum==*PO%2A1*');
  });

  it('formats booleans, numbers and dates', () => {
    expect(formatValue(true)).toBe('true');
    expect(formatValue(12)).toBe('12');
    expect(formatValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('joins with ; for and, parenthesised , for or, dropping empties', () => {
    expect(and('a==1', undefined, false, 'b==2')).toBe('a==1;b==2');
    expect(or('a==1')).toBe('a==1');
    expect(or('a==1', 'b==2')).toBe('(a==1,b==2)');
    expect(and()).toBe('');
    expect(rql.and(rql.eq('a', 1), rql.or(rql.eq('b', 2), rql.eq('c', 3)))).toBe('a==1;(b==2,c==3)');
  });
});

describe('query translation', () => {
  it('maps order statuses onto isclosed/status per the rql note', () => {
    expect(orderStatusRql(['cancelled'])).toBe('readonly.status==2');
    expect(orderStatusRql(['closed'])).toBe('readonly.isclosed==true');
    expect(orderStatusRql(['open'])).toBe('(readonly.isclosed==false;readonly.status!=2)');
    expect(orderStatusRql(['complete'])).toBe('(readonly.isclosed==false;readonly.status!=2)');
    expect(orderStatusRql(['open', 'closed'])).toBe('(readonly.isclosed==true,(readonly.isclosed==false;readonly.status!=2))');
    expect(orderStatusRql([])).toBeUndefined();
    expect(orderStatusRql(undefined)).toBeUndefined();
  });

  it('builds a full order conjunction', () => {
    const q = orderRql({
      customerId: '143',
      facilityId: '10',
      createdAfter: '2026-09-01T00:00:00Z',
      createdBefore: '2026-09-16T00:00:00Z',
      shippedAfter: '2026-09-02T00:00:00Z',
      onHold: true,
      referenceNum: 'PO-1001',
      shipToNameContains: 'widgets',
      statuses: ['open'],
    });
    expect(q).toBe(
      [
        'readonly.customeridentifier.id==143',
        'readonly.facilityidentifier.id==10',
        'readonly.creationdate=ge=2026-09-01T00:00:00Z',
        'readonly.creationdate=lt=2026-09-16T00:00:00Z',
        'readonly.shipdate=ge=2026-09-02T00:00:00Z',
        'readonly.onholddate=hv=true',
        'referencenum==PO-1001',
        'shipto.name==*widgets*',
        '(readonly.isclosed==false;readonly.status!=2)',
      ].join(';'),
    );
  });

  it('leaves the rql empty when nothing was asked for', () => {
    expect(orderRql({})).toBe('');
    expect(receiptRql({})).toBe('');
  });

  it('maps receipt statuses onto the shared status enum', () => {
    expect(receiptStatusRql(['closed'])).toBe('readonly.status==1');
    expect(receiptStatusRql(['open', 'complete'])).toBe('readonly.status==0');
    expect(receiptStatusRql(['open', 'closed'])).toBe('readonly.status=in=(0,1)');
    expect(receiptRql({ customerId: '143', poNum: 'PO-88', expectedAfter: '2026-09-01T00:00:00Z' })).toBe(
      'readonly.customeridentifier.id==143;ponum==PO-88;expecteddate=ge=2026-09-01T00:00:00Z',
    );
  });
});

describe('read allow-list push-down', () => {
  it('sends an =in= predicate for customerIds when no single customer was named', () => {
    const q = orderRql({ customerIds: ['1', '2'] });
    expect(q).toContain('readonly.customeridentifier.id=in=(1,2)');
  });

  it('prefers an explicit customerId over the allow-list', () => {
    const q = orderRql({ customerId: '2', customerIds: ['1', '2'] });
    expect(q).toContain('readonly.customeridentifier.id==2');
    expect(q).not.toContain('=in=');
  });

  it('does the same for receipts', () => {
    expect(receiptRql({ customerIds: ['7'] })).toContain('readonly.customeridentifier.id=in=(7)');
  });
});
