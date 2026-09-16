/**
 * The contract a warehouse-system adapter implements. The core owns policy,
 * two-phase mutations, tool shapes and transports; the adapter owns auth, wire
 * formats, query translation and the mapping to the domain model.
 */
import type {
  ConnectionStatus,
  Customer,
  Facility,
  InventoryPosition,
  InventoryQuery,
  Item,
  ItemQuery,
  OrderDetail,
  OrderQuery,
  OrderSummary,
  Page,
  ReceiptDetail,
  ReceiptQuery,
  ReceiptSummary,
} from './domain.js';
import type { MutationInputMap, MutationKind, MutationOutcome, MutationPlan, PreconditionResult } from './mutation.js';

export interface AdapterInfo {
  /** Stable machine name, e.g. "extensiv-3pl-warehouse-manager". */
  system: string;
  /** Human label, e.g. "Extensiv 3PL Warehouse Manager". */
  displayName: string;
  baseUrl: string;
  /** "production" | "sandbox" | "mock" | free text; surfaced to the model on every write preview. */
  environmentLabel: string;
  /**
   * Opaque, non-secret identifier for the tenant/credential this adapter speaks for.
   * Two tenants of the same vendor share a base URL and differ only by credentials, so
   * without this a change prepared for one could be committed against the other.
   */
  tenantKey?: string;
  version?: string;
}

export interface OrderRef {
  id?: string;
  referenceNum?: string;
  customerId?: string;
}

export interface ReceiptRef {
  id?: string;
  referenceNum?: string;
  customerId?: string;
}

export interface WmsAdapter {
  readonly info: AdapterInfo;

  verifyConnection(): Promise<ConnectionStatus>;

  listCustomers(): Promise<Customer[]>;
  listFacilities(): Promise<Facility[]>;

  findOrders(query: OrderQuery): Promise<Page<OrderSummary>>;
  getOrder(ref: OrderRef): Promise<OrderDetail | null>;

  findReceipts(query: ReceiptQuery): Promise<Page<ReceiptSummary>>;
  getReceipt(ref: ReceiptRef): Promise<ReceiptDetail | null>;

  getInventory(query: InventoryQuery): Promise<InventoryPosition[]>;
  findItems(query: ItemQuery): Promise<Item[]>;

  /** Validate and preview; must not write. Throws WmsError('VALIDATION' | 'NOT_FOUND' | ...) on bad input. */
  planMutation<K extends MutationKind>(kind: K, input: MutationInputMap[K]): Promise<MutationPlan<K>>;
  /** Re-evaluate every precondition against fresh upstream state. */
  checkPreconditions(plan: MutationPlan): Promise<PreconditionResult[]>;
  /** Look up the plan's natural key upstream; return the outcome if the effect already exists. */
  findApplied(plan: MutationPlan): Promise<MutationOutcome | null>;
  /** Perform the write exactly once. May throw WmsError('OUTCOME_UNKNOWN') if the response was lost. */
  executeMutation(plan: MutationPlan): Promise<MutationOutcome>;

  /** Release sockets/timers. */
  close?(): Promise<void>;
}
