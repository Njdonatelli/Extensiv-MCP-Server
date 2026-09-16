import type { AdapterInfo, OrderRef, ReceiptRef, WmsAdapter } from '../adapter.js';
import type { ConnectionStatus, Customer, Facility, InventoryPosition, Item, OrderDetail, OrderQuery, OrderSummary, Page, ReceiptDetail, ReceiptQuery, ReceiptSummary } from '../domain.js';
import { WmsError } from '../errors.js';
import type { MutationInputMap, MutationKind, MutationOutcome, MutationPlan, PreconditionResult } from '../mutation.js';

/**
 * In-memory adapter with just enough behaviour to exercise the engine and tools:
 * orders keyed by id with a version counter, natural-key uniqueness on referenceNum.
 */
export class FakeAdapter implements WmsAdapter {
  info: AdapterInfo = { system: 'fake-wms', displayName: 'Fake WMS', baseUrl: 'http://fake', environmentLabel: 'test' };
  orders = new Map<string, OrderDetail>();
  executeCalls: MutationPlan[] = [];
  failExecuteWith: WmsError | undefined;
  nextId = 100;
  customers: Customer[] = [
    { id: '1', name: 'Acme', active: true, facilities: [{ id: '1', name: 'LAX-1' }] },
    { id: '9', name: 'Out Of Scope', active: true, facilities: [{ id: '2', name: 'DFW-2' }] },
  ];

  seedOrder(o: Partial<OrderDetail> & { id: string; referenceNum: string }): OrderDetail {
    const full: OrderDetail = {
      customer: { id: '1', name: 'Acme' },
      facility: { id: '1', name: 'LAX-1' },
      status: 'open',
      onHold: false,
      createdAt: '2026-09-10T00:00:00Z',
      trackingNumbers: [],
      lineCount: 1,
      totalQty: 1,
      lines: [{ sku: 'SKU-1', qtyOrdered: 1 }],
      shipTo: { name: 'x' },
      packages: [],
      timeline: [],
      version: 'v1',
      ...o,
    };
    this.orders.set(full.id, full);
    return full;
  }

  async verifyConnection(): Promise<ConnectionStatus> {
    return { ok: true, system: 'fake', baseUrl: this.info.baseUrl, environmentLabel: 'test', authenticated: true, problems: [] };
  }
  async listCustomers(): Promise<Customer[]> {
    return this.customers;
  }
  async listFacilities(): Promise<Facility[]> {
    return [
      { id: '1', name: 'LAX-1', active: true },
      { id: '2', name: 'DFW-2', active: true },
    ];
  }
  async findOrders(q: OrderQuery): Promise<Page<OrderSummary>> {
    let items = [...this.orders.values()];
    if (q.customerId) items = items.filter((o) => o.customer.id === q.customerId);
    if (q.referenceNum) items = items.filter((o) => o.referenceNum === q.referenceNum);
    if (q.statuses) items = items.filter((o) => q.statuses!.includes(o.status));
    if (q.onHold !== undefined) items = items.filter((o) => o.onHold === q.onHold);
    if (q.createdAfter) items = items.filter((o) => o.createdAt >= q.createdAfter!);
    if (q.createdBefore) items = items.filter((o) => o.createdAt < q.createdBefore!);
    if (q.shippedAfter) items = items.filter((o) => o.shippedAt && o.shippedAt >= q.shippedAfter!);
    if (q.shippedBefore) items = items.filter((o) => o.shippedAt && o.shippedAt < q.shippedBefore!);
    const pageSize = q.limit ?? 50;
    const page = q.page ?? 1;
    const slice = items.slice((page - 1) * pageSize, page * pageSize);
    return { items: slice.map(({ lines: _l, ...rest }) => rest), total: items.length, page, pageSize, hasMore: page * pageSize < items.length };
  }
  async getOrder(ref: OrderRef): Promise<OrderDetail | null> {
    if (ref.id) return this.orders.get(ref.id) ?? null;
    const found = [...this.orders.values()].filter((o) => o.referenceNum === ref.referenceNum && (!ref.customerId || o.customer.id === ref.customerId));
    if (found.length > 1) throw new WmsError('AMBIGUOUS', 'multiple');
    return found[0] ?? null;
  }
  async findReceipts(_q: ReceiptQuery): Promise<Page<ReceiptSummary>> {
    return { items: [], total: 0, page: 1, pageSize: 50, hasMore: false };
  }
  async getReceipt(_ref: ReceiptRef): Promise<ReceiptDetail | null> {
    return null;
  }
  async getInventory(): Promise<InventoryPosition[]> {
    return [
      { sku: 'SKU-1', customer: { id: '1', name: 'Acme' }, facility: { id: '1', name: 'LAX-1' }, onHand: 10, available: 4, allocated: 6, onHold: 0 },
      { sku: 'SKU-2', customer: { id: '1', name: 'Acme' }, facility: { id: '1', name: 'LAX-1' }, onHand: 0, available: 0, allocated: 0, onHold: 0 },
    ];
  }
  async findItems(): Promise<Item[]> {
    return [
      { sku: 'SKU-1', customer: { id: '1', name: 'Acme' }, active: true, reorderPoint: 5 },
      { sku: 'SKU-2', customer: { id: '1', name: 'Acme' }, active: true, reorderPoint: 2 },
      { sku: 'SKU-3', customer: { id: '1', name: 'Acme' }, active: true, reorderPoint: 1 },
    ];
  }

