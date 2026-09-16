/**
 * Two-phase mutation contract.
 *
 * prepare: the adapter builds a MutationPlan (validated, previewed, with
 *          preconditions and a natural key) but performs no upstream write.
 * commit:  the engine re-checks preconditions, checks whether the effect is
 *          already present upstream (natural key), executes exactly once, and
 *          stores the outcome so any replay of the same change id is a no-op
 *          that returns the stored outcome.
 */
import type { Address } from './domain.js';

export type MutationKind = 'create_order' | 'update_order' | 'cancel_order' | 'create_receipt';

export const MUTATION_KINDS: readonly MutationKind[] = ['create_order', 'update_order', 'cancel_order', 'create_receipt'];

export interface CreateOrderInput {
  customerId: string;
  facilityId: string;
  referenceNum: string;
  shipTo: Address;
  lines: { sku: string; qty: number; qualifier?: string; lotNumber?: string }[];
  carrier?: string;
  service?: string;
  earliestShipDate?: string;
  notes?: string;
  poNum?: string;
  /** Adapter-specific pass-through kept separate so the core stays generic. */
  extra?: Record<string, unknown>;
}

export interface UpdateOrderInput {
  orderId: string;
  customerId?: string;
  shipTo?: Partial<Address>;
  carrier?: string;
  service?: string;
  notes?: string;
  earliestShipDate?: string;
  /** Optional optimistic-concurrency token captured from get_order_status. */
  expectedVersion?: string;
}

export interface CancelOrderInput {
  orderId: string;
  customerId?: string;
  reason: string;
}

export interface CreateReceiptInput {
  customerId: string;
  facilityId: string;
  referenceNum: string;
  poNum?: string;
  expectedDate?: string;
  lines: { sku: string; qty: number; qualifier?: string; lotNumber?: string; expirationDate?: string }[];
  supplier?: Address;
  notes?: string;
  extra?: Record<string, unknown>;
}

export type MutationInputMap = {
  create_order: CreateOrderInput;
  update_order: UpdateOrderInput;
  cancel_order: CancelOrderInput;
  create_receipt: CreateReceiptInput;
};

export type Precondition =
  | { type: 'version'; resource: string; expected: string; description: string }
  | { type: 'status'; resource: string; expected: string[]; description: string }
  | { type: 'absent'; resource: string; description: string }
  | { type: 'custom'; resource: string; key: string; expected: unknown; description: string };

export interface PreconditionResult {
  precondition: Precondition;
  ok: boolean;
  actual?: unknown;
  message?: string;
}

export interface UpstreamRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Redacted, model-visible body. Adapters must not put credentials here. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MutationPlan<K extends MutationKind = MutationKind> {
  kind: K;
  /** One-line human summary, e.g. "Create order PO-1001 for ACME at LAX-1 with 3 lines (14 units)". */
  summary: string;
  scope: { customerId: string; customerName?: string; facilityId?: string; facilityName?: string };
  /** Normalized input after adapter validation. */
  input: MutationInputMap[K];
  /** Structured preview the operator can inspect before committing. */
  preview: Record<string, unknown>;
  warnings: string[];
  preconditions: Precondition[];
  /**
   * Natural key that makes the upstream write idempotent. For create_order this is
   * (customerId, referenceNum) because 3PL Warehouse Manager rejects duplicate
   * reference numbers per customer. The engine asks the adapter to look this up
   * before executing, so a retried commit never double-creates.
   */
  naturalKey?: { type: string; value: string };
  upstream: UpstreamRequest[];
  risk: 'low' | 'medium' | 'high';
  /** Whether the upstream operation is safe to repeat (e.g. cancel of a cancelled order). */
  upstreamIdempotent: boolean;
}

export interface MutationOutcome {
  /** Identifier of the affected resource in the upstream system. */
  resourceType: 'order' | 'receipt';
  resourceId: string;
  referenceNum?: string;
  status?: string;
  version?: string;
  /** How the outcome came about; 'found_existing' means the effect was already upstream. */
  via: 'executed' | 'found_existing';
  detail?: Record<string, unknown>;
}

export type ChangeStatus = 'prepared' | 'committing' | 'committed' | 'discarded' | 'expired' | 'failed' | 'outcome_unknown';

export interface ChangeRecord {
  id: string;
  kind: MutationKind;
  status: ChangeStatus;
  /** sha256 of kind + normalized input; used to dedupe prepares. */
  fingerprint: string;
  idempotencyKey?: string;
  plan: MutationPlan;
  /** Environment the plan was prepared against; commits refuse to cross environments. */
  target: { system: string; baseUrl: string; environmentLabel: string };
  createdAt: string;
  expiresAt: string;
  committedAt?: string;
  outcome?: MutationOutcome;
  error?: { code: string; message: string };
  /** Number of commit attempts, including replays that returned the stored outcome. */
  commitAttempts: number;
  requestedBy?: string;
}
