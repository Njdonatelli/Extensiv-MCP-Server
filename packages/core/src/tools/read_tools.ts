import * as z from 'zod/v4';
import type { OrderSummary, ReceiptSummary } from '../domain.js';
import { WmsError } from '../errors.js';
import { common, defineTool, resolveCustomerRef, resolveFacilityRef, type ToolContext } from './define.js';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function dayWindow(day: string | undefined, clock: ToolContext['clock']): { start: string; end: string; day: string } {
  const base = day ? new Date(day) : clock.now();
  if (Number.isNaN(base.getTime())) throw new WmsError('VALIDATION', `Unparseable date '${day}'.`);
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), day: start.toISOString().slice(0, 10) };
}

export const verifyConnection = defineTool({
  name: 'verify_connection',
  title: 'Verify connection',
  description:
    'Check that the server can authenticate to the warehouse system and report what it is pointed at: base URL and environment label, token expiry, how many customers/facilities are reachable, whether write tools are enabled, and any configuration problems. Run this first after setting up credentials or when other tools fail with AUTH_FAILED.',
  kind: 'read',
  inputSchema: z.object({}),
  annotations: RO,
  handler: async (_input, ctx) => {
    const status = await ctx.adapter.verifyConnection();
    const pending = await ctx.engine.listPending();
    return {
      ...status,
      policy: ctx.policy.describe(),
      pendingChanges: pending.length,
      stateDir: ctx.config.stateDir,
      problems: [...status.problems, ...(ctx.policy.writesEnabled && ctx.policy.describe().writeCustomerIds.length === 0 ? ['writes enabled without a write customer allowlist'] : [])],
    };
  },
});

export const describeScope = defineTool({
  name: 'describe_scope',
  title: 'Describe scope',
  description:
    'List the customers and facilities (warehouses) this server is allowed to read and write, with their ids and names, plus the write policy (writes enabled?, writable customers, per-mutation caps). Use it to resolve a customer name to an id before calling other tools, and to explain to the operator why a write was refused.',
  kind: 'read',
  inputSchema: z.object({ include_inactive: z.boolean().default(false).describe('Include deactivated customers.') }),
  annotations: RO,
  handler: async (input, ctx) => {
    const [customers, facilities] = await Promise.all([ctx.adapter.listCustomers(), ctx.adapter.listFacilities()]);
    const readable = ctx.policy.filterCustomers(customers).filter((c) => input.include_inactive || c.active);
    const readableFacilities = ctx.policy.filterFacilities(facilities);
    const policy = ctx.policy.describe();
    return {
      environment: ctx.adapter.info,
      policy,
      customers: readable.map((c) => ({
        id: c.id,
        name: c.name,
        active: c.active,
        facilities: c.facilities,
        writable: ctx.policy.canWrite(c.id),
      })),
      facilities: readableFacilities.map((f) => ({ id: f.id, name: f.name, active: f.active, timeZone: f.timeZone })),
      hiddenByPolicy: { customers: customers.length - ctx.policy.filterCustomers(customers).length, facilities: facilities.length - readableFacilities.length },
    };
  },
});

const orderStatusEnum = z.enum(['open', 'complete', 'closed', 'cancelled']);

export const findOrders = defineTool({
  name: 'find_orders',
  title: 'Find orders',
  description:
    'Search outbound orders and return compact summaries (id, reference number, customer, facility, status open/closed/cancelled, hold, ship date, carrier, tracking numbers, line count). Filter by customer, status, hold flag, reference number (exact or contains), SKU, created or shipped date range, ship-to name. Use get_order_status for the full detail of one order; use find_stuck_orders for exception triage.',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    facility_id: common.facilityId.optional(),
    statuses: z.array(orderStatusEnum).optional().describe("Order statuses to include. 'closed' means shipped and closed. Default: all."),
    on_hold: z.boolean().optional().describe('Only orders on hold (true) or not on hold (false).'),
    reference_num: z.string().optional().describe('Exact reference number (the order number the customer knows).'),
    reference_num_contains: z.string().optional().describe('Substring match on reference number.'),
    sku: z.string().optional().describe('Only orders containing this SKU.'),
    created_after: common.isoDate.optional(),
    created_before: common.isoDate.optional(),
    shipped_after: common.isoDate.optional(),
    shipped_before: common.isoDate.optional(),
    ship_to_name_contains: z.string().optional(),
    limit: common.limit(50, 500),
    page: z.number().int().min(1).default(1),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    const facilityId = await resolveFacilityRef(ctx, input.facility_id);
    const page = await ctx.adapter.findOrders({
      customerId,
      facilityId,
      statuses: input.statuses,
      onHold: input.on_hold,
      referenceNum: input.reference_num,
      referenceNumContains: input.reference_num_contains,
      sku: input.sku,
      createdAfter: input.created_after,
      createdBefore: input.created_before,
      shippedAfter: input.shipped_after,
      shippedBefore: input.shipped_before,
      shipToNameContains: input.ship_to_name_contains,
      limit: input.limit,
      page: input.page,
    });
    const items = customerId ? page.items : page.items.filter((o) => ctx.policy.canReadCustomer(o.customer.id));
    return { total: page.total, page: page.page, pageSize: page.pageSize, hasMore: page.hasMore, orders: items };
  },
});

