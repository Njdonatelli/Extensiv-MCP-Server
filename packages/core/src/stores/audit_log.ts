import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  at: string;
  kind: 'tool_call' | 'prepare' | 'commit' | 'discard' | 'policy_refusal';
  tool?: string;
  changeId?: string;
  outcome: 'ok' | 'error' | 'refused' | 'replayed';
  durationMs?: number;
  /** Redacted, size-capped summary of the input; never raw secrets. */
  input?: unknown;
  detail?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export class NoopAuditLog implements AuditLog {
  async record(): Promise<void> {}
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class JsonlAuditLog implements AuditLog {
  private queue: Promise<void> = Promise.resolve();
  /** Number of entries that could not be written, for health reporting. */
  failedWrites = 0;

  constructor(
    private readonly file: string,
    private readonly onError?: (err: unknown, entry: AuditEntry) => void,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, line, 'utf8');
    });
    // Keep the tail resolved: a rejected tail would make every later record() fail
    // with the first error, silently disabling the audit log for the process.
    this.queue = write.catch(() => undefined);
    try {
      await write;
    } catch (err) {
      this.failedWrites += 1;
      this.onError?.(err, entry);
      throw err;
    }
  }
}
