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
  private loaded: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  private async load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        let text = '';
        try {
          text = await fs.readFile(this.file, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as ChangeRecord;
            this.records.set(rec.id, rec);
          } catch {
            // A torn final line from a crash mid-write is expected; everything before it is intact.
          }
        }
      })();
    }
    return this.loaded;
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
    this.queue = this.queue.then(() => fs.appendFile(this.file, line, 'utf8'));
    return this.queue;
  }

  override async list(filter?: { status?: ChangeRecord['status'][] }): Promise<ChangeRecord[]> {
    await this.load();
    return super.list(filter);
  }
}