export const getOrderStatus = defineTool({
  name: 'get_order_status',
  title: 'Get order status',
  description:
    'Everything about one outbound order: status (open/closed/cancelled), hold and reason, ship-to, lines with ordered/allocated/picked/shipped quantities and lots, packages and tracking numbers, carrier/service, a timeline (created, allocated, picked, packed, shipped, cancelled), and the current version token needed by update_order. Look up by order id or by reference number (plus customer_id when reference numbers are not unique across customers). Shipping/closing an order is not exposed by this server; report the state instead.',
  kind: 'read',
  inputSchema: z
    .object({
      order_id: z.string().optional().describe('Warehouse order id. Provide this OR reference_num; at least one is required.'),
      reference_num: z.string().optional().describe('Customer-facing reference number, e.g. ACME-SO-10007. Provide this OR order_id; at least one is required.'),
      customer_id: common.customerId.optional(),
    })
    .refine((v) => v.order_id || v.reference_num, { message: 'order_id or reference_num is required' }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = input.customer_id ? await resolveCustomerRef(ctx, input.customer_id, false) : undefined;
    const order = await ctx.adapter.getOrder({ id: input.order_id, referenceNum: input.reference_num, customerId });
    if (!order) {
      throw new WmsError('NOT_FOUND', `No order found for ${input.order_id ? `id ${input.order_id}` : `reference ${input.reference_num}`}.`, {
        hint: 'Try find_orders with reference_num_contains, or check the customer_id.',
      });
    }
    ctx.policy.assertReadCustomer(order.customer.id);
    return { order };
  },
});

export const findStuckOrders = defineTool({
  name: 'find_stuck_orders',
  title: 'Find stuck orders',
  description:
    'Triage open orders that need attention, grouped by reason: short (not fully allocated because inventory is missing), on_hold, aging (open longer than max_age_days), past_ship_date (earliest ship date already passed), in_progress_stalled (pick or pack started but not finished). Returns counts per reason and the orders in each group with the reason text. Use it for questions like "what is stuck", "what cannot ship", "what needs attention today".',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    facility_id: common.facilityId.optional(),
    max_age_days: z.number().min(0).default(3).describe('Open orders older than this many days count as aging.'),
    limit: common.limit(100, 500),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    const facilityId = await resolveFacilityRef(ctx, input.facility_id);
    const page = await ctx.adapter.findOrders({ customerId, facilityId, statuses: ['open', 'complete'], limit: input.limit, page: 1 });
    const now = ctx.clock.now().getTime();
    const groups: Record<string, { order: OrderSummary; reason: string }[]> = { short: [], on_hold: [], aging: [], past_ship_date: [], in_progress_stalled: [] };
    for (const o of page.items) {
      if (!ctx.policy.canReadCustomer(o.customer.id)) continue;
      const ageDays = (now - Date.parse(o.createdAt)) / 86_400_000;
      if (o.fullyAllocated === false) groups.short!.push({ order: o, reason: 'not fully allocated: inventory short for at least one line' });
      if (o.onHold) groups.on_hold!.push({ order: o, reason: `on hold${o.holdReason ? `: ${o.holdReason}` : ''}` });
      if (ageDays > input.max_age_days) groups.aging!.push({ order: o, reason: `open for ${ageDays.toFixed(1)} days` });
      if (o.earliestShipDate && Date.parse(o.earliestShipDate) < now) groups.past_ship_date!.push({ order: o, reason: `earliest ship date ${o.earliestShipDate} has passed` });
      if ((o.pickDone === false && o.fullyAllocated) || (o.packDone === false && o.pickDone)) groups.in_progress_stalled!.push({ order: o, reason: 'pick/pack started but not finished' });
    }
    const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
    return { scanned: page.items.length, totalOpen: page.total, truncated: page.hasMore, counts, groups };
  },
});

