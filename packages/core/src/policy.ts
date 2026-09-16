import { WmsError } from './errors.js';
import type { CoreConfig } from './config.js';

/**
 * Scope and write policy. Every read that names a customer or facility goes
 * through assertRead*; every mutation goes through assertWrite at prepare AND
 * again at commit, so a change prepared under one configuration cannot be
 * committed under a narrower one.
 */
export class ScopePolicy {
  readonly writesEnabled: boolean;
  private readonly allowedCustomers: Set<string>;
  private readonly allowedFacilities: Set<string>;
  private readonly writeCustomers: Set<string>;
  private readonly writeFacilities: Set<string>;

  constructor(cfg: Pick<CoreConfig, 'writesEnabled' | 'allowedCustomerIds' | 'allowedFacilityIds' | 'writeCustomerIds' | 'writeFacilityIds'>) {
    this.writesEnabled = cfg.writesEnabled;
    this.allowedCustomers = new Set(cfg.allowedCustomerIds.map(String));
    this.allowedFacilities = new Set(cfg.allowedFacilityIds.map(String));
    this.writeCustomers = new Set(cfg.writeCustomerIds.map(String));
    this.writeFacilities = new Set(cfg.writeFacilityIds.map(String));
  }

  describe(): {
    writesEnabled: boolean;
    readCustomerIds: string[] | 'all';
    readFacilityIds: string[] | 'all';
    writeCustomerIds: string[];
    writeFacilityIds: string[] | 'any-of-writable-customer';
  } {
    return {
      writesEnabled: this.writesEnabled,
      readCustomerIds: this.allowedCustomers.size ? [...this.allowedCustomers] : 'all',
      readFacilityIds: this.allowedFacilities.size ? [...this.allowedFacilities] : 'all',
      writeCustomerIds: [...this.writeCustomers],
      writeFacilityIds: this.writeFacilities.size ? [...this.writeFacilities] : 'any-of-writable-customer',
    };
  }

  canReadCustomer(customerId: string): boolean {
    return this.allowedCustomers.size === 0 || this.allowedCustomers.has(String(customerId));
  }

  canReadFacility(facilityId: string): boolean {
    return this.allowedFacilities.size === 0 || this.allowedFacilities.has(String(facilityId));
  }

  assertReadCustomer(customerId: string | undefined): void {
    if (customerId === undefined) return;
    if (!this.canReadCustomer(customerId)) {
      throw new WmsError('SCOPE_DENIED', `Customer ${customerId} is outside this server's read scope.`, {
        hint: 'Use describe_scope to list the customers this server is allowed to read.',
        details: { customerId },
      });
    }
  }

  assertReadFacility(facilityId: string | undefined): void {
    if (facilityId === undefined) return;
    if (!this.canReadFacility(facilityId)) {
      throw new WmsError('SCOPE_DENIED', `Facility ${facilityId} is outside this server's read scope.`, {
        hint: 'Use describe_scope to list the facilities this server is allowed to read.',
        details: { facilityId },
      });
    }
  }

  /** Filters a list to readable customers. Used when the credential can see more than the policy allows. */
  filterCustomers<T extends { id: string }>(customers: T[]): T[] {
    return customers.filter((c) => this.canReadCustomer(c.id));
  }

  filterFacilities<T extends { id: string }>(facilities: T[]): T[] {
    return facilities.filter((f) => this.canReadFacility(f.id));
  }

  /** The customer filter to push into upstream queries when the caller did not name one. */
  readCustomerFilter(): string[] | undefined {
    return this.allowedCustomers.size ? [...this.allowedCustomers] : undefined;
  }

  canWrite(customerId: string, facilityId?: string): boolean {
    if (!this.writesEnabled) return false;
    if (!this.writeCustomers.has(String(customerId))) return false;
    if (facilityId !== undefined && this.writeFacilities.size > 0 && !this.writeFacilities.has(String(facilityId))) return false;
    return true;
  }

  assertWrite(scope: { customerId: string; facilityId?: string }, action: string): void {
    if (!this.writesEnabled) {
      throw new WmsError('WRITES_DISABLED', `Write tools are disabled on this server; refusing to ${action}.`, {
        hint: 'An operator must start the server with EXTENSIV_MCP_WRITES_ENABLED=true and an explicit EXTENSIV_MCP_WRITE_CUSTOMER_IDS list.',
      });
    }
    if (!this.writeCustomers.has(String(scope.customerId))) {
      throw new WmsError('SCOPE_DENIED', `Customer ${scope.customerId} is outside this server's write scope; refusing to ${action}.`, {
        hint: 'describe_scope lists writable customers. Writes to other customers require an operator to change EXTENSIV_MCP_WRITE_CUSTOMER_IDS.',
        details: { customerId: scope.customerId, writableCustomerIds: [...this.writeCustomers] },
      });
    }
    if (scope.facilityId !== undefined && this.writeFacilities.size > 0 && !this.writeFacilities.has(String(scope.facilityId))) {
      throw new WmsError('SCOPE_DENIED', `Facility ${scope.facilityId} is outside this server's write scope; refusing to ${action}.`, {
        details: { facilityId: scope.facilityId, writableFacilityIds: [...this.writeFacilities] },
      });
    }
    // Read scope is a superset of write scope by construction: whatever you may write you
    // may read. Without the facility half of this check, a narrow read allow-list could be
    // paired with an empty write-facility list and writes would land in a warehouse the
    // same server refuses to show you.
    if (!this.canReadCustomer(scope.customerId)) {
      throw new WmsError('SCOPE_DENIED', `Customer ${scope.customerId} is writable but not readable; configuration is inconsistent.`, {
        hint: 'Add the customer to EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS or clear that variable.',
      });
    }
    if (scope.facilityId !== undefined && !this.canReadFacility(scope.facilityId)) {
      throw new WmsError('SCOPE_DENIED', `Facility ${scope.facilityId} is outside this server's read scope, so it may not be written either; refusing to ${action}.`, {
        hint: 'Add the facility to EXTENSIV_MCP_ALLOWED_FACILITY_IDS, or clear that variable, or name a facility this server can read.',
        details: { facilityId: scope.facilityId },
      });
    }
  }
}
