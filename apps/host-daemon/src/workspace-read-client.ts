import type { HostWatcher, CatalogCacheScope } from "@omnyo/host-watcher";
import { CatalogWatchOwner } from "./catalog-watch-owner.js";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  killPortableProcess,
  killProcessGroup,
  sanitizeInheritedChildProcessEnv,
  supportsProcessGroups,
} from "@omnyo/process-utils";
import {
  createProvisionedWorkspace,
  WorkspaceError,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@omnyo/host-workspace";
import {
  parseHostDaemonOnlineRpcResultForCommand,
  type HostDaemonOnlineRpcResult,
  type HostDaemonOnlineRpcResultForCommand,
} from "@omnyo/host-daemon-contract";
import type { CommandOf } from "./command-dispatch-support.js";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
} from "./command-errors.js";
import type { LocalInjectedSkillSource } from "./injected-skills.js";
import {
  directoryReplacementResultSchema,
  workspaceReadResponseSchema,
  type WorkspaceReadRequest,
  type WorkspaceReadResponse,
  type LocalSkillCollection,
  type ReadonlyFilesystemCommand,
  type FilesystemMutationCommand,
} from "./workspace-read-protocol.js";

type Metadata = HostDaemonOnlineRpcResult<"host.list_command_metadata">;

type ReadRequest = Extract<
  WorkspaceReadRequest,
  {
    kind:
      | "metadata"
      | "provision"
      | "context"
      | "collect-local"
      | "rpc"
      | "mutate"
      | "access";
  }
>;

type ReadResponse = Extract<
  WorkspaceReadResponse,
  {
    kind:
      | "metadata"
      | "provision"
      | "context"
      | "collect-local"
      | "rpc"
      | "mutate"
      | "access";
  }
>;

interface PendingRead {
  resolve: (result: ReadResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  removeAbortListener: () => void;
}

const STARTUP_TIMEOUT_MS = 30_000;

const REQUEST_TIMEOUT_MS = 30_000;

const IDLE_TIMEOUT_MS = 60_000;

const STOP_TIMEOUT_MS = 1_000;

function abandonChild(child: ChildProcess): void {
  if (supportsProcessGroups()) killProcessGroup({ child, signal: "SIGKILL" });
  else killPortableProcess(child, "SIGKILL");

  if (child.connected) child.disconnect();
  child.stderr?.destroy();
  child.unref();
}

function entryPath(): string {
  const candidates = [
    "./omnyo-workspace-read-child.mjs",
    "./workspace-read-child.js",
    "./workspace-read-child.ts",
  ];

  for (const candidate of candidates) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url));

    if (existsSync(resolved)) return resolved;
  }

  throw new Error("Workspace read child entry is missing");
}

class WorkspaceReadProcess {
  private child: ChildProcess | null = null;
  private ready = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, PendingRead>();
  private readonly unsent = new Map<number, ReadRequest>();
  private nextId = 0;
  private stopped = false;
  private draining = false;
  private timedOut = false;

  constructor(
    private readonly onChange: () => void = () => undefined,
    private readonly options: {
      mutating?: boolean;
    } = {},
  ) {}