export const checkInventory = defineTool({
  name: 'check_inventory',
  title: 'Check inventory',
  description:
    'Stock positions per SKU at a customer/facility: on hand, available (sellable now), allocated to orders, on hold; optionally lot/expiration/location breakdown. Ask for specific SKUs, a SKU substring, or everything. Set low_stock_only to list SKUs whose available quantity is at or below their reorder point (or below threshold). Use lookup_item for item master data (dims, UOM); use this for quantities.',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    facility_id: common.facilityId.optional(),
    skus: z.array(z.string()).optional().describe('Exact SKUs to check.'),
    sku_contains: z.string().optional().describe('Substring match on SKU or description.'),
    include_lots: z.boolean().default(false).describe('Include lot / expiration / location breakdown.'),
    include_zero: z.boolean().default(false).describe('Include SKUs with zero on hand.'),
    low_stock_only: z.boolean().default(false).describe('Only SKUs at or below their reorder point (or threshold).'),
    threshold: z.number().min(0).optional().describe('Available-quantity threshold for low_stock_only when an item has no reorder point.'),
    limit: common.limit(100, 1000),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, true);
    const facilityId = await resolveFacilityRef(ctx, input.facility_id);
    const positions = await ctx.adapter.getInventory({
      customerId,
      facilityId,
      skus: input.skus,
      skuContains: input.sku_contains,
      includeLots: input.include_lots,
      includeZero: input.include_zero || input.low_stock_only,
      limit: input.limit,
    });
    if (!input.low_stock_only) {
      return { customerId, facilityId, count: positions.length, positions };
    }
    const items = await ctx.adapter.findItems({ customerId, activeOnly: true, limit: 1000 });
    const reorder = new Map(items.map((i) => [i.sku, i.reorderPoint]));
    const low: { sku: string; facility: string; available: number; onHand: number; reorderPoint?: number; threshold: number; deficit: number }[] = [];
    // Items with no stock row at all are the most urgent low-stock cases.
    for (const item of items) {
      if (input.skus && !input.skus.includes(item.sku)) continue;
      if (input.sku_contains && !item.sku.toLowerCase().includes(input.sku_contains.toLowerCase())) continue;
      const rows = positions.filter((p) => p.sku === item.sku);
      const threshold = reorder.get(item.sku) ?? input.threshold;
      if (threshold === undefined) continue;
      if (rows.length === 0) {
        low.push({ sku: item.sku, facility: facilityId ?? 'any', available: 0, onHand: 0, reorderPoint: item.reorderPoint, threshold, deficit: threshold });
        continue;
      }
      for (const r of rows) {
        if (r.available <= threshold) low.push({ sku: r.sku, facility: r.facility.name, available: r.available, onHand: r.onHand, reorderPoint: item.reorderPoint, threshold, deficit: threshold - r.available });
      }
    }
    low.sort((a, b) => b.deficit - a.deficit);
    return { customerId, facilityId, lowStockCount: low.length, lowStock: low.slice(0, input.limit), rule: 'available <= reorderPoint (item master) or threshold (argument)' };
  },
});

export const lookupItem = defineTool({
  name: 'lookup_item',
  title: 'Look up item',
  description:
    'Item master lookup for a customer: find items by exact SKU, UPC, or text in SKU/description. Returns description, active flag, unit of measure, dimensions, weight, lot/serial/expiration tracking rules and reorder point. Does not return quantities (use check_inventory).',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    sku: z.string().optional(),
    upc: z.string().optional(),
    text: z.string().optional().describe('Substring match on SKU or description.'),
    active_only: z.boolean().default(true),
    limit: common.limit(25, 200),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, true);
    const items = await ctx.adapter.findItems({ customerId, sku: input.sku, upc: input.upc, textSearch: input.text, activeOnly: input.active_only, limit: input.limit });
    return { customerId, count: items.length, items };
  },
});

const receiptStatusEnum = z.enum(['open', 'complete', 'closed', 'cancelled']);

