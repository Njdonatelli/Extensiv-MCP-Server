import * as z from 'zod/v4';
import { common, defineTool, resolveCustomerRef, resolveFacilityRef } from './define.js';

const PREP = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const addressSchema = z.object({
  name: z.string().min(1).describe('Recipient name.'),
  companyName: z.string().optional(),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1).describe('State/province code, e.g. CA.'),
  zip: z.string().min(1),
  country: z.string().default('US').describe('ISO country code.'),
  phone: z.string().optional(),
  email: z.string().optional(),
});

const orderLineSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive(),
  qualifier: z.string().optional(),
  lotNumber: z.string().optional(),
});

const idem = z.string().min(8).max(128).optional().describe('Optional client idempotency key. Preparing twice with the same key returns the same change_id instead of a second plan.');

export const createOrder = defineTool({
  name: 'create_order',
  title: 'Create order (prepare)',
  description:
    'PREPARE a new outbound order. Validates the customer, facility, every SKU (must exist and be active for that customer), available stock (warns when short), and the ship-to address, then returns a preview and a change_id. NOTHING IS WRITTEN by this call: show the preview to the operator and call commit_change with the change_id to actually create the order. The reference number must be unique for the customer; if an order with it already exists, commit will return that order instead of creating a duplicate.',
  kind: 'prepare',
  inputSchema: z.object({
    customer_id: common.customerId,
    facility_id: common.facilityId,
    reference_num: z.string().min(1).max(64).describe('Customer-facing order number, unique per customer, e.g. ACME-SO-10099.'),
    ship_to: addressSchema,
    lines: z.array(orderLineSchema).min(1).describe('SKU and quantity per line.'),
    carrier: z.string().optional().describe('Carrier name as configured in the warehouse, e.g. UPS.'),
    service: z.string().optional().describe('Carrier service / mode, e.g. Ground.'),
    earliest_ship_date: common.isoDate.optional(),
    po_num: z.string().optional(),
    notes: z.string().max(2000).optional(),
    idempotency_key: idem,
  }),
  annotations: PREP,
  handler: async (input, ctx) => {
    // Resolve a name to an id before the engine checks write scope, so an operator
    // can say "Acme Outdoor Co" and still get a scope decision on the real id.
    const customerId = (await resolveCustomerRef(ctx, input.customer_id, true))!;
    const facilityId = (await resolveFacilityRef(ctx, input.facility_id))!;
    return ctx.engine.prepare(
      'create_order',
      {
        customerId,
        facilityId,
        referenceNum: input.reference_num,
        shipTo: input.ship_to,
        lines: input.lines,
        carrier: input.carrier,
        service: input.service,
        earliestShipDate: input.earliest_ship_date,
        poNum: input.po_num,
        notes: input.notes,
      },
      { idempotencyKey: input.idempotency_key },
    );
  },
});

export const updateOrder = defineTool({
  name: 'update_order',
  title: 'Update order (prepare)',
  description:
    'PREPARE a change to an OPEN outbound order: ship-to address fields, carrier/service, notes, earliest ship date. Returns a before/after preview and a change_id; NOTHING IS WRITTEN until commit_change. Closed (shipped) or cancelled orders cannot be updated. The commit uses optimistic concurrency: if someone else changed the order after the preview, commit fails and you must prepare again. Line-quantity changes are not supported; cancel and recreate instead.',
  kind: 'prepare',
  inputSchema: z
    .object({
      order_id: z.string().min(1).describe('Warehouse order id from get_order_status or find_orders.'),
      customer_id: common.customerId.optional(),
      ship_to: addressSchema.partial().optional().describe('Only the fields to change.'),
      carrier: z.string().optional(),
      service: z.string().optional(),
      notes: z.string().max(2000).optional(),
      earliest_ship_date: common.isoDate.optional(),
      expected_version: z.string().optional().describe('Version token from get_order_status; commit refuses if the order changed since.'),
      idempotency_key: idem,
    })
    .refine((v) => v.ship_to || v.carrier !== undefined || v.service !== undefined || v.notes !== undefined || v.earliest_ship_date !== undefined, {
      message: 'at least one field to change is required',
    }),
  annotations: PREP,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    return ctx.engine.prepare(
      'update_order',
      {
        orderId: input.order_id,
        customerId,
        shipTo: input.ship_to,
        carrier: input.carrier,
        service: input.service,
        notes: input.notes,
        earliestShipDate: input.earliest_ship_date,
        expectedVersion: input.expected_version,
      },
      { idempotencyKey: input.idempotency_key },
    );
  },
});

