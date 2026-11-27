export interface Model<Value> {
  value: Value | null;
  error: string | null;
}

interface Entry<Value> {
  model: Model<Value>;
  bytes: number;
  dirty: boolean;
  version: number;
  pending: Promise<void> | null;
  listeners: Set<() => void>;
}

export class ModelCache<Value> {
  private readonly entries = new Map<string, Entry<Value>>();
  private readonly limit = 16;
  private readonly byteLimit = 4 * 1024 * 1024;

  constructor(
    private readonly error: string,
    private readonly retention: "inactive" | "subscribed" = "inactive",
  ) {}

  private entry(key: string): Entry<Value> {
    let entry = this.entries.get(key);

    if (entry === undefined) {
      entry = {
        model: { value: null, error: null },
        bytes: 0,
        dirty: true,
        version: 0,
        pending: null,
        listeners: new Set(),
      };
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry;
  }

  private prune(): void {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);

    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit && bytes <= this.byteLimit) break;

      if (entry.listeners.size > 0) continue;
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }

  private write(entry: Entry<Value>, value: Value | null, error: string | null): void {
    if (entry.model.value === value && entry.model.error === error) {
      this.prune();

      return;
    }

    entry.model = { value, error };
    entry.bytes = value === null ? 0 : JSON.stringify(value).length * 2;

    for (const listener of entry.listeners) listener();
    this.prune();
  }

  read(key: string): Model<Value> {
    return this.entry(key).model;
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    this.prune();

    return () => {
      entry.listeners.delete(listener);

      if (entry.listeners.size === 0) {
        if (this.retention === "subscribed") this.entries.delete(key);
        else entry.dirty = true;
      }

      this.prune();
    };
  }

  accept(key: string, value: Value | null): void {
    const entry = this.entry(key);
    entry.version += 1;
    entry.dirty = false;
    this.write(entry, value, null);
  }

  load(key: string, read: () => Promise<Value | null>, force = false): void {
    const entry = this.entry(key);

    if (force) {
      entry.version += 1;
      entry.dirty = true;
    }

    if (!entry.dirty || entry.pending !== null) return;

    entry.pending = Promise.resolve()
      .then(async () => {
        do {
          const version = entry.version;
          entry.dirty = false;

          try {
            const value = await read();

            if (version === entry.version && this.entries.get(key) === entry)
              this.write(entry, value, null);
          } catch {
            if (version === entry.version && this.entries.get(key) === entry)
              this.write(entry, entry.model.value, this.error);
          }
        } while (entry.dirty && entry.listeners.size > 0 && this.entries.get(key) === entry);
      })
      .finally(() => {
        entry.pending = null;

        if (entry.dirty && entry.listeners.size > 0 && this.entries.get(key) === entry)
          this.load(key, read);
        this.prune();
      });
  }
}
