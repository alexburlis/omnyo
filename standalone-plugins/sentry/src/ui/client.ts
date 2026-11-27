import type { PluginRpcClient } from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import {
  builtinModelDefaults,
  statusSchema,
  rpcContract,
  type badgeSchema,
  type Route,
  type Run,
  type ProjectPolicy,
  type ProjectBatch,
  type ModelRole,
  type ModelSelection,
  type InboxStatus,
  type InboxQuery,
} from "../../contract";

import { operationKey } from "./operations";
import type { InboxTargets } from "./projection";

type Status = InboxStatus;

export type InboxCache = { read: () => string | null; write: (value: string) => void };

const cachedInbox = z.object({
  version: z.literal(1),
  status: statusSchema,
  targets: rpcContract.targets.output,
});

type Badge = z.infer<typeof badgeSchema>;

type Snapshot = {
  badge: Badge | null;
  badgeRefreshing: boolean;
  badgeError: string | null;
  status: Status | null;
  targets: InboxTargets;
  targetsLoaded: boolean;
  refreshing: boolean;
  pending: readonly string[];
  error: string | null;
  targetsError: string | null;
};

type Update = (status: Status) => Status;

const keep: Update = (value) => value;

const refreshFailure = "Sentry could not refresh. The last known inbox is retained.";

let nextClientId = 0;

export class InboxClient {
  readonly resourceId = ++nextClientId;
  private status: Status | null = null;
  private snapshot: Snapshot = {
    badge: null,
    badgeRefreshing: false,
    badgeError: null,
    status: null,
    targets: { projects: [], hosts: [] },
    targetsLoaded: false,
    refreshing: false,
    pending: [],
    error: null,
    targetsError: null,
  };
  private listeners = new Set<() => void>();
  private optimistic = new Map<string, Update>();
  private revision = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private badgeRefreshing: Promise<void> | null = null;
  private badgeAgain = false;
  private badgeRevision = 0;
  private targetsLoading: Promise<void> | null = null;
  private targetsLoaded = false;
  private targetsAgain = false;
  private checkedProjects = new Set<string>();

  constructor(
    private rpc: PluginRpcClient<typeof rpcContract>,
    private cache: InboxCache | null = null,
  ) {
    this.hydrate();
  }

  private hydrate() {
    try {
      const raw = this.cache?.read();
      const saved = raw ? cachedInbox.safeParse(JSON.parse(raw)) : null;

      if (!saved?.success) return;
      this.status = { ...saved.data.status, syncing: false };
      this.snapshot = {
        ...this.snapshot,
        status: this.status,
        badge: saved.data.status.badge,
        targets: saved.data.targets,
        targetsLoaded: saved.data.targets.projects.length > 0,
      };
    } catch {
      this.status = null;
    }
  }

  private persist() {
    if (!this.cache || !this.status) return;

    try {
      this.cache.write(
        JSON.stringify({ version: 1, status: this.status, targets: this.snapshot.targets }),
      );
    } catch {
      return;
    }
  }

  private warmed = false;