export const findReceipts = defineTool({
  name: 'find_receipts',
  title: 'Find receipts',
  description:
    'Search inbound receipts / ASNs (expected deliveries into the warehouse) and return compact summaries: reference number, PO number, customer, facility, status (open = not yet received, closed = confirmed and stock on hand, cancelled), expected and arrival dates, expected vs received units. Filter by customer, status, PO, expected-date range. Use get_receipt_status for line-level variances.',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    facility_id: common.facilityId.optional(),
    statuses: z.array(receiptStatusEnum).optional(),
    reference_num: z.string().optional(),
    po_num: z.string().optional(),
    expected_after: common.isoDate.optional(),
    expected_before: common.isoDate.optional(),
    created_after: common.isoDate.optional(),
    limit: common.limit(50, 500),
    page: z.number().int().min(1).default(1),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    const facilityId = await resolveFacilityRef(ctx, input.facility_id);
    const page = await ctx.adapter.findReceipts({
      customerId,
      facilityId,
      statuses: input.statuses,
      referenceNum: input.reference_num,
      poNum: input.po_num,
      expectedAfter: input.expected_after,
      expectedBefore: input.expected_before,
      createdAfter: input.created_after,
      limit: input.limit,
      page: input.page,
    });
    const items = page.items.filter((r) => ctx.policy.canReadCustomer(r.customer.id));
    return { total: page.total, page: page.page, pageSize: page.pageSize, hasMore: page.hasMore, receipts: items };
  },
});

export const getReceiptStatus = defineTool({
  name: 'get_receipt_status',
  title: 'Get receipt status',
  description:
    'One inbound receipt / ASN in depth: status, expected and arrival dates, carrier/tracking, and every line with expected vs received quantity, variance, lot, expiration and put-away location, plus a timeline. Look up by receipt id or reference number (plus customer_id if needed). Use it for "did PO 4471 arrive", "what was short on the last delivery".',
  kind: 'read',
  inputSchema: z
    .object({
      receipt_id: z.string().optional().describe('Warehouse receipt id. Provide this OR reference_num; at least one is required.'),
      reference_num: z.string().optional().describe('Customer-facing receipt reference number. Provide this OR receipt_id; at least one is required.'),
      customer_id: common.customerId.optional(),
    })
    .refine((v) => v.receipt_id || v.reference_num, { message: 'receipt_id or reference_num is required' }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = input.customer_id ? await resolveCustomerRef(ctx, input.customer_id, false) : undefined;
    const receipt = await ctx.adapter.getReceipt({ id: input.receipt_id, referenceNum: input.reference_num, customerId });
    if (!receipt) throw new WmsError('NOT_FOUND', `No receipt found for ${input.receipt_id ? `id ${input.receipt_id}` : `reference ${input.reference_num}`}.`, { hint: 'Try find_receipts with po_num or a date range.' });
    ctx.policy.assertReadCustomer(receipt.customer.id);
    const variances = receipt.lines.filter((l) => l.variance !== 0);
    return { receipt, varianceLines: variances.length, variances };
  },
});

