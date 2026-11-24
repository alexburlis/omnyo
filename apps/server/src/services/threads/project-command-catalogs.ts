import type {
  CommandCatalogResponse,
  CommandListResponse,
  ProjectCommandsQuery,
} from "@omnyo/server-contract";
import type {
  HostDaemonDaemonWsMessage,
  HostDaemonServerWsMessage,
} from "@omnyo/host-daemon-contract";
import { getSessionById } from "@omnyo/db";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { resolveProjectCommandWorkspace } from "../projects/project-workspace.js";
import { resolveProviderNativeRootSet } from "../providers/native-roots.js";
import type { ProviderRegistration } from "../providers/provider-registry.js";
import {
  hostPathDirname,
  sharedSkillNativeRoots,
} from "../skills/shared-skills.js";
import {
  buildCommandListResponse,
  builtinProviderCommands,
  providerHasCommandSurface,
} from "./provider-command-typeahead.js";
import { workspaceProjectSkillReadPolicy } from "./workspace-agent-context.js";

type CatalogRequest = ProjectCommandsQuery & { projectId: string };

type CatalogDeps = Omit<AppDeps, "commandCatalogs">;

interface CatalogScope {
  key: string;
  baseKey: string;
  request: CatalogRequest;
  hostId: string;
  cwd: string | null;
  registration: ProviderRegistration;
}

interface CatalogEntry {
  scope: CatalogScope;
  snapshot: CommandCatalogResponse;
  bindingVersion: number;
  refreshRequested: boolean;
  bytes: number;
  pending: Promise<CommandListResponse> | null;
}

interface CatalogJob {
  entry: CatalogEntry;
  resolve: (response: CommandListResponse) => void;
  reject: (error: unknown) => void;
}

interface CatalogBinding {
  request: CatalogRequest;
  entry: CatalogEntry;
}

export const COMMAND_CATALOG_RECONCILE_MS = 120_000;

export class ProjectCommandCatalogs {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly bindings = new Map<string, CatalogBinding>();
  private readonly pending = new Set<Promise<CommandListResponse>>();
  private readonly queue: CatalogJob[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private running = 0;
  private bytes = 0;
  private disposed = false;

  constructor(private readonly deps: CatalogDeps) {
    this.unsubscribe = deps.hub.onChangedMessage((message) => {
      if (
        message.entity === "host" &&
        message.changes.includes("host-connected")
      ) {
        for (const hostId of message.id === undefined
          ? deps.hub.listConnectedHostIds()
          : [message.id])
          this.retainHostScopes(hostId);

        for (const entry of [...this.entries.values()]) {
          if (message.id === undefined || entry.scope.hostId === message.id)
            this.maintain(entry, "binding");
        }
      } else if (
        message.entity === "system" &&
        (message.changes.includes("provider-registrations-changed") ||
          message.changes.includes("plugins-changed"))
      ) {
        deps.providerNativeRoots.invalidate();
        this.invalidateProviders();
      } else if (
        message.entity === "environment" &&
        message.changes.some(
          (change) =>
            change === "environment-created" ||
            change === "environment-deleted" ||
            change === "metadata-changed" ||
            change === "status-changed",
        )
      ) {
        const entries = new Set(
          [...this.bindings.values()]
            .filter(
              (binding) =>
                message.id === undefined ||
                binding.request.environmentId === message.id,
            )
            .map((binding) => binding.entry),
        );

        for (const entry of entries) {
          this.maintain(entry, "rebind");
        }
      } else if (
        message.entity === "project" &&
        message.changes.some(
          (change) =>
            change === "project-sources-changed" ||
            change === "project-deleted" ||
            change === "project-updated",
        )
      ) {
        for (const entry of [...this.entries.values()]) {
          if (
            message.id === undefined ||
            entry.scope.request.projectId === message.id
          )
            this.maintain(entry, "rebind");
        }
      }
    });
    this.timer = setInterval(() => {
      for (const entry of [...this.entries.values()]) {
        this.maintain(entry);
      }
    }, COMMAND_CATALOG_RECONCILE_MS);
    this.timer.unref();
  }

  snapshot(request: CatalogRequest): CommandCatalogResponse {
    const entry = this.track(request);

    return entry?.snapshot ?? { state: "ready", commands: [] };
  }

  async complete(request: CatalogRequest): Promise<CommandListResponse> {
    const entry = this.track(request);

    if (entry === null) return { commands: [] };
    const response = await this.schedule(entry);

    if (this.scope(request)?.key !== entry.scope.key)
      throw new ApiError(
        409,
        "command_catalog_changed",
        "Command catalog changed during discovery",
      );

    return response;
  }

  invalidateHost(
    hostId: string,
    scopes?: Extract<
      HostDaemonDaemonWsMessage,
      { type: "command-catalog-change" }
    >["scopes"],
  ): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.scope.hostId !== hostId) continue;