  request(
    input:
      | Omit<Extract<ReadRequest, { kind: "metadata" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "provision" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "context" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "collect-local" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "rpc" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "access" }>, "id">
      | Omit<Extract<ReadRequest, { kind: "mutate" }>, "id">,
    signal?: AbortSignal,
  ): Promise<ReadResponse> {
    if (this.stopped)
      return Promise.reject(new Error("Workspace reader stopped"));

    if (signal?.aborted) {
      return Promise.reject(
        new WorkspaceError(
          "provision_cancelled",
          "Workspace provisioning was cancelled",
        ),
      );
    }

    const id = this.nextId++;
    const request: ReadRequest = { ...input, id };

    return new Promise((resolve, reject) => {
      const timer =
        request.kind === "mutate"
          ? null
          : setTimeout(() => {
              const error = new Error(
                `Workspace ${request.kind} read timed out`,
              );

              if (
                request.kind !== "rpc" ||
                request.command.type !== "host.read_file_chunk" ||
                this.pending.size <= 1
              ) {
                this.fail(error);

                return;
              }

              this.timedOut = true;
              this.unsent.delete(id);
              this.pending.get(id)?.removeAbortListener();
              this.pending.delete(id);
              reject(error);
            }, REQUEST_TIMEOUT_MS);

      timer?.unref();

      const onAbort = () => {
        this.fail(
          new WorkspaceError(
            "provision_cancelled",
            "Workspace provisioning was cancelled",
          ),
        );
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        removeAbortListener: () =>
          signal?.removeEventListener("abort", onAbort),
      });
      this.unsent.set(id, request);

      try {
        this.ensureChild();
        this.flush();

        if (signal?.aborted) onAbort();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  invalidate(): void {
    this.send({ kind: "invalidate" });
  }

  isStopped(): boolean {
    return this.stopped;
  }

  startIdle(): void {
    this.ensureChild();
    this.setReferenced(false);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  canReadChunk(): boolean {
    return (
      !this.stopped &&
      !this.timedOut &&
      this.pending.size < MAX_SHARED_CHUNK_READS
    );
  }

  isReusable(): boolean {
    return (
      !this.stopped &&
      !this.timedOut &&
      this.ready &&
      this.child?.connected === true &&
      this.pending.size === 0
    );
  }

  setReferenced(referenced: boolean): void {
    const child = this.child;

    if (child === null) return;

    const stderr = child.stderr instanceof Socket ? child.stderr : null;

    for (const handle of [child, child.channel, stderr]) {
      if (referenced) handle?.ref();
      else handle?.unref();
    }
  }

  async dispose(): Promise<void> {
    if (this.options.mutating) {
      this.stopped = true;
      this.draining = true;

      if (this.ready) this.send({ kind: "shutdown" });
      this.child?.unref();
      this.child?.channel?.unref();
      this.child?.stderr?.destroy();

      return;
    }

    if (this.stopped && this.child === null) return;
    this.stopped = true;
    this.rejectPending(new Error("Workspace reader stopped"));
    const child = this.child;
    this.child = null;
    this.ready = false;

    if (child === null) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abandonChild(child);
        resolve();
      }, STOP_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timer);

        if (supportsProcessGroups())
          killProcessGroup({ child, signal: "SIGKILL" });
        resolve();
      });

      try {
        if (child.connected) child.send({ kind: "shutdown" });
        else abandonChild(child);
      } catch {
        abandonChild(child);
      }
    });
  }

  private ensureChild(): void {
    if (this.child !== null) return;
    const entry = entryPath();

    const child = fork(entry, [], {
      detached: supportsProcessGroups(),
      env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      execArgv: entry.endsWith(".ts")
        ? ["--conditions=source", "--import", import.meta.resolve("tsx")]
        : [],
      ...(this.options.mutating ? {} : { serialization: "advanced" }),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    this.child = child;
    child.stderr?.resume();
    this.startupTimer = setTimeout(() => {
      this.fail(new Error("Workspace reader did not become ready"));
    }, STARTUP_TIMEOUT_MS);
    this.startupTimer.unref();
    child.on("message", (message: unknown) => {
      if (this.child !== child) return;
      const parsed = workspaceReadResponseSchema.safeParse(message);

      if (!parsed.success) {
        this.fail(new Error("Workspace reader returned an invalid response"));

        return;
      }

      const response = parsed.data;

      switch (response.kind) {
        case "ready":
          this.ready = true;

          if (this.startupTimer !== null) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.flush();

          if (this.draining) this.send({ kind: "shutdown" });

          return;
        case "changed":
          this.onChange();

          return;
        case "metadata":
        case "provision":
        case "context":
        case "collect-local":
        case "rpc":
        case "mutate":
        case "access":
        case "error": {
          const pending = this.pending.get(response.id);

          if (pending === undefined) return;
          this.pending.delete(response.id);

          if (pending.timer !== null) clearTimeout(pending.timer);
          pending.removeAbortListener();

          if (response.kind === "error") {
            pending.reject(
              response.expected
                ? new ExpectedCommandDispatchError(
                    response.code,
                    response.message,
                  )
                : new CommandDispatchError(response.code, response.message),
            );
          } else {
            pending.resolve(response);
          }
        }
      }
    });
    child.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.on("disconnect", () => {
      if (this.child === child && this.pending.size > 0)
        this.fail(new Error("Workspace reader disconnected"));
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        if (this.draining && this.pending.size === 0) {
          this.child = null;
          this.ready = false;

          return;
        }

        this.fail(new Error(`Workspace reader exited (${signal ?? code})`));
      }
    });
  }

  private flush(): void {
    if (!this.ready) return;

    for (const [id, request] of this.unsent) {
      this.unsent.delete(id);
      this.send(request);
    }
  }

  private send(message: WorkspaceReadRequest): void {
    const child = this.child;

    if (child === null || !child.connected) return;

    try {
      child.send(message, (error) => {
        if (error && this.child === child) this.fail(error);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.stopped = true;
    this.rejectPending(
      error,
      this.options.mutating
        ? new CommandDispatchError(
            "mutation_outcome_unknown",
            `Filesystem mutation connection failed; confirm its outcome before retrying: ${error.message}`,
          )
        : error,
    );
    const child = this.child;
    this.child = null;
    this.ready = false;

    if (child !== null) {
      if (this.options.mutating) {
        if (child.connected) child.disconnect();
        child.stderr?.destroy();
        child.unref();
      } else abandonChild(child);
    }

    this.onChange();
  }

  private rejectPending(unsentError: Error, sentError = unsentError): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;

    for (const [id, pending] of this.pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(this.unsent.has(id) ? unsentError : sentError);
    }

    this.pending.clear();
    this.unsent.clear();
  }
}

interface MetadataReader {
  process: WorkspaceReadProcess;
  active: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class IsolatedCommandMetadataCatalog {
  private readonly readers = new Map<string, MetadataReader>();
  private readonly pending = new Map<
    string,
    { scope: CatalogCacheScope; result: Promise<Metadata> }
  >();
  private disposed = false;

  private readonly watches: CatalogWatchOwner;

  constructor(
    onChange: (scopes: CatalogCacheScope[]) => void,
    watcher: HostWatcher,
  ) {
    this.watches = new CatalogWatchOwner(
      watcher,
      ({ cwd }) => {
        const key = cwd === null ? "" : path.resolve(cwd);
        this.readers.get(key)?.process.invalidate();
      },
      onChange,
    );
  }

  invalidate(): void {
    for (const reader of this.readers.values()) reader.process.invalidate();
  }

  async list(
    command: CommandOf<"host.list_command_metadata">,
  ): Promise<Metadata> {
    if (this.disposed) throw new Error("Command metadata catalog is disposed");
    const requestKey = JSON.stringify(command);
    const existing = this.pending.get(requestKey);

    if (existing) return existing.result;
    const pending = this.read(command);
    this.pending.set(requestKey, {
      scope: { cwd: command.cwd, providerId: command.providerId },
      result: pending,
    });

    try {
      return await pending;
    } finally {
      if (this.pending.get(requestKey)?.result === pending)
        this.pending.delete(requestKey);
    }
  }

  retain(scopes: readonly CatalogCacheScope[]): Promise<void> {
    for (const [key, { scope }] of this.pending) {
      if (
        !scopes.some(
          (s) => s.cwd === scope.cwd && s.providerId === scope.providerId,
        )
      )
        this.pending.delete(key);
    }

    return this.watches.retain(scopes);
  }

  private async read(
    command: CommandOf<"host.list_command_metadata">,
  ): Promise<Metadata> {
    const key = command.cwd === null ? "" : path.resolve(command.cwd);
    let reader = this.readers.get(key);

    if (reader === undefined || reader.process.isStopped()) {
      reader = {
        process: new WorkspaceReadProcess(),
        active: 0,
        idleTimer: null,
      };
      this.readers.set(key, reader);
    }

    if (reader.idleTimer !== null) clearTimeout(reader.idleTimer);
    reader.idleTimer = null;
    reader.active += 1;

    try {
      const process = reader.process;

      return await this.watches.read(
        { cwd: command.cwd, providerId: command.providerId },
        async () => {
          const response = await process.request({ kind: "metadata", command });

          if (response.kind !== "metadata")
            throw new Error("Workspace reader returned the wrong result");

          return response;
        },
      );
    } finally {
      reader.active -= 1;

      if (reader.active === 0 && this.readers.get(key) === reader) {
        const idle = reader;
        idle.idleTimer = setTimeout(() => {
          if (this.readers.get(key) !== idle) return;
          this.readers.delete(key);
          void idle.process.dispose();
        }, IDLE_TIMEOUT_MS);
        idle.idleTimer.unref();
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const readers = [...this.readers.values()];
    this.readers.clear();

    await Promise.all([
      this.watches.dispose(),
      ...readers.map(async (reader) => {
        if (reader.idleTimer !== null) clearTimeout(reader.idleTimer);
        await reader.process.dispose();
      }),
    ]);
  }
}

export async function provisionIsolatedWorkspace(
  options: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  const reader = new WorkspaceReadProcess();

  try {
    const response = await reader.request(
      {
        kind: "provision",
        path: options.path,
        ...(options.shellPath !== undefined
          ? { shellPath: options.shellPath }
          : {}),
      },
      options.signal,
    );

    if (response.kind !== "provision")
      throw new Error("Workspace reader returned the wrong result");

    return createProvisionedWorkspace(response.result, options);
  } finally {
    await reader.dispose();
  }
}

export async function readIsolatedWorkspaceAgentContext(
  command: CommandOf<"host.read_workspace_agent_context">,
): Promise<HostDaemonOnlineRpcResult<"host.read_workspace_agent_context">> {
  const reader = new WorkspaceReadProcess();

  try {
    const response = await reader.request({ kind: "context", command });

    if (response.kind !== "context")
      throw new Error("Workspace reader returned the wrong result");

    return response.result;
  } finally {
    await reader.dispose();
  }
}

export async function collectIsolatedLocalSkillSource(
  source: LocalInjectedSkillSource,
): Promise<LocalSkillCollection> {
  const reader = new WorkspaceReadProcess();

  try {
    const response = await reader.request({ kind: "collect-local", source });

    if (response.kind !== "collect-local")
      throw new Error("Workspace reader returned the wrong result");

    return response.result;
  } finally {
    await reader.dispose();
  }
}

interface IdleReader {
  process: WorkspaceReadProcess;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_SHARED_CHUNK_READS = 16;

class FilesystemReaderPool {
  private readonly idle: IdleReader[] = [];

  private standby: WorkspaceReadProcess | null = null;
  private readonly chunkReaders = new Set<WorkspaceReadProcess>();

  constructor(private readonly idleLimit: number) {}

  start(): void {
    if (this.standby && !this.standby.isStopped()) return;
    this.standby = new WorkspaceReadProcess();
    this.standby.startIdle();
  }

  async runChunk<T>(
    perform: (reader: WorkspaceReadProcess) => Promise<T>,
  ): Promise<T> {
    if (this.standby?.isStopped()) this.start();
    let reader = this.standby?.canReadChunk() ? this.standby : undefined;

    if (!reader) {
      for (const active of this.chunkReaders) {
        if (active.canReadChunk()) {
          reader = active;
          break;
        }
      }
    }

    reader ??= this.acquire();
    reader.setReferenced(true);
    this.chunkReaders.add(reader);

    try {
      return await perform(reader);
    } finally {
      if (reader.pendingCount === 0 && this.chunkReaders.delete(reader)) {
        if (reader === this.standby && reader.isReusable())
          reader.setReferenced(false);
        else this.release(reader);
      }
    }
  }

  async run<T>(
    perform: (reader: WorkspaceReadProcess) => Promise<T>,
  ): Promise<T> {
    const reader = this.acquire();

    try {
      return await perform(reader);
    } finally {
      this.release(reader);
    }
  }

  async drain(): Promise<void> {
    const readers = this.idle.splice(0);
    const chunkReaders = new Set(this.chunkReaders);
    this.chunkReaders.clear();

    if (this.standby) chunkReaders.add(this.standby);
    this.standby = null;

    await Promise.all([
      ...Array.from(chunkReaders, (reader) => reader.dispose()),
      ...readers.map(({ process, timer }) => {
        clearTimeout(timer);

        return process.dispose();
      }),
    ]);
  }

  private acquire(): WorkspaceReadProcess {
    for (let entry = this.idle.pop(); entry; entry = this.idle.pop()) {
      clearTimeout(entry.timer);

      if (entry.process.isReusable()) {
        entry.process.setReferenced(true);

        return entry.process;
      }

      void entry.process.dispose();
    }

    return new WorkspaceReadProcess();
  }

  private release(reader: WorkspaceReadProcess): void {
    if (!reader.isReusable() || this.idle.length >= this.idleLimit) {
      void reader.dispose();

      return;
    }

    reader.setReferenced(false);

    const entry: IdleReader = {
      process: reader,
      timer: setTimeout(() => {
        const index = this.idle.indexOf(entry);

        if (index === -1) return;

        this.idle.splice(index, 1);
        void reader.dispose();
      }, IDLE_TIMEOUT_MS),
    };

    entry.timer.unref();
    this.idle.push(entry);
  }
}

const READER_POOL_IDLE_LIMIT = 4;

const filesystemReaders = new FilesystemReaderPool(READER_POOL_IDLE_LIMIT);

export function startFileChunkReader(): void {
  filesystemReaders.start();
}

export function drainIsolatedFilesystemReaders(): Promise<void> {
  return filesystemReaders.drain();
}

export function readIsolatedFilesystemCommand<
  TCommand extends ReadonlyFilesystemCommand,
>(
  command: TCommand,
  options: { shellPath?: string; signal?: AbortSignal } = {},
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
  const perform = async (reader: WorkspaceReadProcess) => {
    const response = await reader.request(
      {
        kind: "rpc",
        command,
        ...(options.shellPath === undefined
          ? {}
          : { shellPath: options.shellPath }),
      },
      options.signal,
    );

    if (response.kind !== "rpc")
      throw new Error("Workspace reader returned the wrong result");

    return parseHostDaemonOnlineRpcResultForCommand(command, response.result);
  };

  if (command.type !== "host.read_file_chunk" || options.signal !== undefined)
    return filesystemReaders.run(perform);

  return filesystemReaders.runChunk(perform);
}

export function canAccessIsolatedPath(
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return filesystemReaders.run(async (reader) => {
    const response = await reader.request({ kind: "access", path }, signal);

    if (response.kind !== "access")
      throw new Error("Workspace reader returned the wrong result");

    return response.accessible;
  });
}

interface GitReader {
  process: WorkspaceReadProcess;
  active: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function mutatingReader(): WorkspaceReadProcess {
  return new WorkspaceReadProcess(() => undefined, { mutating: true });
}

export class IsolatedFilesystemMutator {
  private reader = mutatingReader();
  private readonly gitReaders = new Map<string, GitReader>();
  private stopped = false;

  constructor(private readonly options: { dataDir: string }) {}

  private async mutate(
    command: FilesystemMutationCommand,
    options: { shellPath?: string },
  ): Promise<unknown> {
    if (this.stopped)
      throw new ExpectedCommandDispatchError(
        "filesystem_mutator_stopped",
        "Filesystem mutator is stopped",
      );

    const key =
      command.type === "host.inspect_git_source" ||
      command.type === "host.list_branch_options"
        ? path.resolve(command.path)
        : null;

    let gitReader = key === null ? undefined : this.gitReaders.get(key);

    if (key !== null) {
      if (gitReader === undefined || gitReader.process.isStopped()) {
        if (gitReader?.idleTimer) clearTimeout(gitReader.idleTimer);
        gitReader = {
          process: mutatingReader(),
          active: 0,
          idleTimer: null,
        };
        this.gitReaders.set(key, gitReader);
      }

      if (gitReader.idleTimer !== null) clearTimeout(gitReader.idleTimer);
      gitReader.idleTimer = null;
      gitReader.active += 1;
    }

    if (gitReader === undefined && this.reader.isStopped())
      this.reader = mutatingReader();

    try {
      const response = await (gitReader?.process ?? this.reader).request({
        kind: "mutate",
        command,
        dataDir: this.options.dataDir,
        ...options,
      });

      if (response.kind !== "mutate")
        throw new Error("Filesystem mutator returned the wrong result");

      return response.result;
    } finally {
      if (gitReader !== undefined && key !== null) {
        gitReader.active -= 1;

        if (
          gitReader.active === 0 &&
          !this.stopped &&
          this.gitReaders.get(key) === gitReader
        ) {
          const idle = gitReader;
          idle.idleTimer = setTimeout(() => {
            if (this.gitReaders.get(key) !== idle) return;
            this.gitReaders.delete(key);
            idle.idleTimer = null;
            void idle.process.dispose();
          }, IDLE_TIMEOUT_MS);
          idle.idleTimer.unref();
        }
      }
    }
  }

  async execute<
    TCommand extends Exclude<
      FilesystemMutationCommand,
      { type: "skill.replace_directory" }
    >,
  >(
    command: TCommand,
    options: { shellPath?: string } = {},
  ): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>> {
    return parseHostDaemonOnlineRpcResultForCommand(
      command,
      await this.mutate(command, options),
    );
  }

  async replaceDirectory(
    args: Omit<
      Extract<FilesystemMutationCommand, { type: "skill.replace_directory" }>,
      "type"
    >,
  ): Promise<void> {
    directoryReplacementResultSchema.parse(
      await this.mutate({ type: "skill.replace_directory", ...args }, {}),
    );
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    const readers = [...this.gitReaders.values()];
    this.gitReaders.clear();

    for (const reader of readers) {
      if (reader.idleTimer !== null) clearTimeout(reader.idleTimer);
      reader.idleTimer = null;
    }

    await Promise.all(
      [this.reader, ...readers.map((reader) => reader.process)].map((reader) =>
        reader.dispose(),
      ),
    );
  }
}