  async planMutation<K extends MutationKind>(kind: K, input: MutationInputMap[K]): Promise<MutationPlan<K>> {
    if (kind === 'create_order') {
      const i = input as MutationInputMap['create_order'];
      return {
        kind,
        summary: `Create order ${i.referenceNum} for customer ${i.customerId}`,
        scope: { customerId: i.customerId, facilityId: i.facilityId },
        input,
        preview: { referenceNum: i.referenceNum, lines: i.lines },
        warnings: [],
        preconditions: [{ type: 'absent', resource: `order:${i.customerId}:${i.referenceNum}`, description: `no order ${i.referenceNum} exists for customer ${i.customerId}` }],
        naturalKey: { type: 'order.referenceNum', value: `${i.customerId}:${i.referenceNum}` },
        upstream: [{ method: 'POST', path: '/orders', body: { referenceNum: i.referenceNum } }],
        risk: 'medium',
        upstreamIdempotent: false,
      } as unknown as MutationPlan<K>;
    }
    if (kind === 'cancel_order') {
      const i = input as MutationInputMap['cancel_order'];
      const o = this.orders.get(i.orderId);
      if (!o) throw new WmsError('NOT_FOUND', `order ${i.orderId} not found`);
      if (o.status === 'closed') throw new WmsError('VALIDATION', 'shipped orders cannot be cancelled');
      return {
        kind,
        summary: `Cancel order ${o.referenceNum}`,
        scope: { customerId: o.customer.id, facilityId: o.facility.id },
        input: { ...i, customerId: o.customer.id },
        preview: { status: o.status },
        warnings: o.status === 'cancelled' ? ['already cancelled'] : [],
        preconditions: [
          { type: 'status', resource: `order:${o.id}`, expected: ['open', 'cancelled'], description: `order ${o.id} is open` },
          { type: 'version', resource: `order:${o.id}`, expected: o.version!, description: `order ${o.id} unchanged since preview (version ${o.version})` },
        ],
        upstream: [{ method: 'POST', path: `/orders/${o.id}/canceler`, body: { reason: i.reason } }],
        risk: 'high',
        upstreamIdempotent: true,
      } as unknown as MutationPlan<K>;
    }
    if (kind === 'update_order') {
      const i = input as MutationInputMap['update_order'];
      const o = this.orders.get(i.orderId);
      if (!o) throw new WmsError('NOT_FOUND', `order ${i.orderId} not found`);
      return {
        kind,
        summary: `Update order ${o.referenceNum}`,
        scope: { customerId: o.customer.id },
        input: { ...i, customerId: o.customer.id },
        preview: { before: { notes: o.notes }, after: { notes: i.notes } },
        warnings: [],
        preconditions: [{ type: 'version', resource: `order:${o.id}`, expected: i.expectedVersion ?? o.version!, description: `order ${o.id} unchanged since preview` }],
        upstream: [{ method: 'PUT', path: `/orders/${o.id}`, headers: { 'If-Match': o.version! } }],
        risk: 'medium',
        upstreamIdempotent: false,
      } as unknown as MutationPlan<K>;
    }
    throw new WmsError('VALIDATION', `fake adapter does not plan ${kind}`);
  }