      if (
        scopes !== undefined &&
        !scopes.some(
          (scope) =>
            scope.cwd === entry.scope.cwd &&
            scope.providerId === entry.scope.request.provider,
        )
      )
        continue;
      this.maintain(entry);
    }
  }

  invalidateProject(projectId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.scope.request.projectId === projectId) this.maintain(entry);
    }
  }

  invalidateProviders(): void {
    for (const entry of [...this.entries.values()])
      this.maintain(entry, "binding");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    clearInterval(this.timer);

    for (const entry of this.entries.values()) entry.bindingVersion++;
    await Promise.allSettled(this.pending);
    this.entries.clear();
    this.bindings.clear();
    this.bytes = 0;
  }

  private scope(request: CatalogRequest): CatalogScope | null {
    requirePublicProject(this.deps.db, request.projectId);
    const registration = this.deps.providerRegistry.get(request.provider);

    if (registration === null || !providerHasCommandSurface(registration))
      return null;
    const workspace = resolveProjectCommandWorkspace(this.deps, request);

    const baseKey = JSON.stringify([
      request.projectId,
      request.provider,
      workspace.hostId,
      workspace.cwd,
    ]);

    return {
      ...workspace,
      request,
      registration,
      baseKey,
      key: `${baseKey}:${this.deps.providerRegistry.getRegistrationRevision()}`,
    };
  }

  private defaults(scope: CatalogScope): CommandCatalogResponse {
    return {
      state: "preparing",
      commands: builtinProviderCommands(
        scope.registration.serverCapabilities.supportsManualCompaction,
      ),
    };
  }

  private bindingKey(request: CatalogRequest): string {
    return JSON.stringify([
      request.projectId,
      request.provider,
      request.environmentId ?? null,
      request.environmentId === undefined ? (request.hostId ?? null) : null,
    ]);
  }

  private forget(entry: CatalogEntry): void {
    if (this.entries.get(entry.scope.key) !== entry) return;
    this.entries.delete(entry.scope.key);
    this.bytes -= entry.bytes;
    entry.bindingVersion++;
    entry.refreshRequested = false;

    for (const [key, binding] of this.bindings)
      if (binding.entry === entry) this.bindings.delete(key);
    this.retainHostScopes(entry.scope.hostId);
  }

  private retainHostScopes(hostId: string): void {
    const sessionId = this.deps.hub.getDaemonSessionIdForHost(hostId);

    if (sessionId === null) return;
    const session = getSessionById(this.deps.db, { sessionId });

    if (session === null || session.protocolVersion < 261) return;

    const scopes: Extract<
      HostDaemonServerWsMessage,
      { type: "command-catalog-retain" }
    >["scopes"] = [];

    const seen = new Set<string>();

    for (const { scope } of this.entries.values()) {
      if (scope.hostId !== hostId) continue;
      const key = JSON.stringify([scope.cwd, scope.request.provider]);

      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ cwd: scope.cwd, providerId: scope.request.provider });
    }

    this.deps.hub.sendDaemonSessionMessage(sessionId, {
      type: "command-catalog-retain",
      scopes,
    });
  }

  private detachBinding(key: string, binding: CatalogBinding): void {
    this.bindings.delete(key);

    const remaining = [...this.bindings.values()].find(
      (candidate) => candidate.entry === binding.entry,
    );

    if (remaining) {
      binding.entry.scope = {
        ...binding.entry.scope,
        request: remaining.request,
      };
    } else {
      this.forget(binding.entry);
    }
  }

  private track(request: CatalogRequest): CatalogEntry | null {
    if (this.disposed)
      throw new ApiError(
        503,
        "command_catalog_closed",
        "Command catalog is unavailable",
      );
    const bindingKey = this.bindingKey(request);
    const previous = this.bindings.get(bindingKey);
    let scope: CatalogScope | null;

    try {
      scope = this.scope(request);
    } catch (error) {
      if (previous) this.detachBinding(bindingKey, previous);
      throw error;
    }

    if (scope === null) {
      if (previous) this.detachBinding(bindingKey, previous);

      return null;
    }

    while (!this.bindings.has(bindingKey) && this.bindings.size >= 32) {
      const oldest = this.bindings.entries().next().value;

      if (oldest === undefined) break;
      this.detachBinding(...oldest);
    }

    let entry =
      this.entries.get(scope.key) ??
      [...this.entries.values()].find(
        (candidate) => candidate.scope.baseKey === scope.baseKey,
      );

    if (previous && previous.entry !== entry)
      this.detachBinding(bindingKey, previous);
    let refresh = false;

    if (entry && entry.scope.key !== scope.key) {
      this.retarget(entry, scope);
      refresh = true;
    }

    if (!entry) {
      while (this.entries.size >= 32) this.evict();
      const snapshot = this.defaults(scope);
      entry = {
        scope,
        snapshot,
        bindingVersion: 0,
        refreshRequested: false,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
        pending: null,
      };
      this.entries.set(scope.key, entry);
      this.bytes += entry.bytes;
      refresh = true;
    }

    this.bindings.delete(bindingKey);
    this.bindings.set(bindingKey, { request, entry });
    this.entries.delete(entry.scope.key);
    this.entries.set(entry.scope.key, entry);

    if (refresh) this.schedule(entry);

    return entry;
  }

  private retarget(entry: CatalogEntry, scope: CatalogScope): void {
    if (entry.scope.key === scope.key) return;
    const previous = entry.scope;
    this.entries.delete(entry.scope.key);
    this.bytes -= entry.bytes;
    entry.scope = scope;
    entry.snapshot = this.defaults(scope);
    entry.bytes = Buffer.byteLength(JSON.stringify(entry.snapshot));
    entry.bindingVersion++;
    entry.refreshRequested = true;
    this.bytes += entry.bytes;
    this.entries.set(scope.key, entry);

    if (
      previous.hostId !== scope.hostId ||
      previous.cwd !== scope.cwd ||
      previous.request.provider !== scope.request.provider
    ) {
      this.retainHostScopes(previous.hostId);

      if (previous.hostId !== scope.hostId) this.retainHostScopes(scope.hostId);
    }
  }

  private rebind(entry: CatalogEntry): "current" | "changed" | "removed" {
    const before = entry.bindingVersion;

    const bindings = [...this.bindings.values()].filter(
      (binding) => binding.entry === entry,
    );

    for (const binding of bindings) {
      try {
        this.track(binding.request);
      } catch {
        this.deps.logger.warn(
          {
            projectId: binding.request.projectId,
            providerId: binding.request.provider,
          },
          "Command catalog binding is unavailable",
        );
        this.changed();
      }
    }

    if (this.entries.get(entry.scope.key) !== entry) return "removed";

    return entry.bindingVersion === before ? "current" : "changed";
  }

  private maintain(
    entry: CatalogEntry,
    reason: "source" | "binding" | "rebind" = "source",
  ): void {
    if (this.disposed || this.entries.get(entry.scope.key) !== entry) return;

    try {
      const binding = this.rebind(entry);

      if (
        binding === "removed" ||
        (reason === "rebind" && binding === "current")
      )
        return;

      if (reason === "binding" && binding === "current") entry.bindingVersion++;

      if (entry.pending) {
        entry.refreshRequested = true;

        return;
      }

      this.schedule(entry);
    } catch (error) {
      this.fail(entry, error);
    }
  }

  private schedule(entry: CatalogEntry): Promise<CommandListResponse> {
    if (entry.pending) return entry.pending;

    if (this.pending.size >= 64) {
      const error = new ApiError(
        503,
        "command_catalog_busy",
        "Command catalog is busy",
      );

      this.fail(entry, error);
      throw error;
    }

    const work = new Promise<CommandListResponse>((resolve, reject) => {
      this.queue.push({ entry, resolve, reject });
    });

    entry.pending = work;
    this.pending.add(work);

    const settled = () => {
      if (entry.pending === work) entry.pending = null;
      this.pending.delete(work);

      if (
        !this.disposed &&
        entry.refreshRequested &&
        this.entries.get(entry.scope.key) === entry
      ) {
        entry.refreshRequested = false;
        this.maintain(entry);
      }
    };

    void work.then(settled, settled);
    this.drain();

    return work;
  }

  private drain(): void {
    while (this.running < 2) {
      const job = this.queue.shift();

      if (!job) return;
      this.running++;
      void this.discover(job.entry)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }

  private async discover(entry: CatalogEntry): Promise<CommandListResponse> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.disposed || this.entries.get(entry.scope.key) !== entry)
          throw new ApiError(
            409,
            "command_catalog_changed",
            "Command catalog changed during discovery",
          );

        if (this.rebind(entry) === "removed")
          throw new ApiError(
            409,
            "command_catalog_changed",
            "Command catalog changed during discovery",
          );
        const bindingVersion = entry.bindingVersion;
        const scope = entry.scope;
        entry.refreshRequested = false;

        const { limit, maxFileBytes, excludeNames } =
          workspaceProjectSkillReadPolicy();

        const nativeRoots = await resolveProviderNativeRootSet(this.deps, {
          registration: scope.registration,
          hostId: scope.hostId,
          cwd: scope.cwd,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });

        if (this.disposed)
          throw new ApiError(
            503,
            "command_catalog_closed",
            "Command catalog is unavailable",
          );

        if (bindingVersion !== entry.bindingVersion) continue;

        const result = await callHostRetryableOnlineRpc(this.deps, {
          hostId: scope.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.list_command_metadata",
            projectSkillRead: { limit, maxFileBytes, excludeNames },
            providerId: scope.request.provider,
            cwd: scope.cwd,
            nativeRoots,
            sharedSkillRoots: sharedSkillNativeRoots(this.deps),
          },
        });

        if (this.disposed)
          throw new ApiError(
            503,
            "command_catalog_closed",
            "Command catalog is unavailable",
          );

        if (bindingVersion !== entry.bindingVersion) continue;

        const skillCatalog = await this.deps.commandMetadata.resolve({
          projectSources: result.projectSkills.map((skill) => ({
            ...skill,
            kind: "metadata",
            sourceType: "project",
          })),
          sharedSources: result.sharedSkills.flatMap((skill) =>
            skill.description !== null &&
            (skill.rootKind === "shared-project" ||
              skill.rootKind === "shared-user")
              ? [
                  {
                    kind: "metadata",
                    sourceType: skill.rootKind,
                    name: skill.name,
                    description: skill.description,
                    sourceRootPath: hostPathDirname(skill.filePath),
                  },
                ]
              : [],
          ),
        });

        if (this.disposed || this.entries.get(entry.scope.key) !== entry)
          throw new ApiError(
            409,
            "command_catalog_changed",
            "Command catalog changed during discovery",
          );

        if (bindingVersion !== entry.bindingVersion) continue;

        const binding = this.rebind(entry);

        if (binding === "removed")
          throw new ApiError(
            409,
            "command_catalog_changed",
            "Command catalog changed during discovery",
          );

        if (binding !== "current" || bindingVersion !== entry.bindingVersion)
          continue;

        const response = buildCommandListResponse({
          commands: result.commands,
          includeBuiltinCompact:
            scope.registration.serverCapabilities.supportsManualCompaction,
          skillCatalog,
        });

        const snapshot: CommandCatalogResponse = {
          ...response,
          state: "ready",
        };

        const bytes = Buffer.byteLength(JSON.stringify(snapshot));

        if (bytes > 16 * 1024 * 1024 - 32 * 1024)
          throw new ApiError(
            503,
            "command_catalog_budget",
            "Command catalog exceeds the metadata memory budget",
          );

        while (this.bytes - entry.bytes + bytes > 16 * 1024 * 1024 - 32 * 1024)
          this.evict(entry);
        this.bytes += bytes - entry.bytes;
        entry.bytes = bytes;

        const changed =
          JSON.stringify(entry.snapshot) !== JSON.stringify(snapshot);

        entry.snapshot = snapshot;

        if (changed) this.changed();

        return response;
      }

      throw new ApiError(
        409,
        "command_catalog_changed",
        "Command catalog changed during discovery",
      );
    } catch (error) {
      this.fail(entry, error);
      throw error;
    }
  }

  private evict(retain?: CatalogEntry): void {
    const candidate = [...this.entries.values()].find(
      (entry) => entry !== retain && entry.pending === null,
    );

    if (!candidate)
      throw new ApiError(
        503,
        "command_catalog_busy",
        "Command catalog is busy",
      );
    this.forget(candidate);
  }

  private fail(entry: CatalogEntry, error: unknown): void {
    if (this.disposed || this.entries.get(entry.scope.key) !== entry) return;

    const unavailable =
      error instanceof ApiError && error.body.code === "host_unavailable";

    const code = unavailable ? "host_unavailable" : "command_catalog_failed";

    const unchanged =
      entry.snapshot.state === "failed" && entry.snapshot.error.code === code;

    entry.snapshot = {
      state: "failed",
      commands: entry.snapshot.commands,
      error: {
        code,
        message: unavailable
          ? "Machine unavailable. Reconnect it to refresh commands."
          : "Failed to refresh commands",
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry.snapshot));
    this.bytes += bytes - entry.bytes;
    entry.bytes = bytes;
    this.deps.logger.warn(
      {
        projectId: entry.scope.request.projectId,
        providerId: entry.scope.request.provider,
        hostId: entry.scope.hostId,
        code: entry.snapshot.error.code,
      },
      "Command catalog refresh failed",
    );

    if (!unchanged) this.changed();
  }

  private changed(): void {
    this.deps.hub.notifySystem(["command-catalog-changed"]);
  }
}
