import type { PluginApi } from "@omnyo/plugin-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CHANGED,
  type ActiveCohort,
  type Cohort,
  type CommitPart,
  type CounterUsage,
  type FoldLedger,
  type Health,
  type Report,
  type ReportInput,
  type Summary,
  type TurnScope,
} from "../contract.ts";
import { fold, initialState, stateSchema, type EventRow, type State, type Thread } from "./fold.ts";
import { StatsStore } from "./store.ts";

const types: readonly [EventRow["type"], ...EventRow["type"][]] = [
  "client/turn/requested",
  "turn/input/accepted",
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated",
  "provider/modelFallback",
  "item/started",
  "item/completed",
  "item/backgroundTask/completed",
  "system/interaction/lifecycle",
  "thread/contextWindowUsage/updated",
];

const poolSchema = z.object({
  accounts: z.array(
    z.object({ id: z.string(), label: z.string().nullable(), provider: z.string() }),
  ),
});

const errorStatus = z.object({ status: z.number() });

type ListThread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["list"]>>[number];

interface Pending {
  thread: Thread | ListThread | null;
  target: number;
  fresh: boolean;
  acknowledgment: {
    done: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
}

interface Live {
  cohort: Cohort;
  chats: number;
  native: number;
}

function spawnRole(row: EventRow, createdAt: number): Cohort["chatRole"] {
  if (
    row.type !== "client/turn/requested" ||
    row.createdAt < createdAt ||
    row.data.source !== "spawn" ||
    row.data.target.kind !== "thread-start"
  )
    return "unknown";

  if (row.data.initiator === "agent" && row.data.senderThreadId !== null) return "subagent";

  if (row.data.initiator === "user" && row.data.senderThreadId === null) return "main";

  return "unknown";
}

export class Collector {
  readonly store: StatsStore;
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<string, Pending>();
  private reading: { id: string; pending: Pending } | null = null;
  private readonly live = new Map<string, Live>();
  private readonly hostNames = new Map<string, string>();
  private readonly projectNames = new Map<string, string>();
  private readonly environments = new Map<string, string>();
  private wake: (() => void) | null = null;
  private inventory = { archived: false, offset: 0, done: false };
  private coveredFrom = Date.now();
  private lastMaintenanceAt: number | null = null;
  private maintenancePending = false;
  private lastSignalAt = 0;
  private sourcePages = 0;
  private sourceEvents = 0;
  private lastPageMs = 0;
  private error: string | null = null;
  private readonly readErrors = new Map<string, string>();
  private readonly deleted = new Set<string>();
  private accountState =
    "Account roster has not been read. Usage-to-account mapping is unavailable.";
  private accounts: Health["accounts"] = [];
  private indexing = false;
  private liveReady = false;
  private reconcileAgain = false;
  private runPromise: Promise<void> | null = null;

  constructor(private readonly api: PluginApi) {
    this.store = new StatsStore(api);
    api.events.on(
      "experimental_thread.events",
      ({ thread, sequence }) => {
        this.updateLive(thread);

        return this.enqueue(thread.id, thread, sequence, true);
      },
      {
        experimental_eventTypes: [...types, "item/backgroundTask/progress", "thread/name/updated"],
      },
    );

    for (const event of [
      "thread.created",
      "thread.active",
      "thread.idle",
      "thread.failed",
      "thread.archived",
      "thread.unarchived",
    ] as const) {
      api.events.on(event, ({ thread }) => {
        this.updateLive(thread);

        return this.enqueue(thread.id, thread, 0, true);
      });
    }

    api.events.on("thread.deleted", ({ thread }) => {
      this.flushConcurrency();
      this.live.delete(thread.id);
      this.publishLive();
      this.deleted.add(thread.id);

      if (this.deleted.size > 1024) {
        const first = this.deleted.values().next().value;

        if (first !== undefined) this.deleted.delete(first);
      }

      this.pending.get(thread.id)?.acknowledgment.resolve();
      this.pending.delete(thread.id);

      if (this.reading?.id === thread.id) this.reading.pending.acknowledgment.resolve();
      this.readErrors.delete(thread.id);
      this.store.markDeleted(thread.id);
      this.store.markComplete(thread.id);
      this.changed(true);
    });
    api.onDispose(async () => {
      this.lifetime.abort();

      const error = new Error(
        "Stats collector was disposed before its queued history read finished",
      );

      for (const pending of this.pending.values()) pending.acknowledgment.reject(error);
      this.reading?.pending.acknowledgment.reject(error);
      this.pending.clear();
      this.wake?.();

      try {
        await this.runPromise;
      } catch {
        if (!this.lifetime.signal.aborted) throw new Error("Stats collector stopped unexpectedly");
      }
    });
  }

