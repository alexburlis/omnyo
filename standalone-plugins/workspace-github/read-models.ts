import { z } from "zod";

const failureMessage = z
  .unknown()
  .transform((error) => (error instanceof Error ? error.message : String(error))).parse;

type Snapshot<Value> = {
  value: Value | null;
  error: string | null;
  refreshing: boolean;
};

type Entry<Value> = {
  snapshot: Snapshot<Value>;
  listeners: Set<() => void>;
  load: (() => Promise<Value>) | null;
  pending: Promise<void> | null;
  revision: number;
  dirty: boolean;
  scheduled: boolean;
  bytes: number;
  valueBytes: number;
  freshUntil: number;
};

export class ReadModels<Value> {
  private entries = new Map<string, Entry<Value>>();

  constructor(
    private maxEntries = 32,
    private maxBytes = 4 * 1024 * 1024,
    private freshForMs = 0,
  ) {}

  private entry(key: string): Entry<Value> {
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        snapshot: { value: null, error: null, refreshing: false },
        listeners: new Set(),
        load: null,
        pending: null,
        revision: 0,
        dirty: false,
        scheduled: false,
        bytes: 0,
        valueBytes: 0,
        freshUntil: 0,
      };
      this.entries.set(key, entry);
    }

    return entry;
  }

  getSnapshot(key: string): Snapshot<Value> {
    return this.entry(key).snapshot;
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    this.entries.delete(key);
    this.entries.set(key, entry);

    return () => {
      entry.listeners.delete(listener);

      if (entry.listeners.size === 0) entry.load = null;
      this.trim();
    };
  }

  private emit(entry: Entry<Value>, snapshot: Snapshot<Value>): void {
    entry.snapshot = snapshot;

    for (const listener of entry.listeners) listener();
  }

  refresh(key: string, load: () => Promise<Value>): Promise<void> {
    const entry = this.entry(key);
    entry.load = load;

    if (entry.pending) return entry.pending;

    if (
      !entry.dirty &&
      entry.snapshot.value !== null &&
      entry.snapshot.error === null &&
      Date.now() < entry.freshUntil
    )
      return Promise.resolve();
    const revision = entry.revision;
    entry.dirty = false;
    entry.bytes = entry.valueBytes;
    this.emit(entry, { ...entry.snapshot, error: null, refreshing: true });

    const pending = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (revision !== entry.revision) return;
          entry.freshUntil = Date.now() + this.freshForMs;
          entry.valueBytes = JSON.stringify(value).length * 2;
          entry.bytes = entry.valueBytes;
          this.emit(entry, { value, error: null, refreshing: false });
        },
        (error) => {
          if (revision !== entry.revision) return;

          const message = failureMessage(error);

          entry.bytes = entry.valueBytes + message.length * 2;
          this.emit(entry, {
            ...entry.snapshot,
            error: message,
            refreshing: false,
          });
        },
      )
      .finally(() => {
        entry.pending = null;

        if (entry.dirty) this.schedule(key, entry);
        else if (entry.snapshot.refreshing)
          this.emit(entry, { ...entry.snapshot, refreshing: false });
        this.trim();
      });

    entry.pending = pending;

    return pending;
  }

  invalidate(key?: string): void {
    const entries = key === undefined ? this.entries : new Map([[key, this.entry(key)]]);

    for (const [id, entry] of entries) {
      entry.revision++;
      entry.dirty = true;
      this.schedule(id, entry);
    }
  }

  private schedule(key: string, entry: Entry<Value>): void {
    if (entry.scheduled) return;
    entry.scheduled = true;
    queueMicrotask(() => {
      entry.scheduled = false;

      if (entry.dirty && !entry.pending && entry.listeners.size > 0 && entry.load)
        void this.refresh(key, entry.load);
    });
  }

  private trim(): void {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);

    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;

      if (entry.listeners.size > 0 || entry.pending) continue;
      bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
}
