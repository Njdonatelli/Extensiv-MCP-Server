import { describe, expect, it } from 'vitest';
import { loadCoreConfig } from '../config.js';
import { ScopePolicy } from '../policy.js';

describe('ScopePolicy', () => {
  it('reads everything and writes nothing by default', () => {
    const p = new ScopePolicy(loadCoreConfig({}));
    expect(p.writesEnabled).toBe(false);
    expect(p.canReadCustomer('42')).toBe(true);
    expect(p.canWrite('42')).toBe(false);
    expect(() => p.assertWrite({ customerId: '42' }, 'create order')).toThrowError(/disabled/);
  });

  it('refuses writes enabled without an explicit write customer list', () => {
    expect(() => loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'true' })).toThrowError(/EXTENSIV_MCP_WRITE_CUSTOMER_IDS/);
  });

  it('limits writes to the allowlist even when reads are open', () => {
    const p = new ScopePolicy(loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'true', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1, 2' }));
    expect(p.canWrite('1')).toBe(true);
    expect(p.canWrite('9')).toBe(false);
    expect(() => p.assertWrite({ customerId: '9' }, 'cancel order')).toThrowError(/outside this server's write scope/);
    expect(p.canReadCustomer('9')).toBe(true);
  });

  it('applies facility write limits only when configured', () => {
    const p = new ScopePolicy(loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: '1', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '1', EXTENSIV_MCP_WRITE_FACILITY_IDS: '2' }));
    expect(p.canWrite('1', '2')).toBe(true);
    expect(p.canWrite('1', '1')).toBe(false);
    expect(p.canWrite('1')).toBe(true);
  });

  it('restricts reads when an allowlist is set and filters lists', () => {
    const p = new ScopePolicy(loadCoreConfig({ EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' }));
    expect(() => p.assertReadCustomer('9')).toThrowError(/read scope/);
    expect(p.filterCustomers([{ id: '1' }, { id: '9' }])).toEqual([{ id: '1' }]);
    expect(p.readCustomerFilter()).toEqual(['1']);
  });

  it('rejects a writable customer that is not readable', () => {
    const p = new ScopePolicy(loadCoreConfig({ EXTENSIV_MCP_WRITES_ENABLED: 'yes', EXTENSIV_MCP_WRITE_CUSTOMER_IDS: '2', EXTENSIV_MCP_ALLOWED_CUSTOMER_IDS: '1' }));
    expect(() => p.assertWrite({ customerId: '2' }, 'x')).toThrowError(/not readable/);
  });
});