  warm() {
    if (this.warmed) return;
    this.warmed = true;

    if (this.status || this.refreshing) return;
    void this.refresh();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;

  listInbox = (query: InboxQuery) => this.rpc.call("inbox.list", query);

  private emit(patch: Partial<Snapshot> = {}) {
    let status = this.status;

    if (status) for (const update of this.optimistic.values()) status = update(status);
    this.snapshot = { ...this.snapshot, ...patch, status, pending: [...this.optimistic.keys()] };

    for (const listener of this.listeners) listener();
  }

  refresh() {
    if (this.refreshing) {
      this.refreshAgain = true;

      return this.refreshing;
    }

    const revision = this.revision;
    const badgeRevision = ++this.badgeRevision;
    this.emit({ refreshing: true });

    const work = Promise.all([this.rpc.call("status"), this.rpc.call("targets")])
      .then(([status, targets]) => {
        if (revision === this.revision) {
          this.status =
            badgeRevision === this.badgeRevision || this.snapshot.badge === null
              ? status
              : { ...status, badge: this.snapshot.badge };
          this.targetsLoaded = true;
          this.checkedProjects = new Set(status.routes.map((route) => route.projectId));
          const patch: Partial<Snapshot> = { targets, targetsLoaded: true, targetsError: null };

          if (badgeRevision === this.badgeRevision) {
            patch.badge = status.badge;
            patch.badgeError = null;
          }

          this.emit(patch);
        }

        this.emit(this.snapshot.error === refreshFailure ? { error: null } : {});
        this.persist();
      })
      .catch(() => {
        this.emit({ error: refreshFailure });
      })
      .finally(() => {
        this.refreshing = null;
        this.emit({ refreshing: false });

        if (this.refreshAgain) {
          this.refreshAgain = false;
          void this.refresh();
        }
      });

    this.refreshing = work;

    return work;
  }

  refreshBadge() {
    if (this.badgeRefreshing) {
      this.badgeAgain = true;

      return this.badgeRefreshing;
    }

    const revision = ++this.badgeRevision;
    this.emit({ badgeRefreshing: true });

    const work = this.rpc
      .call("badge")
      .then(
        (badge) => {
          if (revision !== this.badgeRevision) return;

          if (this.status) this.status = { ...this.status, badge };
          this.emit({ badge, badgeError: null });
        },
        () => {
          if (revision === this.badgeRevision) this.emit({ badgeError: refreshFailure });
        },
      )
      .finally(() => {
        this.badgeRefreshing = null;
        this.emit({ badgeRefreshing: false });

        if (this.badgeAgain) {
          this.badgeAgain = false;
          void this.refreshBadge();
        }
      });

    this.badgeRefreshing = work;

    return work;
  }

  private verifyTargets(status: Status) {
    if (!this.snapshot.targetsLoaded) return;
    const known = new Set(this.snapshot.targets.projects.map((project) => project.id));

    const unchecked = status.routes.some(
      (route) => !known.has(route.projectId) && !this.checkedProjects.has(route.projectId),
    );

    if (!unchecked) return;
    this.emit({ targetsLoaded: false });
    this.loadTargets(true);
  }

  loadTargets(force = false) {
    if (this.targetsLoading) {
      if (force) this.targetsAgain = true;

      return;
    }

    if (this.targetsLoaded && !force) return;
    const requested = new Set(this.status?.routes.map((route) => route.projectId));

    this.targetsLoading = this.rpc
      .call("targets")
      .then((targets) => {
        if (this.targetsAgain) return;
        this.targetsLoaded = true;
        this.checkedProjects = requested;
        this.emit({ targets, targetsLoaded: true, targetsError: null });
        this.persist();

        if (this.status) this.verifyTargets(this.status);
      })
      .catch(() => {
        this.emit({
          targetsError: "Project choices could not load. Reopen the route editor to retry.",
        });
      })
      .finally(() => {
        this.targetsLoading = null;

        if (this.targetsAgain) {
          this.targetsAgain = false;
          this.loadTargets(true);
        }
      });
  }

  private async action<T>(
    key: string,
    optimistic: Update,
    work: () => Promise<T>,
    commit: (value: T, status: Status) => Status,
    failure: string,
  ) {
    if (this.optimistic.has(key)) return false;
    this.revision++;
    this.optimistic.set(key, optimistic);
    this.emit({ error: null });

    try {
      const result = await work();

      if (this.status) this.status = commit(result, this.status);
      this.revision++;
      this.optimistic.delete(key);
      this.emit();
      void this.refresh();

      return true;
    } catch {
      this.optimistic.delete(key);
      this.revision++;
      this.emit({ error: failure });
      void this.refresh();

      return false;
    }
  }

  sync = () =>
    this.action(
      operationKey.sync,
      (status) => ({ ...status, syncing: true }),
      () => this.rpc.call("sync.start"),
      (_result, status) => ({ ...status, syncing: true }),
      "Sync could not start. The last known inbox is retained.",
    );

  toggleRoute = (id: string, enabled: boolean) =>
    this.action(
      operationKey.route(id),
      (status) => ({
        ...status,
        routes: status.routes.map((route) => (route.id === id ? { ...route, enabled } : route)),
      }),
      () => this.rpc.call("routes.enable", { id, enabled }),
      (route, status) => ({
        ...status,
        routes: status.routes.map((previous) => (previous.id === id ? route : previous)),
      }),
      "Watching could not change. The previous setting is restored.",
    );

  savePolicy = (policy: ProjectPolicy) =>
    this.action(
      operationKey.policy(policy.projectId),
      (status) => ({
        ...status,
        projectPolicies: status.projectPolicies.map((previous) =>
          previous.projectId === policy.projectId
            ? {
                ...previous,
                ...policy,
                remaining: Math.max(0, policy.dailyLimit - previous.started),
              }
            : previous,
        ),
      }),
      () => this.rpc.call("projects.policy", policy),
      (policy, status) => ({
        ...status,
        projectPolicies: status.projectPolicies.map((previous) =>
          previous.projectId === policy.projectId ? policy : previous,
        ),
      }),
      "Auto solve settings could not save. The previous settings are restored.",
    );

  saveRoute = (route: Route) =>
    this.action(
      operationKey.route(route.id),
      keep,
      () => this.rpc.call("routes.save", route),
      (saved, status) => ({
        ...status,
        routes: [...status.routes.filter((previous) => previous.id !== saved.id), saved],
      }),
      "The route could not save. Your draft remains in the editor.",
    );

  catalog = (organization: string) => this.rpc.call("projects.catalog", { organization });
  repositories = (projectId: string) => this.rpc.call("projects.repositories", { projectId });
  addProject = (route: Route) =>
    this.action(
      operationKey.route(route.id),
      keep,
      () => this.rpc.call("projects.add", route),
      (saved, status) => ({
        ...status,
        routes: [...status.routes.filter((route) => route.id !== saved.id), saved],
      }),
      "Project could not save. Your choices are retained.",
    );
  private models() {
    return this.snapshot.status?.models ?? builtinModelDefaults;
  }
  saveModel = (role: ModelRole, selection: ModelSelection) =>
    this.action(
      operationKey.model(role),
      (status) => ({
        ...status,
        models: { ...status.models, [role]: selection },
      }),
      () => this.rpc.call("models.save", { role, selection }),
      (models, status) => ({ ...status, models }),
      "Couldn’t save the model settings. Your previous settings were restored. Try again.",
    );
  solveAll = (projectId: string) =>
    this.action(
      operationKey.batch(projectId),
      keep,
      () => this.rpc.call("projects.solveAll", { projectId, model: this.models().coordinator }),
      this.updateBatch,
      "Project investigation could not start. Existing work is retained.",
    );
  stopBatch = (id: string) =>
    this.action(
      operationKey.batchRun(id),
      keep,
      () => this.rpc.call("batches.stop", { id }),
      this.updateBatch,
      "Project investigation could not stop. Open its existing chat.",
    );
  resumeBatch = (id: string) =>
    this.action(
      operationKey.batchRun(id),
      keep,
      () => this.rpc.call("batches.resume", { id }),
      this.updateBatch,
      "Project investigation could not resume. Open its existing chat.",
    );
  private updateBatch = (batch: ProjectBatch, status: Status): Status => {
    const { incidents, routes: _routes, blocked: _blocked, ...summary } = batch;

    return {
      ...status,
      batches: [
        { ...summary, issueCount: incidents.length },
        ...(status.batches ?? []).filter((previous) => previous.id !== batch.id),
      ],
    };
  };

  investigate = (routeId: string, issueUrl: string) =>
    this.action(
      operationKey.issue(issueUrl),
      keep,
      () =>
        this.rpc.call("investigate", {
          routeId,
          issueUrl,
          mode: this.status?.routes.find((route) => route.id === routeId)?.delivery ?? "local",
          model: this.models().solver,
        }),
      this.updateRun,
      "The solver could not start. Existing source and runs are retained.",
    );

  stop = (id: string) =>
    this.action(
      operationKey.run(id),
      keep,
      () => this.rpc.call("runs.stop", { id }),
      this.updateRun,
      "The run could not stop. Open its existing chat to inspect the worker.",
    );

  retry = (id: string) =>
    this.action(
      operationKey.run(id),
      keep,
      () => this.rpc.call("runs.retry", { id }),
      this.updateRun,
      "The run could not resume. Open its existing chat before retrying.",
    );

  private updateRun = (run: Run, status: Status): Status => ({
    ...status,
    runs: [run, ...status.runs.filter((previous) => previous.id !== run.id)],
  });
}
