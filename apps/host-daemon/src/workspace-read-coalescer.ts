import path from "node:path";

export const WORKSPACE_READ_HOST_CONCURRENCY = 4;

export const WORKSPACE_READ_PATH_CONCURRENCY = 2;

const WORKSPACE_READ_FRESHNESS_PER_RUN_MS = 2;

const WORKSPACE_READ_MAX_FRESHNESS_MS = 30_000;

export interface WorkspaceReadRequest<T> {
  environmentId: string;
  workspacePath: string;
  key: string;
  load: () => Promise<unknown>;
  parse: (value: unknown) => T;
}

export interface WorkspaceReadCoalescerOptions {
  now: () => number;
  environmentPath: (environmentId: string) => string | undefined;
  realpath: (workspacePath: string) => Promise<string>;
}

interface SettledRead {
  value: unknown;
  generation: number;
  expiresAt: number;
}

interface ReadEntry {
  workspacePath: string;
  settled: SettledRead | null;
  runs: Set<ReadRun>;
}

class ReadRun {
  generation: number | null = null;
  readonly promise: Promise<unknown>;

  constructor(execute: (run: ReadRun) => Promise<unknown>) {
    this.promise = execute(this);
  }
}

class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly capacity: number) {}

  get idle(): boolean {
    return this.active === 0;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.capacity) this.active += 1;
    else await new Promise<void>((grant) => this.waiting.push(grant));

    let released = false;

    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();

      if (next === undefined) this.active -= 1;
      else next();
    };
  }
}

function freshnessMs(durationMs: number): number {
  return Math.min(
    WORKSPACE_READ_MAX_FRESHNESS_MS,
    Math.max(0, durationMs) * WORKSPACE_READ_FRESHNESS_PER_RUN_MS,
  );
}

export function workspaceReadKey(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : nested,
  );
}

export class WorkspaceReadCoalescer {
  private readonly entries = new Map<string, ReadEntry>();
  private readonly environmentPaths = new Map<string, string>();
  private readonly canonicalPaths = new Map<string, string>();
  private readonly pendingInvalidations = new Set<Promise<void>>();
  private readonly pathGenerations = new Map<string, number>();
  private readonly pathSlots = new Map<string, Slots>();
  private readonly hostSlots = new Slots(WORKSPACE_READ_HOST_CONCURRENCY);
  private allGeneration = 0;
  private lastGeneration = 0;

  constructor(private readonly options: WorkspaceReadCoalescerOptions) {}

  async read<T>(request: WorkspaceReadRequest<T>): Promise<T> {
    const requestedPath = path.resolve(request.workspacePath);
    this.environmentPaths.set(request.environmentId, requestedPath);

    const [workspacePath] = await Promise.all([
      this.canonicalPath(requestedPath),
      Promise.all(this.pendingInvalidations),
    ]);

    this.prune();

    const entryKey = `${workspacePath}\u0000${request.key}`;
    let entry = this.entries.get(entryKey);

    if (entry === undefined) {
      entry = { workspacePath, settled: null, runs: new Set() };
      this.entries.set(entryKey, entry);
    }

    const generation = this.generationOf(workspacePath);
    const settled = entry.settled;

    if (
      settled !== null &&
      settled.generation === generation &&
      settled.expiresAt > this.options.now()
    ) {
      return request.parse(settled.value);
    }

    let run = [...entry.runs].find(
      (candidate) =>
        candidate.generation === null || candidate.generation === generation,
    );

    if (run === undefined) {
      const target = entry;
      run = new ReadRun((created) => this.execute(target, created, request));
      entry.runs.add(run);
    }

    return request.parse(await run.promise);
  }

  trackEnvironment(environmentId: string, workspacePath: string): void {
    this.environmentPaths.set(environmentId, path.resolve(workspacePath));
  }

  invalidateEnvironment(environmentId: string): void {
    const workspacePath =
      this.environmentPaths.get(environmentId) ??
      this.options.environmentPath(environmentId);

    if (workspacePath === undefined) this.invalidateAll();
    else this.invalidateWorkspace(workspacePath);
  }

  invalidateWorkspace(workspacePath: string): void {
    const requestedPath = path.resolve(workspacePath);
    const known = this.canonicalPaths.get(requestedPath);

    if (known !== undefined) {
      this.advancePath(known);

      return;
    }

    const pending: Promise<void> = this.canonicalPath(requestedPath)
      .then(
        (canonical) => this.advancePath(canonical),
        () => this.invalidateAll(),
      )
      .finally(() => this.pendingInvalidations.delete(pending));

    this.pendingInvalidations.add(pending);
  }

  invalidateAll(): void {
    this.lastGeneration += 1;
    this.allGeneration = this.lastGeneration;
  }

  private async canonicalPath(requestedPath: string): Promise<string> {
    const canonical = await this.options.realpath(requestedPath);
    this.canonicalPaths.set(requestedPath, canonical);

    return canonical;
  }

  private advancePath(canonicalPath: string): void {
    this.lastGeneration += 1;
    this.pathGenerations.set(canonicalPath, this.lastGeneration);
  }

  private generationOf(workspacePath: string): number {
    return Math.max(
      this.pathGenerations.get(workspacePath) ?? 0,
      this.allGeneration,
    );
  }

  private slotsFor(workspacePath: string): Slots {
    let slots = this.pathSlots.get(workspacePath);

    if (slots === undefined) {
      slots = new Slots(WORKSPACE_READ_PATH_CONCURRENCY);
      this.pathSlots.set(workspacePath, slots);
    }

    return slots;
  }

  private async execute(
    entry: ReadEntry,
    run: ReadRun,
    request: Pick<WorkspaceReadRequest<unknown>, "load">,
  ): Promise<unknown> {
    const pathSlots = this.slotsFor(entry.workspacePath);
    const releasePath = await pathSlots.acquire();

    try {
      const releaseHost = await this.hostSlots.acquire();

      try {
        const generation = this.generationOf(entry.workspacePath);
        run.generation = generation;
        const startedAt = this.options.now();
        const value = await request.load();
        const finishedAt = this.options.now();

        if (
          generation === this.generationOf(entry.workspacePath) &&
          (entry.settled === null || entry.settled.generation <= generation)
        ) {
          entry.settled = {
            value,
            generation,
            expiresAt: finishedAt + freshnessMs(finishedAt - startedAt),
          };
        }

        return value;
      } finally {
        releaseHost();
      }
    } finally {
      releasePath();
      entry.runs.delete(run);

      if (
        pathSlots.idle &&
        this.pathSlots.get(entry.workspacePath) === pathSlots
      )
        this.pathSlots.delete(entry.workspacePath);
    }
  }

  private prune(): void {
    const now = this.options.now();

    for (const [key, entry] of this.entries) {
      if (
        entry.runs.size === 0 &&
        (entry.settled === null ||
          entry.settled.expiresAt <= now ||
          entry.settled.generation !== this.generationOf(entry.workspacePath))
      ) {
        this.entries.delete(key);
      }
    }
  }
}
