import { createLogger, createWmsMcpServer, loadCoreConfig, type CoreConfig, type Logger, type WmsMcpServer, JsonlAuditLog, JsonlChangeStore, JsonlEventStore } from '@mcp-3pl/core';
import { createExtensivAdapter, loadExtensivConfig, type ExtensivConfig } from '@mcp-3pl/adapter-extensiv';
import path from 'node:path';

export interface BuiltServer extends WmsMcpServer {
  coreConfig: CoreConfig;
  extensivConfig: ExtensivConfig;
}

export interface SharedState {
  changeStore: JsonlChangeStore;
  eventStore: JsonlEventStore;
  audit: JsonlAuditLog;
}

export function loadConfigs(env: Record<string, string | undefined> = process.env): { coreConfig: CoreConfig; extensivConfig: ExtensivConfig } {
  const coreConfig = loadCoreConfig(env);
  const extensivConfig = loadExtensivConfig(env);
  return { coreConfig, extensivConfig };
}

export function sharedStateFor(coreConfig: CoreConfig): SharedState {
  const stateDir = path.resolve(coreConfig.stateDir);
  return {
    changeStore: new JsonlChangeStore(path.join(stateDir, 'changes.jsonl')),
    eventStore: new JsonlEventStore(coreConfig.eventsFile ? path.resolve(coreConfig.eventsFile) : path.join(stateDir, 'events.jsonl')),
    audit: new JsonlAuditLog(coreConfig.auditFile ? path.resolve(coreConfig.auditFile) : path.join(stateDir, 'audit.jsonl')),
  };
}

/**
 * Wires the Extensiv adapter into the core server. Everything Extensiv-specific
 * enters through the adapter; swapping the WMS means swapping this one import.
 */
export function buildServer(opts: { env?: Record<string, string | undefined>; logger?: Logger; shared?: SharedState; adapter?: ReturnType<typeof createExtensivAdapter> } = {}): BuiltServer {
  const { coreConfig, extensivConfig } = loadConfigs(opts.env ?? process.env);
  const logger = opts.logger ?? createLogger(coreConfig.logLevel, { component: 'extensiv-mcp' });
  const adapter = opts.adapter ?? createExtensivAdapter(extensivConfig, { logger: logger.child({ component: 'extensiv-adapter' }) });
  const shared = opts.shared ?? sharedStateFor(coreConfig);
  const built = createWmsMcpServer({ adapter, config: coreConfig, logger, name: 'extensiv-3pl-mcp', version: '0.1.0', ...shared });
  return { ...built, coreConfig, extensivConfig };
}
