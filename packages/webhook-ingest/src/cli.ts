#!/usr/bin/env node
import { loadIngestConfig } from './config.js';
import { startIngest } from './start.js';

const cfg = loadIngestConfig();
const running = await startIngest(cfg);
const stop = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