  private changed(force = false, live = false): void {
    if (this.lifetime.signal.aborted) return;
    const now = Date.now();

    if (!force && now - this.lastSignalAt < 1000) return;
    this.lastSignalAt = now;
    this.api.realtime.publish(CHANGED, { asOf: now, live, data: !live });
  }

  private acknowledgment(): Pending["acknowledgment"] {
    let resolve = () => {};

    let reject = (_error: Error) => {};

    const done = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });

    void done.catch(() => {
      if (!this.lifetime.signal.aborted)
        this.api.log.warn("Stats queued history read failed; its saved cursor was preserved.");
    });

    return { done, resolve, reject };
  }

  private enqueue(
    id: string,
    thread: Pending["thread"],
    target: number,
    fresh: boolean,
  ): Promise<void> {
    const previous = this.pending.get(id);
    const reading = this.reading?.id === id ? this.reading.pending : null;

    const acknowledgment =
      previous?.acknowledgment ?? reading?.acknowledgment ?? this.acknowledgment();

    if (!previous && !fresh && this.pending.size >= 1000) {
      this.reconcileAgain = true;
      acknowledgment.reject(
        new Error("Stats history queue is full; reconciliation remains queued"),
      );

      return acknowledgment.done;
    }

    this.pending.set(id, {
      thread: thread ?? previous?.thread ?? null,
      target: Math.max(target, previous?.target ?? 0),
      fresh: fresh || (previous?.fresh ?? false),
      acknowledgment,
    });
    this.wake?.();

    return acknowledgment.done;
  }

  private parseState(id: string, cohort: Cohort): State {
    const cursor = this.store.cursor(id);

    if (!cursor.state) return initialState(cohort);
    const state = stateSchema.parse(JSON.parse(cursor.state));
    state.cohort = {
      ...state.cohort,
      machine: cohort.machine,
      project: cohort.project,
      chat: id,
      provider: cohort.provider,
      chatRole: cohort.chatRole,
    };

    if (state.turn)
      state.turn.cohort = {
        ...state.turn.cohort,
        machine: cohort.machine,
        project: cohort.project,
        chatRole: cohort.chatRole,
        agentRole: state.turn.attributed ? cohort.chatRole : state.turn.cohort.agentRole,
      };

    return state;
  }

  private cohort(thread: Thread | ListThread): Cohort {
    const machine =
      "environmentHostId" in thread
        ? (thread.environmentHostId ?? "")
        : (this.environments.get(thread.environmentId ?? "") ?? "");

    return {
      machine,
      project: thread.projectId,
      chat: thread.id,
      provider: thread.providerId,
      model: "",
      effort: "",
      mode: "",
      account: "",
      chatRole: this.chatRole(thread),
      agentRole: "unknown",
    };
  }

  private chatRole(thread: Thread | ListThread): Cohort["chatRole"] {
    const known = this.metadataRole(thread);

    return known === "unknown" ? this.store.chatRole(thread.id).chatRole : known;
  }

  private metadataRole(thread: Thread | ListThread): Cohort["chatRole"] {
    // Parent assignment is editable and cannot prove who controls a chat.
    // Ambiguous child chats need their original public spawn author evidence.
    if (
      !("parentThreadId" in thread) ||
      !("lifecycleOwnerThreadId" in thread) ||
      !("originKind" in thread)
    )
      return "unknown";

    if (thread.lifecycleOwnerThreadId) return "subagent";

    if (thread.originKind === "fork") return "main";

    return thread.parentThreadId ? "unknown" : "main";
  }

  private touch(thread: Thread | ListThread, cohort: Cohort, roleChecked?: 0 | 1 | 2): void {
    this.store.touchChat({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? thread.id,
      machineName: this.hostNames.get(cohort.machine) ?? cohort.machine,
      projectName: this.projectNames.get(cohort.project) ?? cohort.project,
      deleted: thread.deletedAt !== null,
      archived: thread.archivedAt !== null,
      chatRole: cohort.chatRole,
      roleChecked,
    });
  }

  private updateLive(thread: Thread | ListThread, knownCohort?: Cohort): void {
    const chats =
      thread.status === "active" && thread.archivedAt === null && thread.deletedAt === null ? 1 : 0;

    const native =
      thread.archivedAt === null && thread.deletedAt === null
        ? "activity" in thread
          ? thread.activity.activeBackgroundAgentCount
          : thread.activeBackgroundAgentCount
        : 0;

    const previous = this.live.get(thread.id);
    let cohort = knownCohort ?? previous?.cohort ?? this.cohort(thread);

    if (!knownCohort && !previous) {
      const cursor = this.store.cursor(thread.id);

      if (cursor.state) cohort = stateSchema.parse(JSON.parse(cursor.state)).cohort;
    }

    cohort = { ...cohort, chatRole: this.chatRole(thread) };

    this.touch(thread, cohort);

    if (
      previous?.chats === chats &&
      previous?.native === native &&
      JSON.stringify(previous?.cohort) === JSON.stringify(cohort)
    )
      return;
    this.flushConcurrency();

    if (chats + native > 0) this.live.set(thread.id, { cohort, chats, native });
    else this.live.delete(thread.id);
    this.publishLive();
    this.changed(true, true);
  }

  private active(): ActiveCohort[] {
    return [...this.live.values()].flatMap((value) => [
      { cohort: { ...value.cohort, agentRole: value.cohort.chatRole }, count: value.chats },
      {
        cohort: {
          ...value.cohort,
          model: "",
          effort: "",
          mode: "",
          agentRole: "subagent" as const,
        },
        count: value.native,
      },
    ]);
  }
  private flushConcurrency(): void {
    const now = Date.now();

    if (this.liveReady) this.store.recordConcurrency(now, this.active(), this.coveredFrom);
    this.coveredFrom = now;
  }
  private publishLive(): void {
    const now = Date.now();
    this.store.recordConcurrency(now, this.active(), now);
  }

  summary(): Summary {
    let chats = 0;
    let native = 0;
    const roles = { main: 0, subagent: 0, unknown: 0 };

    for (const value of this.live.values()) {
      chats += value.chats;
      native += value.native;
      roles[value.cohort.chatRole] += value.chats;
    }

    return this.store.summary(Date.now(), chats + native, chats, native, this.liveReady, roles);
  }
  health(): Health {
    const stored = this.store.health();

    return {
      ...stored,
      queueDepth: this.pending.size,
      indexing: this.indexing || !this.inventory.done,
      error:
        this.readErrors.values().next().value ??
        this.error ??
        (stored.roleReadFailures > 0
          ? `Could not resolve ${stored.roleReadFailures} chat roles. Refresh to retry; token collection continues.`
          : null),
      accountState: this.accountState,
      accounts: this.accounts,
      lastMaintenanceAt: this.lastMaintenanceAt,
      sourcePages: this.sourcePages,
      sourceEvents: this.sourceEvents,
      lastPageMs: this.lastPageMs,
    };
  }
  report(input: ReportInput): Report {
    return this.store.report(input, this.summary(), this.health());
  }
  refresh(): void {
    this.store.retryRoleFailures();
    this.inventory = { archived: false, offset: 0, done: false };
    this.reconcileAgain = false;
    this.wake?.();
  }

  private async metadata(signal: AbortSignal): Promise<void> {
    const results = await Promise.allSettled([
      this.api.sdk.hosts.list({ signal }),
      this.api.sdk.projects.list({ includePersonal: true, signal }),
    ]);

    if (results[0].status === "fulfilled")
      for (const host of results[0].value) this.hostNames.set(host.id, host.name);

    if (results[1].status === "fulfilled")
      for (const project of results[1].value) this.projectNames.set(project.id, project.name);

    for (const result of results)
      if (result.status === "rejected")
        this.api.log.warn(
          "Stats could not resolve a dimension label; stored IDs remain available.",
        );

    try {
      const { plugins } = await this.api.sdk.plugins.list({ signal });

      if (!plugins.some((plugin) => plugin.id === "account-pool" && plugin.enabled)) {
        this.accounts = [];
        this.accountState =
          "Account Pooler is not enabled. Usage is not attributed to accounts; token attribution is Unknown.";

        return;
      }

      const status = await this.api.sdk.plugins.callRpc({
        pluginId: "account-pool",
        method: "status.get",
        input: null,
        outputSchema: poolSchema,
      });

      this.accounts = status.accounts.map((account) => ({
        id: account.id,
        label: account.label ?? account.id,
        provider: account.provider,
      }));
      this.accountState =
        "Account Pooler connected. Its current API provides no usage-to-account mapping; token attribution is Unknown.";
    } catch {
      this.accountState =
        "Account Pooler roster unavailable. No usage-to-account mapping is exposed; token attribution is Unknown.";
      this.api.log.warn("Stats account roster read failed; no account attribution was inferred.");
    }
  }

  private async discover(signal: AbortSignal): Promise<void> {
    const page = await this.api.sdk.threads.list({
      archived: this.inventory.archived,
      includeHidden: true,
      limit: 100,
      offset: this.inventory.offset,
      signal,
    });

    for (const thread of page) {
      const cohort = this.cohort(thread);

      if (thread.environmentId && "environmentHostId" in thread && thread.environmentHostId)
        this.environments.set(thread.environmentId, thread.environmentHostId);

      if (this.environments.size > 512) {
        const oldest = this.environments.keys().next().value;

        if (oldest !== undefined) this.environments.delete(oldest);
      }

      this.updateLive(thread, this.live.get(thread.id)?.cohort ?? undefined);
      this.touch(thread, cohort);
      this.enqueue(thread.id, thread, 0, false);
    }

    this.inventory.offset += page.length;

    if (page.length < 100) {
      if (!this.inventory.archived) {
        this.inventory = { archived: true, offset: 0, done: false };

        if (!this.liveReady) {
          this.coveredFrom = Date.now();
          this.liveReady = true;
        }

        this.publishLive();
      } else {
        this.inventory.done = true;
        this.changed(true);
      }
    }
  }

  private async page(id: string, pending: Pending, signal: AbortSignal): Promise<boolean> {
    let thread = pending.thread;

    if (!thread) thread = await this.api.sdk.threads.get({ threadId: id, signal });

    if (
      thread.environmentId &&
      !this.environments.has(thread.environmentId) &&
      !("environmentHostId" in thread)
    ) {
      const environment = await this.api.sdk.environments.get({
        environmentId: thread.environmentId,
        signal,
      });

      this.environments.set(thread.environmentId, environment.hostId);

      if (this.environments.size > 512) {
        const oldest = this.environments.keys().next().value;

        if (oldest !== undefined) this.environments.delete(oldest);
      }
    }

    let cohort = this.cohort(thread);

    if (!this.deleted.has(id)) this.touch(thread, cohort);

    if (this.metadataRole(thread) === "unknown" && this.store.chatRole(id).roleChecked === 0) {
      let roleChecked: 1 | 2 = 1;

      try {
        const requests = await this.api.sdk.threads.events.list({
          threadId: id,
          afterSeq: "0",
          limit: "1",
          order: "asc",
          types: ["client/turn/requested"],
          signal,
        });

        this.sourcePages += 1;
        this.sourceEvents += requests.length;
        const role = requests[0] ? spawnRole(requests[0], thread.createdAt) : "unknown";
        cohort = { ...cohort, chatRole: role };
      } catch (error) {
        if (signal.aborted) throw error;

        if (errorStatus.safeParse(error).data?.status !== 404) {
          roleChecked = 2;
          this.api.log.warn(
            `Stats could not read spawn provenance for ${id}; its role remains Unknown.`,
          );
        }
      }

      this.touch(thread, cohort, roleChecked);

      if (!this.deleted.has(id)) this.updateLive(thread, cohort);
    }

    const cursor = this.store.cursor(id);
    const state = this.parseState(id, cohort);
    let limit = 100;
    let rows: EventRow[];
    const started = performance.now();

    for (;;) {
      try {
        rows = await this.api.sdk.threads.events.list({
          threadId: id,
          afterSeq: String(cursor.seq),
          limit: String(limit),
          order: "asc",
          types,
          signal,
        });
        break;
      } catch (error) {
        if (errorStatus.safeParse(error).data?.status === 413 && limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }

        throw error;
      }
    }

    this.sourcePages += 1;
    this.sourceEvents += rows.length;
    this.lastPageMs = performance.now() - started;
    const parts = new Map<string, CommitPart>();
    const scopes = new Map<string, TurnScope>();
    const streams = new Map<string, CounterUsage>();

    const ledger: FoldLedger = {
      scope: (turnId) => scopes.get(turnId) ?? this.store.turnScope(id, turnId),
      saveScope: (turnId, value) => {
        scopes.set(turnId, value);
      },
      stream: (key) => streams.get(key) ?? this.store.stream(id, key),
      saveStream: (key, value) => {
        streams.set(key, value);
      },
    };

    for (const row of rows) {
      if (row.seq <= cursor.seq || row.createdAt < thread.createdAt) continue;

      if (state.cohort.chatRole === "unknown" && this.metadataRole(thread) === "unknown") {
        const role = spawnRole(row, thread.createdAt);

        if (role !== "unknown") {
          state.cohort.chatRole = role;

          if (state.turn?.attributed) {
            state.turn.cohort.chatRole = role;
            state.turn.cohort.agentRole = role;
          }

          this.touch(thread, state.cohort, 1);

          if (!this.deleted.has(id)) this.updateLive(thread, state.cohort);
        }
      }

      fold(state, row, parts, ledger);
    }

    const seq = rows.length > 0 ? rows[rows.length - 1].seq : cursor.seq;
    const exhausted = rows.length < limit;
    this.store.commit({
      threadId: id,
      seq: exhausted ? Math.max(seq, pending.target) : seq,
      state: JSON.stringify(state),
      parts: [...parts.values()],
      ledger: {
        scopes: [...scopes].map(([turnId, value]) => ({ turnId, value })),
        streams: [...streams].map(([key, value]) => ({ key, value })),
      },
    });
    const live = this.live.get(id);

    if (
      exhausted &&
      live &&
      !this.deleted.has(id) &&
      JSON.stringify(live.cohort) !== JSON.stringify(state.turn?.cohort ?? state.cohort)
    ) {
      this.flushConcurrency();
      this.live.set(id, { ...live, cohort: state.turn?.cohort ?? state.cohort });
      this.publishLive();
    }

    if (!exhausted) void this.enqueue(id, thread, pending.target, pending.fresh);
    else this.store.markComplete(id);
    this.changed();

    return exhausted;
  }

  private async wait(signal: AbortSignal, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);

        if (this.wake === done) this.wake = null;
        resolve();
      };

      const timer = setTimeout(done, ms);
      this.wake = done;
      signal.addEventListener("abort", done, { once: true });

      if (
        signal.aborted ||
        this.pending.size > 0 ||
        !this.inventory.done ||
        this.maintenancePending
      )
        done();
    });
  }

  start(signal: AbortSignal): Promise<void> {
    this.runPromise = this.run(AbortSignal.any([signal, this.lifetime.signal]));

    return this.runPromise;
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.metadata(signal);
    this.indexing = true;
    let sinceDiscovery = 0;
    let freshPages = 0;

    try {
      while (!signal.aborted) {
        if (this.liveReady && Date.now() - this.coveredFrom >= 15000) {
          this.flushConcurrency();
          this.changed(false, true);
        }

        if (
          this.maintenancePending ||
          this.lastMaintenanceAt === null ||
          Date.now() - this.lastMaintenanceAt > 3_600_000
        ) {
          this.maintenancePending = this.store.maintenance(Date.now());

          if (!this.maintenancePending) this.lastMaintenanceAt = Date.now();
          await delay(10, undefined, { signal });
        }

        if (
          !this.inventory.done &&
          (this.pending.size === 0 || sinceDiscovery >= 5) &&
          this.pending.size < 900
        ) {
          await this.discover(signal);
          sinceDiscovery = 0;
        }

        const fresh = (id: string, pending: Pending): boolean => pending.fresh || this.live.has(id);

        const backlog = [...this.pending].find(([id, pending]) => !fresh(id, pending));

        const entry =
          (freshPages >= 5 ? backlog : undefined) ??
          [...this.pending].find(([id, pending]) => fresh(id, pending)) ??
          this.pending.entries().next().value;

        if (entry) {
          const [id, pending] = entry;
          freshPages = fresh(id, pending) ? freshPages + 1 : 0;
          this.pending.delete(id);
          this.reading = { id, pending };

          try {
            const exhausted = await this.page(id, pending, signal);
            this.readErrors.delete(id);
            this.error = null;

            if (exhausted && !this.pending.has(id)) pending.acknowledgment.resolve();
          } catch (error) {
            pending.acknowledgment.reject(
              error instanceof Error ? error : new Error("Stats history read failed"),
            );

            if (signal.aborted) break;

            if (errorStatus.safeParse(error).data?.status === 404) {
              this.flushConcurrency();
              this.store.markDeleted(id);
              this.store.markComplete(id);
              this.live.delete(id);
              this.publishLive();
              this.readErrors.delete(id);
            } else {
              this.readErrors.set(id, `Could not collect chat ${id}. Refresh to retry.`);

              if (this.readErrors.size > 1024) {
                const oldest = this.readErrors.keys().next().value;

                if (oldest !== undefined) this.readErrors.delete(oldest);
              }

              this.api.log.error(
                `Stats history read failed for ${id}; saved cursor was preserved.`,
              );
            }
          } finally {
            this.reading = null;
          }

          sinceDiscovery += 1;
          await delay(10, undefined, { signal });
        } else {
          this.indexing = false;

          if (this.reconcileAgain) {
            this.refresh();
            continue;
          }

          this.flushConcurrency();
          this.changed(false, true);

          await this.wait(signal, this.live.size > 0 ? 15000 : 3_600_000);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.error =
          "Stats collection stopped unexpectedly. The collector will retry from its saved cursor.";
        throw error;
      }
    } finally {
      this.flushConcurrency();
      this.indexing = false;
    }
  }
}
