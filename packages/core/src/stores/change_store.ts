import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangeRecord } from '../mutation.js';

/**
 * Persistence for two-phase change records. The engine relies on `put` being
 * atomic per record and on `get` reflecting the latest write, including across
 * process restarts (a commit replayed after a crash must find the stored outcome).
 */
export interface ChangeStore {
  get(id: string): Promise<ChangeRecord | undefined>;
  findByFingerprint(fingerprint: string): Promise<ChangeRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<ChangeRecord | undefined>;
  put(record: ChangeRecord): Promise<void>;
  list(filter?: { status?: ChangeRecord['status'][] }): Promise<ChangeRecord[]>;
}

export class MemoryChangeStore implements ChangeStore {
  protected readonly records = new Map<string, ChangeRecord>();

  async get(id: string): Promise<ChangeRecord | undefined> {
    return this.records.get(id);
  }

  async findByFingerprint(fingerprint: string): Promise<ChangeRecord | undefined> {
    return [...this.records.values()].find((r) => r.fingerprint === fingerprint && (r.status === 'prepared' || r.status === 'committed' || r.status === 'committing'));
  }

  async findByIdempotencyKey(key: string): Promise<ChangeRecord | undefined> {
    return [...this.records.values()].find((r) => r.idempotencyKey === key);
  }

  async put(record: ChangeRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async list(filter?: { status?: ChangeRecord['status'][] }): Promise<ChangeRecord[]> {
    const all = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return filter?.status ? all.filter((r) => filter.status!.includes(r.status)) : all;
  }
}

/**
 * Append-only JSONL log; the last line for an id wins. Loaded lazily, written
 * through a serialised queue so concurrent puts cannot interleave partial lines.
 */
export class JsonlChangeStore extends MemoryChangeStore {
  private queue: Promise<void> = Promise.resolve();
  private bytesRead = 0;
  private reading: Promise<void> | undefined;

  constructor(private readonly file: string) {
    super();
  }

  /**
   * Re-reads whatever has been appended since the last call, so a second reader of
   * the same file (another MCP session, or a second server process) sees changes
   * prepared elsewhere instead of reporting CHANGE_UNKNOWN. Reading the whole file
   * once at startup would make this store wrong the moment anyone else appends.
   */
  private async load(): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = (async () => {
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(this.file, 'r');
        const stat = await handle.stat();
        if (stat.size < this.bytesRead) {
          // Truncated or replaced underneath us: rebuild rather than read garbage.
          this.records.clear();
          this.bytesRead = 0;
        }
        if (stat.size === this.bytesRead) return;
        const buf = Buffer.alloc(stat.size - this.bytesRead);
        await handle.read(buf, 0, buf.length, this.bytesRead);
        const text = buf.toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline < 0) return; // a partial line; wait for the writer to finish it
        const complete = text.slice(0, lastNewline + 1);
        this.bytesRead += Buffer.byteLength(complete, 'utf8');
        for (const line of complete.split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as ChangeRecord;
            this.records.set(rec.id, rec);
          } catch {
            // A torn line from a crash mid-write is expected; everything before it is intact.
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      } finally {
        await handle?.close();
        this.reading = undefined;
      }
    })();
    return this.reading;
  }

  override async get(id: string): Promise<ChangeRecord | undefined> {
    await this.load();
    return super.get(id);
  }

  override async findByFingerprint(fingerprint: string): Promise<ChangeRecord | undefined> {
    await this.load();
    return super.findByFingerprint(fingerprint);
  }

  override async findByIdempotencyKey(key: string): Promise<ChangeRecord | undefined> {
    await this.load();
    return super.findByIdempotencyKey(key);
  }

  override async put(record: ChangeRecord): Promise<void> {
    await this.load();
    await super.put(record);
    const line = JSON.stringify(record) + '\n';
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, line, 'utf8');
      // Deliberately NOT advancing bytesRead: with a second writer on this file the offset
      // our line landed at is unknown. load() rediscovers it; last write for an id wins.
    });
    // A rejected tail would make every later put() fail with the first error.
    this.queue = write.catch(() => undefined);
    return write;
  }

  override async list(filter?: { status?: ChangeRecord['status'][] }): Promise<ChangeRecord[]> {
    await this.load();
    return super.list(filter);
  }
}