  async checkPreconditions(plan: MutationPlan): Promise<PreconditionResult[]> {
    const out: PreconditionResult[] = [];
    for (const p of plan.preconditions) {
      if (p.type === 'absent') {
        const [cust, ref] = p.resource.replace('order:', '').split(':');
        const exists = [...this.orders.values()].some((o) => o.customer.id === cust && o.referenceNum === ref);
        out.push({ precondition: p, ok: !exists, actual: exists ? 'exists' : 'absent' });
      } else if (p.type === 'version') {
        const o = this.orders.get(p.resource.replace('order:', ''));
        out.push({ precondition: p, ok: o?.version === p.expected, actual: o?.version, message: o?.version === p.expected ? undefined : `now ${o?.version}` });
      } else if (p.type === 'status') {
        const o = this.orders.get(p.resource.replace('order:', ''));
        out.push({ precondition: p, ok: !!o && p.expected.includes(o.status), actual: o?.status });
      } else {
        out.push({ precondition: p, ok: true });
      }
    }
    return out;
  }

  async findApplied(plan: MutationPlan): Promise<MutationOutcome | null> {
    if (plan.kind === 'create_order' && plan.naturalKey) {
      const [cust, ref] = plan.naturalKey.value.split(':');
      const o = [...this.orders.values()].find((x) => x.customer.id === cust && x.referenceNum === ref);
      return o ? { resourceType: 'order', resourceId: o.id, referenceNum: o.referenceNum, status: o.status, version: o.version, via: 'found_existing' } : null;
    }
    if (plan.kind === 'cancel_order') {
      const o = this.orders.get((plan.input as MutationInputMap['cancel_order']).orderId);
      return o && o.status === 'cancelled' ? { resourceType: 'order', resourceId: o.id, referenceNum: o.referenceNum, status: 'cancelled', via: 'found_existing' } : null;
    }
    return null;
  }

  async executeMutation(plan: MutationPlan): Promise<MutationOutcome> {
    this.executeCalls.push(plan);
    if (this.failExecuteWith) {
      const e = this.failExecuteWith;
      this.failExecuteWith = undefined;
      if (e.code === 'OUTCOME_UNKNOWN' && plan.kind === 'create_order') {
        // simulate "applied but response lost"
        const i = plan.input as MutationInputMap['create_order'];
        this.seedOrder({ id: String(this.nextId++), referenceNum: i.referenceNum, customer: { id: i.customerId, name: 'Acme' } });
      }
      throw e;
    }
    if (plan.kind === 'create_order') {
      const i = plan.input as MutationInputMap['create_order'];
      const o = this.seedOrder({ id: String(this.nextId++), referenceNum: i.referenceNum, customer: { id: i.customerId, name: 'Acme' }, lines: i.lines.map((l) => ({ sku: l.sku, qtyOrdered: l.qty })) });
      return { resourceType: 'order', resourceId: o.id, referenceNum: o.referenceNum, status: o.status, version: o.version, via: 'executed' };
    }
    if (plan.kind === 'cancel_order') {
      const o = this.orders.get((plan.input as MutationInputMap['cancel_order']).orderId)!;
      o.status = 'cancelled';
      o.version = 'v' + (Number(o.version!.slice(1)) + 1);
      return { resourceType: 'order', resourceId: o.id, referenceNum: o.referenceNum, status: 'cancelled', version: o.version, via: 'executed' };
    }
    if (plan.kind === 'update_order') {
      const i = plan.input as MutationInputMap['update_order'];
      const o = this.orders.get(i.orderId)!;
      o.notes = i.notes;
      o.version = 'v' + (Number(o.version!.slice(1)) + 1);
      return { resourceType: 'order', resourceId: o.id, referenceNum: o.referenceNum, status: o.status, version: o.version, via: 'executed' };
    }
    throw new WmsError('VALIDATION', 'unsupported');
  }
}
