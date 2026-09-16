import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WmsEvent } from '../domain.js';

export interface EventQuery {
  limit?: number;
  since?: string;
  eventTypes?: string[];
  customerId?: string;
  referenceNum?: string;
}

/**
 * Shared between the webhook-ingest process (writer) and the MCP server
 * (reader). JSONL keeps the two processes decoupled: the writer appends, the
 * reader re-scans the tail on each query. Dedupe is by event id.
 */
export interface EventStore {
  append(event: WmsEvent): Promise<{ inserted: boolean }>;
  query(q?: EventQuery): Promise<WmsEvent[]>;
  count(): Promise<number>;
}

export class MemoryEventStore implements EventStore {
  protected readonly events: WmsEvent[] = [];
  protected readonly ids = new Set<string>();

  async append(event: WmsEvent): Promise<{ inserted: boolean }> {
    if (this.ids.has(event.id)) return { inserted: false };
    this.ids.add(event.id);
    this.events.push(structuredClone(event));
    return { inserted: true };
  }

  async query(q: EventQuery = {}): Promise<WmsEvent[]> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    let out = this.events;
    if (q.since) out = out.filter((e) => e.occurredAt >= q.since!);
    if (q.eventTypes?.length) {
      const wanted = new Set(q.eventTypes.map((t) => t.toLowerCase()));
      out = out.filter((e) => wanted.has(e.eventType.toLowerCase()));
    }
    if (q.customerId) out = out.filter((e) => e.customerId === q.customerId);
    if (q.referenceNum) out = out.filter((e) => e.referenceNum === q.referenceNum);
    return [...out].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
  }

  async count(): Promise<number> {
    return this.events.length;
  }
}

export class JsonlEventStore extends MemoryEventStore {
  private bytesRead = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    super();
  }

  /** Incrementally ingest lines appended since the last scan. */
  private async refresh(): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.file, 'r');
      const stat = await handle.stat();
      if (stat.size < this.bytesRead) {
        // File was truncated or replaced: rebuild.
        this.events.length = 0;
        this.ids.clear();
        this.bytesRead = 0;
      }
      if (stat.size === this.bytesRead) return;
      const buf = Buffer.alloc(stat.size - this.bytesRead);
      await handle.read(buf, 0, buf.length, this.bytesRead);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return; // partial line; wait for the writer to finish it
      const complete = text.slice(0, lastNewline + 1);
      this.bytesRead += Buffer.byteLength(complete, 'utf8');
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as WmsEvent;
          if (!this.ids.has(ev.id)) {
            this.ids.add(ev.id);
            this.events.push(ev);
          }
        } catch {
          // skip torn line
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    } finally {
      await handle?.close();
    }
  }

  override async append(event: WmsEvent): Promise<{ inserted: boolean }> {
    await this.refresh();
    if (this.ids.has(event.id)) return { inserted: false };
    const line = JSON.stringify(event) + '\n';
    // Durability before memory: if the id were recorded first and the append then
    // failed, the delivery would be lost from disk while the sender's retry came
    // back as a duplicate and was acknowledged. Claim the id only once it is on disk.
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, line, 'utf8');
      this.bytesRead += Buffer.byteLength(line, 'utf8');
    });
    // One failed write must not leave a rejected promise as the queue tail, or every
    // later append would fail with the first error and never run.
    this.queue = write.catch(() => undefined);
    await write;
    this.ids.add(event.id);
    this.events.push(structuredClone(event));
    return { inserted: true };
  }

  override async query(q: EventQuery = {}): Promise<WmsEvent[]> {
    await this.refresh();
    return super.query(q);
  }

  override async count(): Promise<number> {
    await this.refresh();
    return super.count();
  }
}
