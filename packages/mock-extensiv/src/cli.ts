#!/usr/bin/env node
/** Stand-alone mock server. Configured entirely through environment variables. */
import { startMockServer } from './index.js';

const port = Number(process.env.MOCK_EXTENSIV_PORT ?? '4010');
const host = process.env.MOCK_EXTENSIV_HOST ?? '127.0.0.1';
const seedKind = process.env.MOCK_EXTENSIV_SEED === 'empty' ? 'empty' : 'default';

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write(`MOCK_EXTENSIV_PORT must be a port number, got "${process.env.MOCK_EXTENSIV_PORT}"\n`);
  process.exit(1);
}

const server = await startMockServer({ port, host, seed: seedKind, log: process.env.MOCK_EXTENSIV_LOG === '1' });
process.stdout.write(`Mock Extensiv API listening on http://${host}:${server.port}\n`);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\nReceived ${signal}, shutting down\n`);
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