export const operationsSummary = defineTool({
  name: 'operations_summary',
  title: 'Operations summary',
  description:
    'A one-call daily snapshot for a customer and/or facility on a given day (default today, UTC): orders created and shipped that day, orders both created and cancelled that day, and how many open orders are on hold, short or past their ship date; receipts expected that day, overdue, and closed that day; count of recent webhook events. Every response carries a `caveats` list naming any count the upstream API cannot compute exactly; repeat those caveats to the operator rather than presenting the numbers as exact. Use it for "how are we doing today", "morning status", "end of day recap". For the list behind any number, use find_orders / find_receipts / find_stuck_orders.',
  kind: 'read',
  inputSchema: z.object({
    customer_id: common.customerId.optional(),
    facility_id: common.facilityId.optional(),
    day: common.isoDate.optional().describe('Day to summarize (default: today).'),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    const facilityId = await resolveFacilityRef(ctx, input.facility_id);
    const win = dayWindow(input.day, ctx.clock);
    const base = { customerId, facilityId, limit: 500, page: 1 };
    const [created, shipped, open, receiptsExpected, receiptsOpen, receiptsClosed, events] = await Promise.all([
      ctx.adapter.findOrders({ ...base, createdAfter: win.start, createdBefore: win.end }),
      ctx.adapter.findOrders({ ...base, statuses: ['closed'], shippedAfter: win.start, shippedBefore: win.end }),
      ctx.adapter.findOrders({ ...base, statuses: ['open', 'complete'] }),
      ctx.adapter.findReceipts({ ...base, statuses: ['open', 'complete'], expectedAfter: win.start, expectedBefore: win.end }),
      ctx.adapter.findReceipts({ ...base, statuses: ['open', 'complete'] }),
      ctx.adapter.findReceipts({ ...base, statuses: ['closed'], createdAfter: undefined }),
      ctx.events.query({ since: win.start, customerId, limit: 500 }).catch(() => []),
    ]);
    const readable = <T extends { customer: { id: string } }>(p: { items: T[] }) => p.items.filter((x) => ctx.policy.canReadCustomer(x.customer.id));
    const openOrders = readable(open);
    // Only orders BOTH created and cancelled inside the window can be counted: the upstream
    // API exposes no cancellation date to filter on. Said plainly in `caveats` below.
    const cancelledCreatedToday = readable(created).filter((o) => o.status === 'cancelled');
    const overdueReceipts = readable(receiptsOpen).filter((r: ReceiptSummary) => r.expectedDate && r.expectedDate < win.start);
    const closedToday = readable(receiptsClosed).filter((r: ReceiptSummary) => r.closedAt && r.closedAt >= win.start && r.closedAt < win.end);
    return {
      day: win.day,
      window: { start: win.start, end: win.end, note: 'UTC day boundaries' },
      customerId,
      facilityId,
      orders: {
        createdToday: readable(created).length,
        shippedToday: readable(shipped).length,
        cancelledCreatedToday: cancelledCreatedToday.length,
        openBacklog: open.total,
        openOnHold: openOrders.filter((o) => o.onHold).length,
        openShort: openOrders.filter((o) => o.fullyAllocated === false).length,
        openPastShipDate: openOrders.filter((o) => o.earliestShipDate && Date.parse(o.earliestShipDate) < ctx.clock.now().getTime()).length,
      },
      receipts: {
        expectedToday: readable(receiptsExpected).length,
        overdue: overdueReceipts.length,
        closedToday: closedToday.length,
        openTotal: receiptsOpen.total,
      },
      events: { sinceStartOfDay: events.length, byType: countBy(events.map((e) => e.eventType)) },
      truncation: { openOrdersScanned: openOrders.length, openOrdersTotal: open.total, closedReceiptsScanned: receiptsClosed.items.length, closedReceiptsTotal: receiptsClosed.total },
      caveats: [
        'orders.cancelledCreatedToday counts only orders created AND cancelled within the window; the upstream API has no cancellation-date filter, so an older order cancelled today is not counted.',
        ...(open.hasMore ? ['Open-order counts are based on the first page scanned; totalOpen is exact but the hold/short/past-date breakdown is not.'] : []),
        ...(receiptsClosed.hasMore
          ? ['receipts.closedToday counts only the most recently created closed receipts that were scanned, because the upstream API cannot filter on the date a receipt was closed. A receipt created long ago and closed today may be missed.']
          : []),
      ],
    };
  },
});

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const recentEvents = defineTool({
  name: 'recent_events',
  title: 'Recent events',
  description:
    'Recent events pushed by the warehouse system via webhooks and captured by the webhook-ingest process: order created/updated/shipped (OrderConfirm)/cancelled/fully allocated/packed, receipt created/confirmed/cancelled, inventory holds, item changes. Filter by event type, customer, reference number, or since a timestamp. Answers "what shipped in the last hour", "did anything happen with ACME-SO-10007". If the ingest process is not running the list is empty; verify_connection reports the events file.',
  kind: 'read',
  inputSchema: z.object({
    since: common.isoDate.optional().describe('Only events at or after this time.'),
    event_types: z.array(z.string()).optional().describe('e.g. ["OrderConfirm","OrderCancel"]'),
    customer_id: common.customerId.optional(),
    reference_num: z.string().optional(),
    limit: common.limit(50, 500),
  }),
  annotations: RO,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    const events = await ctx.events.query({ since: input.since, eventTypes: input.event_types, customerId, referenceNum: input.reference_num, limit: input.limit });
    const visible = events.filter((e) => !e.customerId || ctx.policy.canReadCustomer(e.customerId));
    const unverified = visible.filter((e) => !e.verified).length;
    return { count: visible.length, unverifiedSignatures: unverified, eventsFile: ctx.config.eventsFile ?? `${ctx.config.stateDir}/events.jsonl`, events: visible.map(({ raw: _raw, ...e }) => e) };
  },
});

export const READ_TOOLS = [verifyConnection, describeScope, findOrders, getOrderStatus, findStuckOrders, checkInventory, lookupItem, findReceipts, getReceiptStatus, operationsSummary, recentEvents];