export const cancelOrder = defineTool({
  name: 'cancel_order',
  title: 'Cancel order (prepare)',
  description:
    'PREPARE cancelling an OPEN outbound order with a reason. Returns a preview (what will be released, current status) and a change_id; NOTHING IS WRITTEN until commit_change. Orders that are already shipped/closed cannot be cancelled through this server; an already-cancelled order commits as a no-op.',
  kind: 'prepare',
  inputSchema: z.object({
    order_id: z.string().min(1),
    customer_id: common.customerId.optional(),
    reason: z.string().min(3).max(500).describe('Why the order is being cancelled; recorded in the warehouse.'),
    idempotency_key: idem,
  }),
  annotations: PREP,
  handler: async (input, ctx) => {
    const customerId = await resolveCustomerRef(ctx, input.customer_id, false);
    return ctx.engine.prepare('cancel_order', { orderId: input.order_id, customerId, reason: input.reason }, { idempotencyKey: input.idempotency_key });
  },
});

const receiptLineSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive().describe('Expected quantity.'),
  qualifier: z.string().optional(),
  lotNumber: z.string().optional(),
  expirationDate: common.isoDate.optional(),
});

export const createReceipt = defineTool({
  name: 'create_receipt',
  title: 'Create receipt / ASN (prepare)',
  description:
    'PREPARE a new inbound receipt (ASN / expected delivery) for a customer at a facility: reference number, optional PO number and expected date, and the expected SKUs and quantities. Validates SKUs against the item master and returns a preview and change_id; NOTHING IS WRITTEN until commit_change. Confirming (closing) a receipt after physical arrival is done in the warehouse UI, not by this server.',
  kind: 'prepare',
  inputSchema: z.object({
    customer_id: common.customerId,
    facility_id: common.facilityId,
    reference_num: z.string().min(1).max(64).describe('Receipt reference, unique per customer, e.g. ACME-ASN-2031.'),
    po_num: z.string().optional(),
    expected_date: common.isoDate.optional(),
    lines: z.array(receiptLineSchema).min(1),
    supplier: addressSchema.partial().optional(),
    notes: z.string().max(2000).optional(),
    idempotency_key: idem,
  }),
  annotations: PREP,
  handler: async (input, ctx) => {
    const customerId = (await resolveCustomerRef(ctx, input.customer_id, true))!;
    const facilityId = (await resolveFacilityRef(ctx, input.facility_id))!;
    return ctx.engine.prepare(
      'create_receipt',
      {
        customerId,
        facilityId,
        referenceNum: input.reference_num,
        poNum: input.po_num,
        expectedDate: input.expected_date,
        lines: input.lines,
        supplier: input.supplier,
        notes: input.notes,
      },
      { idempotencyKey: input.idempotency_key },
    );
  },
});

export const commitChange = defineTool({
  name: 'commit_change',
  title: 'Commit change',
  description:
    'COMMIT a change previously prepared by create_order, update_order, cancel_order or create_receipt, identified by its change_id. This is the only tool that writes to the warehouse system. It re-checks scope and preconditions against live state, checks whether the effect already exists (so retries never double-create), performs the write exactly once, and records the outcome. Calling it again with the same change_id returns the stored outcome without writing. Only call it after the operator has approved the preview. Use action "discard" to drop a prepared change without committing.',
  kind: 'commit',
  inputSchema: z.object({
    change_id: z.string().regex(/^chg_[a-z0-9]+$/).describe('The change_id returned by a prepare tool.'),
    action: z.enum(['commit', 'discard']).default('commit'),
    requested_by: z.string().max(200).optional().describe('Operator name or identifier for the audit log.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (input.action === 'discard') return ctx.engine.discard(input.change_id);
    return ctx.engine.commit(input.change_id, { requestedBy: input.requested_by });
  },
});

export const WRITE_TOOLS = [createOrder, updateOrder, cancelOrder, createReceipt, commitChange];
