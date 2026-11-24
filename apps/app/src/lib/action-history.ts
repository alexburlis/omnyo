export interface HistoryEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface ActionOutcome<T> {
  current: T | null | undefined;
  settled: Promise<T | null>;
}

export function trackActionOutcome<T>(promise: Promise<T>): ActionOutcome<T> {
  const outcome: ActionOutcome<T> = {
    current: undefined,
    settled: promise.then(
      (value) => {
        outcome.current = value;

        return value;
      },
      () => {
        outcome.current = null;

        return null;
      },
    ),
  };

  return outcome;
}

type ActionHistoryStatus = "idle" | "replaying";

export type HistoryDirection = "undo" | "redo";

const HISTORY_LIMIT = 100;

export class ActionHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private status: ActionHistoryStatus = "idle";
  private invokingReplay = false;
  private recordRevision = 0;
  private textEditRevision = 0;
  private appActionRevision: number | null = null;
  private listeners = new Set<() => void>();
  private forgotten = new WeakSet<HistoryEntry>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;

    for (const listener of this.listeners) listener();
  }

  get keyboardRevision(): number {
    return this.textEditRevision;
  }

  get hasKeyboardPriority(): boolean {
    return this.appActionRevision === this.textEditRevision;
  }

  yieldToTextEditing(): void {
    this.textEditRevision += 1;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peek(direction: HistoryDirection): HistoryEntry | null {
    return (
      (direction === "undo" ? this.undoStack : this.redoStack).at(-1) ?? null
    );
  }

  record(entry: HistoryEntry, keyboardRevision = this.keyboardRevision): void {
    if (this.invokingReplay) return;
    this.recordRevision += 1;
    this.undoStack = [...this.undoStack, entry].slice(-HISTORY_LIMIT);
    this.redoStack = [];
    this.appActionRevision = keyboardRevision;
    this.changed();
  }

  forget(entry: HistoryEntry): void {
    this.forgotten.add(entry);
    const undoStack = this.undoStack.filter((candidate) => candidate !== entry);
    const redoStack = this.redoStack.filter((candidate) => candidate !== entry);

    if (
      undoStack.length === this.undoStack.length &&
      redoStack.length === this.redoStack.length
    )
      return;
    this.undoStack = undoStack;
    this.redoStack = redoStack;
    this.changed();
  }

  undo(): Promise<HistoryEntry | null> {
    const entry = this.undoStack.at(-1);

    if (entry === undefined) return Promise.resolve(null);

    return this.replay(entry, "undo");
  }

  redo(): Promise<HistoryEntry | null> {
    const entry = this.redoStack.at(-1);

    if (entry === undefined) return Promise.resolve(null);

    return this.replay(entry, "redo");
  }

  undoEntry(entry: HistoryEntry): Promise<HistoryEntry | null> {
    if (!this.undoStack.includes(entry)) return Promise.resolve(null);

    return this.replay(entry, "undo");
  }

  private async replay(
    entry: HistoryEntry,
    direction: HistoryDirection,
  ): Promise<HistoryEntry | null> {
    if (this.status === "replaying") return null;

    const [source, target] =
      direction === "undo"
        ? (["undoStack", "redoStack"] as const)
        : (["redoStack", "undoStack"] as const);

    this[source] = this[source].filter((candidate) => candidate !== entry);
    this.status = "replaying";
    this.appActionRevision = this.keyboardRevision;
    this.changed();

    const recordRevision = this.recordRevision;
    const targetLength = this[target].length;

    try {
      this.invokingReplay = true;
      let replaying: Promise<void>;

      try {
        replaying = entry[direction]();
      } finally {
        this.invokingReplay = false;
      }

      await replaying;

      if (this.forgotten.has(entry)) return null;

      if (this.recordRevision === recordRevision)
        this[target] = [...this[target], entry].slice(-HISTORY_LIMIT);
      else if (direction === "redo")
        this.undoStack = [
          ...this.undoStack.slice(0, targetLength),
          entry,
          ...this.undoStack.slice(targetLength),
        ].slice(-HISTORY_LIMIT);

      return entry;
    } finally {
      this.status = "idle";
      this.changed();
    }
  }
}
