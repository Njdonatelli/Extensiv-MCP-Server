#!/usr/bin/env node
import { createLogger, redact, CORE_ENV_KEYS } from '@mcp-3pl/core';
import { EXTENSIV_ENV_KEYS } from '@mcp-3pl/adapter-extensiv';
import { buildServer, loadConfigs, sharedStateFor } from './build.js';
import { runHttp, runStdio } from './transports.js';

const args = new Set(process.argv.slice(2));

function usage(): string {
  return [
    'extensiv-mcp — MCP server for Extensiv 3PL Warehouse Manager',
    '',
    'Usage: extensiv-mcp [--check | --print-config | --help]',
    '',
    '  (no flags)      start the server on the configured transport (default stdio)',
    '  --check         authenticate, list reachable customers/facilities, print JSON, exit 0/1',
    '  --print-config  print the effective configuration with secrets redacted',
    '',
    'Environment variables:',
    ...Object.values(EXTENSIV_ENV_KEYS).map((k) => `  ${k}`),
    ...Object.values(CORE_ENV_KEYS).map((k) => `  ${k}`),
    '',
    'Point at the local mock with EXTENSIV_BASE_URL=http://127.0.0.1:4010 (one value); everything else stays the same.',
  ].join('\n');
}

if (args.has('--help') || args.has('-h')) {
  process.stdout.write(usage() + '\n');
  process.exit(0);
}

if (args.has('--print-config')) {
  const { coreConfig, extensivConfig } = loadConfigs();
  process.stdout.write(JSON.stringify(redact({ core: coreConfig, extensiv: extensivConfig }), null, 2) + '\n');
  process.exit(0);
}

// One set of stores for the whole process: every HTTP session must see the same
// prepared changes, audit log and event file, or a change prepared in one session
// would be unknown to the next.
const { coreConfig } = loadConfigs();
const shared = sharedStateFor(coreConfig);
const built = buildServer({ shared });
const logger = createLogger(built.coreConfig.logLevel, { component: 'extensiv-mcp-cli' });

if (args.has('--check')) {
  const status = await built.ctx.adapter.verifyConnection();
  const out = { ...status, policy: built.ctx.policy.describe(), registeredTools: built.registeredTools };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  await built.close();
  process.exit(status.ok ? 0 : 1);
}

if (built.coreConfig.transport === 'http') {
  const running = await runHttp(() => buildServer({ shared, adapter: built.ctx.adapter }), { host: built.coreConfig.httpHost, port: built.coreConfig.httpPort, logger });
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await runStdio(built, logger);
}
