export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const SECRET_KEY = /secret|password|token|authorization|client_secret|access_token/i;

/** Recursively masks values whose key looks like a credential. Applied to every log line. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '<redacted>' : redact(v, depth + 1);
  }
  return out as T;
}

/**
 * Structured JSON logger writing to stderr. stdout is reserved for the MCP stdio
 * transport, so nothing in this package may ever write to stdout.
 */
export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] > threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...(meta ? redact(meta) : {}) };
    sink(JSON.stringify(line));
  };
  return {
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    child: (b) => createLogger(level, { ...bindings, ...b }, sink),
  };
}

export const silentLogger: Logger = createLogger('silent');
