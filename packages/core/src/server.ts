import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WmsAdapter } from './adapter.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { CoreConfig } from './config.js';
import { MutationEngine } from './engine/mutation_engine.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import { ScopePolicy } from './policy.js';
import { JsonlAuditLog, type AuditLog } from './stores/audit_log.js';
import { JsonlChangeStore, type ChangeStore } from './stores/change_store.js';
import { JsonlEventStore, type EventStore } from './stores/event_store.js';
import { runTool, type ToolContext, type ToolDefinition } from './tools/define.js';
import { READ_TOOLS } from './tools/read_tools.js';
import { WRITE_TOOLS } from './tools/write_tools.js';
import path from 'node:path';

export interface CreateServerOptions {
  adapter: WmsAdapter;
  config: CoreConfig;
  name?: string;
  version?: string;
  logger?: Logger;
  clock?: Clock;
  changeStore?: ChangeStore;
  eventStore?: EventStore;
  audit?: AuditLog;
}

export interface WmsMcpServer {
  server: McpServer;
  ctx: ToolContext;
  /** Names of tools actually registered (write tools are absent when writes are disabled). */
  registeredTools: string[];
  close(): Promise<void>;
}

/**
 * Builds an MCP server from a core config and an adapter. Read tools are always
 * registered; write tools are registered only when the policy allows writes, so
 * a read-only server never advertises them in tools/list.
 */
export function createWmsMcpServer(opts: CreateServerOptions): WmsMcpServer {
  const { adapter, config } = opts;
  const logger = opts.logger ?? createLogger(config.logLevel, { component: 'mcp-server' });
  const clock = opts.clock ?? systemClock;
  const policy = new ScopePolicy(config);
  const stateDir = path.resolve(config.stateDir);
  const changeStore = opts.changeStore ?? new JsonlChangeStore(path.join(stateDir, 'changes.jsonl'));
  const eventStore = opts.eventStore ?? new JsonlEventStore(config.eventsFile ? path.resolve(config.eventsFile) : path.join(stateDir, 'events.jsonl'));
  const audit = opts.audit ?? new JsonlAuditLog(config.auditFile ? path.resolve(config.auditFile) : path.join(stateDir, 'audit.jsonl'));
  const engine = new MutationEngine({ adapter, store: changeStore, policy, config, audit, logger: logger.child({ component: 'mutation-engine' }), clock });
  const ctx: ToolContext = { adapter, policy, engine, events: eventStore, audit, config, logger, clock };

  const server = new McpServer(
    { name: opts.name ?? 'extensiv-3pl-mcp', version: opts.version ?? '0.1.0' },
    {
      instructions: buildInstructions(adapter, policy),
    },
  );

  const tools: ToolDefinition[] = [...READ_TOOLS, ...(policy.writesEnabled ? WRITE_TOOLS : [])] as ToolDefinition[];
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      async (args: unknown) => runTool(def, args, ctx),
    );
  }

  server.registerResource('scope-policy', 'wms://policy', { title: 'Scope and write policy', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ environment: adapter.info, policy: policy.describe() }, null, 2) }],
  }));
  server.registerResource('pending-changes', 'wms://changes/pending', { title: 'Pending prepared changes', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await engine.listPending(), null, 2) }],
  }));

  logger.info('server created', { system: adapter.info.system, baseUrl: adapter.info.baseUrl, environment: adapter.info.environmentLabel, writesEnabled: policy.writesEnabled, tools: tools.map((t) => t.name) });

  return {
    server,
    ctx,
    registeredTools: tools.map((t) => t.name),
    close: async () => {
      await server.close();
      await adapter.close?.();
    },
  };
}

function buildInstructions(adapter: WmsAdapter, policy: ScopePolicy): string {
  const lines = [
    `This server exposes ${adapter.info.displayName} (${adapter.info.environmentLabel}) to an assistant through task-shaped tools.`,
    'Start with verify_connection and describe_scope when unsure what the server can see.',
    'Read tools never change anything.',
  ];
  if (policy.writesEnabled) {
    lines.push(
      'Writes are two-phase: create_order / update_order / cancel_order / create_receipt only PREPARE and return a preview with a change_id; nothing is written until commit_change is called with that id after the operator approves. Commits are idempotent: repeating one returns the stored outcome.',
      `Writes are limited to customer ids ${policy.describe().writeCustomerIds.join(', ')}. Requests outside that scope are refused inside the tool; do not try to work around it.`,
    );
  } else {
    lines.push('This server is READ-ONLY: no write tools are registered. If asked to create, change or cancel anything, explain that writes are disabled and offer the read-only view instead.');
  }
  return lines.join('\n');
}
