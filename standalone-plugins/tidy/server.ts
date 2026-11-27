import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { archiveResultSchema, chatCount, chatIdSchema } from "./archive-approval.ts";
import { createArchiveProposals } from "./archive-proposals.ts";

const READ_TIMEOUT_MS = 10_000;

const READ_RETRY_MS = 30_000;

const FULL_READ_MS = 5 * 60_000;

const MAX_ENTRIES = 100;

const TIDY_CHANGED = "tidy-changed";

const caveatSchema = z.object({ code: z.string(), text: z.string() });

const waitingSchema = z.object({ threadId: z.string(), on: z.string() });

const maintenanceRequestSchema = z.object({
  data: z.object({ maintenance: z.literal("auto-compaction") }),
});

const entrySchema = z.object({
  threadId: z.string(),
  reason: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  providerId: z.string(),
  status: z.string(),
  updatedAt: z.number(),
  caveats: z.array(caveatSchema),
});

const queueSchema = z.object({
  entries: z.array(entrySchema),
  omitted: z.number(),
  error: z.string().nullable(),
});

export type Caveat = z.infer<typeof caveatSchema>;

export type Entry = z.infer<typeof entrySchema>;

export type Queue = z.infer<typeof queueSchema>;

const reviewFields = z.object({
  threadId: chatIdSchema,
  title: z.string(),
  basis: z.string(),
});

const reviewSchema = z.object({
  chats: z.array(
    reviewFields.extend({
      basis: z.string().nullable(),
      state: z.enum(["ready", "not-ready", "archived", "failed", "unavailable"]),
      detail: z.string().nullable(),
    }),
  ),
});

export type ArchiveReview = z.infer<typeof reviewSchema>;

export const rpcContract = defineRpcContract({
  queue_get: { input: z.null(), output: queueSchema },
  ready_count: { input: z.null(), output: z.object({ ready: z.number() }) },
  ready_ids: {
    input: z.null(),
    output: z.object({
      threadIds: z.array(z.string()),
      waiting: z.array(waitingSchema),
      revision: z.number().int(),
      stale: z.boolean(),
    }),
  },
  entry_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ entry: entrySchema.nullable() }),
  },
  dismiss: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ threadId: z.string(), dismissed: z.boolean() }),
  },
  archive: {
    input: z.object({ threadIds: z.array(z.string().min(1)).min(1).max(MAX_ENTRIES) }),
    output: archiveResultSchema,
  },
  archive_review: {
    input: z.object({
      sourceThreadId: chatIdSchema,
      threadIds: z.array(chatIdSchema).min(1).max(MAX_ENTRIES),
    }),
    output: reviewSchema,
  },
  archive_approval: {
    input: z.object({
      sourceThreadId: chatIdSchema,
      reviewed: z.array(reviewFields).min(1).max(MAX_ENTRIES),
    }),
    output: archiveResultSchema,
  },
});

const COMPLETION_INSTRUCTIONS = [
  "Before every final response, assess whether the whole requested outcome is delivered with proportionate evidence and no material obligation from that request remains. Include earlier commitments, corrections and explicit user-approved scope changes. Only the user can accept a narrower finish line; do not silently substitute a substep, local trial or handoff for the requested outcome.",
  "A plan, audit, draft, preparation step or handoff is complete only when that bounded deliverable is the user's requested outcome or the user explicitly accepts the changed scope. Once that request is verified, optional polish, speculative follow-up and unrequested later stages do not keep it open.",
  "A provider refusal, partial trial, failed attempt, stopped run or delegated handoff leaves a larger requested outcome unfinished. Report completed parts as progress while the requested outcome remains unmet.",
  "Anything your final response reports as still open, unfixed, unresolved or remaining keeps the chat open, including a defect or stale state you found during this chat's work. Fix it within existing authority before responding, or report the remaining obligation.",
  "Continue recoverable work within existing authority. When a required action cannot proceed safely because authority, access, essential information or an external condition is unavailable, preserve progress and report the exact gate and next actor. Do not retry indefinitely or invent a blocker for optional work.",
  "An approval or outside event matters only when required for the requested finish line. Waiting for the user to install an update you already delivered does not by itself block completion. Foreign workspace changes are not this chat's work.",
  "A missing screenshot, timed-out test or disclosed limit blocks only if it leaves the requested result unestablished. A bare claim of completion cannot close missing core verification or a lost requested deliverable. Finish necessary work within existing authority before responding.",
  "Use report_chat_outcome when available to record the requested outcome and evidence, or the material blocker and next action. Answer the user normally and honor their output format. Keep completion bookkeeping out of the visible reply.",
  "Without an assessment or a report, readiness remains unassessed. Current work, questions and callback guards still apply.",
  "Agents cannot set readiness or archive; Omnyo combines the assessment with current obligations after the turn ends.",
].join(" ");

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

class TidyError extends Error {}

export default async function plugin(api: PluginApi) {
  api.settings.define({
    rowStatus: {
      type: "boolean",
      label: "Mark chat rows in the sidebar",
      description: "Show Ready to archive on chats recommended by the shared work summary.",
      default: true,
    },
  });

  api.storage.migrate(api.storage.database(), [
    `CREATE TABLE IF NOT EXISTS flags (
       thread_id TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       summary TEXT NOT NULL,
       verified TEXT NOT NULL,
       follow_ups TEXT,
       flagged_by TEXT NOT NULL,
       flagged_at INTEGER NOT NULL,
       withdrawn_at INTEGER,
       withdrawn_reason TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS flags_by_state ON flags (state, flagged_at DESC)`,
    `ALTER TABLE flags ADD COLUMN input_sequence INTEGER`,
    `CREATE TABLE readiness_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)`,
    `INSERT INTO readiness_revision VALUES (1, 0)`,
    `CREATE TABLE dismissals (
       thread_id TEXT PRIMARY KEY,
       input_sequence INTEGER NOT NULL,
       dismissed_at INTEGER NOT NULL
     )`,
  ]);

  function db() {
    return api.storage.database();
  }

  const proposals = createArchiveProposals(api.ui, api.storage.kv, api.log);

  function reconcileProposals(): void {
    void proposals
      .reconcile(new Set(readyIds))
      .catch((cause) => api.log.warn(`archive approval sync failed: ${errorText(cause)}`));
  }

  const dismissalSchema = z.object({ thread_id: z.string(), input_sequence: z.number() });
  let readyIds: string[] = [];
  let waiting: z.infer<typeof waitingSchema>[] = [];
  let stale = false;
  let problem: string | null = null;
  let disposed = false;
  let refreshing: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let needsFullRead = true;
  const changedIds = new Set<string>();
  const fullReadWaiters: Array<() => void> = [];

  type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

  type Candidate = Awaited<ReturnType<PluginApi["sdk"]["threads"]["list"]>>[number];

  let candidates = new Map<string, Candidate>();

  function readRevision(): number {
    return z
      .object({ revision: z.number() })
      .parse(db().prepare("SELECT revision FROM readiness_revision WHERE id = 1").get()).revision;
  }

  function readDismissals(): Map<string, number> {
    const rows = z
      .array(dismissalSchema)
      .parse(db().prepare("SELECT thread_id, input_sequence FROM dismissals").all());

    return new Map(rows.map((row) => [row.thread_id, row.input_sequence]));
  }

  function forgetDismissal(threadId: string): void {
    db().prepare("DELETE FROM dismissals WHERE thread_id = ?").run(threadId);
  }

  async function latestInput(threadId: string): Promise<number> {
    let beforeSeq: string | undefined;

    for (;;) {
      const [request] = await api.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
        beforeSeq,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });

      if (request === undefined) return 0;

      if (!maintenanceRequestSchema.safeParse(request).success) return request.seq;
      beforeSeq = String(request.seq);
    }
  }

  function setReadiness(
    ids: string[],
    nextWaiting: z.infer<typeof waitingSchema>[],
    nextStale: boolean,
  ): void {
    if (
      JSON.stringify([ids, nextWaiting, nextStale]) === JSON.stringify([readyIds, waiting, stale])
    )
      return;
    readyIds = ids;
    waiting = nextWaiting;
    stale = nextStale;
    db().prepare("UPDATE readiness_revision SET revision = revision + 1 WHERE id = 1").run();
    api.realtime.publish(TIDY_CHANGED, {
      ready: readyIds.length,
      revision: readRevision(),
      threadIds: readyIds,
      waiting,
      stale,
    });

    if (!stale) reconcileProposals();
  }

  function offered(
    thread: Pick<
      Candidate,
      "archivedAt" | "deletedAt" | "visibility" | "shelvedAt" | "parentThreadId"
    >,
  ): boolean {
    return (
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.visibility !== "hidden" &&
      thread.shelvedAt === null &&
      thread.parentThreadId === null
    );
  }

  async function listed(): Promise<Candidate[]> {
    const threads: Candidate[] = [];

    for (let offset = 0; ; offset += 100) {
      const page = await api.sdk.threads.list({
        archived: false,
        hasParent: false,
        limit: 100,
        offset,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });

      threads.push(...page.filter(offered));

      if (page.length < 100) break;
    }

    return threads;
  }

  async function listedById(ids: string[]): Promise<Map<string, Candidate>> {
    const threads = await api.sdk.threads.list({
      archived: false,
      hasParent: false,
      threadIds: ids,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });

    return new Map(threads.filter(offered).map((thread) => [thread.id, thread]));
  }

  async function dismissed(threadId: string, dismissals = readDismissals()): Promise<boolean> {
    const sequence = dismissals.get(threadId);

    if (sequence === undefined) return false;

    if ((await latestInput(threadId)) === sequence) return true;
    forgetDismissal(threadId);

    return false;
  }

  async function publishSnapshot(): Promise<void> {
    const dismissals = readDismissals();
    const shown: string[] = [];
    const nextWaiting: z.infer<typeof waitingSchema>[] = [];
    let missing = 0;

    const threads = [...candidates.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );

    for (const thread of threads) {
      if (thread.work === null) missing += 1;

      if (
        thread.work?.archive.recommended &&
        !changedIds.has(thread.id) &&
        !(await dismissed(thread.id, dismissals))
      )
        shown.push(thread.id);

      if (thread.work?.primary.label === "waiting" || thread.work?.primary.label === "external")
        nextWaiting.push({ threadId: thread.id, on: thread.work.primary.reason.text });
    }

    if (disposed) return;
    problem =
      missing === 0
        ? null
        : `The shared work summary is unavailable for ${plural(missing, "chat", "chats")}.`;
    setReadiness(shown, nextWaiting, false);
  }

  function scheduleRetry(): void {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestRefresh();
    }, READ_RETRY_MS);
    retryTimer.unref?.();
  }

  async function drainChanges(): Promise<void> {
    while (!disposed && (needsFullRead || changedIds.size > 0)) {
      const full = needsFullRead;
      const ids = full ? [] : [...changedIds].slice(0, MAX_ENTRIES);
      const waiters = full ? fullReadWaiters.splice(0) : [];

      needsFullRead = false;

      for (const id of ids) changedIds.delete(id);

      try {
        if (full) {
          const next = new Map((await listed()).map((thread) => [thread.id, thread]));

          for (const id of changedIds) {
            const known = candidates.get(id);

            if (known === undefined) next.delete(id);
            else next.set(id, known);
          }

          candidates = next;
        } else {
          const read = await listedById(ids);

          for (const id of ids) {
            if (changedIds.has(id)) continue;
            const thread = read.get(id);

            if (thread === undefined) candidates.delete(id);
            else candidates.set(id, thread);
          }
        }

        if (disposed) return;
        await publishSnapshot();
      } catch (cause) {
        needsFullRead ||= full;

        for (const id of ids) changedIds.add(id);
        problem = `The shared work summary could not be read (${errorText(cause)}). Showing the last known list.`;
        setReadiness(readyIds, waiting, true);
        scheduleRetry();

        for (const resolve of fullReadWaiters.splice(0)) resolve();
        throw cause;
      } finally {
        for (const resolve of waiters) resolve();
      }
    }
  }

  function refresh(): Promise<void> {
    if (refreshing !== null) return refreshing;

    refreshing = Promise.resolve()
      .then(drainChanges)
      .finally(() => {
        refreshing = null;

        if (!disposed && retryTimer === null && (needsFullRead || changedIds.size > 0))
          requestRefresh();
      });

    return refreshing;
  }

  function requestRefresh(): void {
    void refresh().catch((cause) =>
      api.log.warn(`work summary refresh failed: ${errorText(cause)}`),
    );
  }

  function readCurrent(): Promise<void> {
    if (disposed) return Promise.resolve();

    return new Promise((resolve) => {
      fullReadWaiters.push(resolve);
      needsFullRead = true;
      requestRefresh();
    });
  }

  async function dismiss(threadId: string): Promise<boolean> {
    const sequence = await latestInput(threadId);
    const wasReady = readyIds.includes(threadId);
    await api.sdk.threads.experimental_publishWork({
      threadId,
      pluginId: api.pluginId,
      contribution: {
        kind: "signals",
        signals: {
          complete: true,
          validUntil: null,
          activity: [],
          waits: [],
          failures: [],
          postponement: {
            reason: "Not ready to archive",
            until: null,
            resumeActor: { kind: "user", id: null, label: "Continue the chat" },
          },
        },
      },
    });
    db()
      .prepare(
        `INSERT INTO dismissals (thread_id, input_sequence, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET input_sequence = excluded.input_sequence, dismissed_at = excluded.dismissed_at`,
      )
      .run(threadId, sequence, Date.now());
    setReadiness(
      readyIds.filter((id) => id !== threadId),
      waiting,
      stale,
    );

    return wasReady;
  }

  async function environmentCaveats(
    environmentId: string | null,
    cache: Map<string, Caveat[]>,
  ): Promise<Caveat[]> {
    if (environmentId === null) return [];
    const cached = cache.get(environmentId);

    if (cached !== undefined) return cached;
    let found: Caveat[] = [];

    try {
      const status = await api.sdk.environments.status({ environmentId });

      if (status.outcome === "available") {
        const tree = status.workspace.workingTree;

        if (tree.hasUncommittedChanges) {
          found.push({
            code: "uncommitted",
            text: `${plural(tree.files.length, "uncommitted file", "uncommitted files")} in the workspace`,
          });
        }

        const base = status.workspace.mergeBase;

        if (base !== null && base.aheadCount > 0) {
          found.push({
            code: "unmerged",
            text: `${plural(base.aheadCount, "commit", "commits")} on this branch not merged into ${base.mergeBaseBranch}`,
          });
        }
      } else if (status.outcome === "unavailable") {
        // Say so rather than reading an unreadable workspace as a clean one.
        found = [
          {
            code: "workspace-unreadable",
            text: `the workspace state could not be read (${status.failure.code})`,
          },
        ];
      }
    } catch (cause) {
      found = [
        {
          code: "workspace-unreadable",
          text: `the workspace state could not be read (${errorText(cause)})`,
        },
      ];
    }

    cache.set(environmentId, found);

    return found;
  }

  function workCaveats(thread: Thread): Caveat[] {
    const work = thread.work;

    if (work === null)
      return [{ code: "work-unavailable", text: "The shared work summary is unavailable." }];

    return [
      ...work.requiredInput.map((input) => ({ code: "required-input", text: input.label })),
      ...work.optionalInput.map((input) => ({ code: "optional-input", text: input.label })),
      ...work.activity.map((activity) => ({ code: "activity", text: activity.label })),
      ...work.failures.map((failure) => ({ code: failure.code, text: failure.text })),
      ...work.waits.map((wait) => ({ code: "wait", text: wait.reason })),
      ...(work.archive.eligible ? [] : [{ code: "archive-ineligible", text: work.archive.reason }]),
    ];
  }

  function threadTitle(thread: Thread | Candidate): string {
    return thread.title ?? thread.titleFallback ?? thread.id;
  }

  async function projectNames(): Promise<Map<string, string>> {
    const projects = await api.sdk.projects.list();

    return new Map(projects.map((project) => [project.id, project.name]));
  }

  function entry(thread: Candidate, names: Map<string, string>, notes: Caveat[]): Entry {
    return {
      threadId: thread.id,
      reason: thread.work?.primary.reason.text ?? "The shared work summary is unavailable.",
      title: threadTitle(thread),
      projectId: thread.projectId,
      projectName: names.get(thread.projectId) ?? "",
      providerId: thread.providerId,
      status: thread.runtime.displayStatus,
      updatedAt: thread.updatedAt,
      caveats: notes,
    };
  }

  async function readQueue(): Promise<Queue> {
    await readCurrent();

    const names = await projectNames();
    const cache = new Map<string, Caveat[]>();
    const entries: Entry[] = [];

    for (const id of readyIds.slice(0, MAX_ENTRIES)) {
      const thread = candidates.get(id);

      if (thread !== undefined)
        entries.push(entry(thread, names, await environmentCaveats(thread.environmentId, cache)));
    }

    return { entries, omitted: Math.max(0, readyIds.length - MAX_ENTRIES), error: problem };
  }

  async function readEntry(threadId: string): Promise<Entry | null> {
    await readCurrent();

    if (!readyIds.includes(threadId)) return null;
    const thread = candidates.get(threadId);

    return thread === undefined
      ? null
      : entry(
          thread,
          await projectNames(),
          await environmentCaveats(thread.environmentId, new Map()),
        );
  }

  async function archiveChats(
    selection: { threadId: string; basis?: string; title?: string }[],
    source?: Thread,
  ) {
    const failures: Array<{ threadId: string; message: string }> = [];
    let archived = 0;

    for (const { threadId, basis, title } of selection) {
      try {
        const thread = await api.sdk.threads.get({ threadId });

        if (
          thread.shelvedAt !== null ||
          thread.visibility === "hidden" ||
          (await dismissed(threadId))
        )
          throw new TidyError("The chat is not offered for archiving.");

        if (thread.work === null) throw new TidyError("The shared work summary is unavailable.");

        if (
          source !== undefined &&
          (threadId === source.id ||
            thread.projectId !== source.projectId ||
            !offered(thread) ||
            threadTitle(thread) !== title ||
            thread.work.basis !== basis ||
            !thread.work.archive.recommended)
        )
          throw new TidyError("This chat changed since it was reviewed.");

        const result = await api.sdk.threads.experimental_archiveReady({
          threadId,
          basis: basis ?? thread.work.basis,
        });

        if (!result.archivedThreadIds.includes(threadId))
          throw new TidyError("The chat was not archived.");
        archived += 1;
        forgetDismissal(threadId);
      } catch (cause) {
        failures.push({ threadId, message: errorText(cause) });
      }
    }

    await readCurrent();

    return { archived, failures };
  }

  async function reviewArchive(
    sourceThreadId: string,
    threadIds: string[],
  ): Promise<ArchiveReview> {
    const source = await api.sdk.threads.get({ threadId: sourceThreadId });
    const chats: ArchiveReview["chats"] = [];

    for (const threadId of new Set(threadIds)) {
      const thread = await api.sdk.threads.get({ threadId }).catch(() => null);

      if (thread === null || thread.projectId !== source.projectId || threadId === sourceThreadId) {
        chats.push({
          threadId,
          title: "Chat unavailable",
          basis: null,
          state: "unavailable",
          detail: null,
        });
        continue;
      }

      const basis =
        offered(thread) && thread.work?.archive.recommended && !(await dismissed(threadId))
          ? thread.work.basis
          : null;

      chats.push({
        threadId,
        title: threadTitle(thread),
        basis,
        state: thread.archivedAt !== null ? "archived" : basis === null ? "not-ready" : "ready",
        detail: thread.archivedAt === null && basis === null ? "No longer ready to archive" : null,
      });
    }

    return { chats };
  }

  api.rpc.register(rpcContract, {
    queue_get: readQueue,
    ready_count: async () => {
      await readCurrent();

      return { ready: readyIds.length };
    },
    ready_ids: async () => {
      await readCurrent();

      return { threadIds: readyIds, waiting, revision: readRevision(), stale };
    },
    entry_get: async ({ threadId }) => ({ entry: await readEntry(threadId) }),
    dismiss: async ({ threadId }) => ({ threadId, dismissed: await dismiss(threadId) }),
    archive: ({ threadIds }) =>
      archiveChats([...new Set(threadIds)].map((threadId) => ({ threadId }))),
    archive_review: ({ sourceThreadId, threadIds }) => reviewArchive(sourceThreadId, threadIds),
    archive_approval: async ({ sourceThreadId, reviewed }, context) => {
      if (context.experimental_caller.kind !== "client")
        throw new TidyError("Approve this archive from the approval above the composer.");

      const source = await api.sdk.threads.get({ threadId: sourceThreadId });
      const selection = [...new Map(reviewed.map((chat) => [chat.threadId, chat])).values()];

      proposals.approving(sourceThreadId);

      return archiveChats(selection, source);
    },
  });

  api.agents.contributeInstructions(() => COMPLETION_INSTRUCTIONS);

  function resolveThreadId(reference: string | undefined, contextThreadId?: string): string {
    const id = reference?.trim();

    if (id !== undefined && id !== "" && id !== ".") return id;

    if (contextThreadId === undefined || contextThreadId === "")
      throw new TidyError("No chat in context. Name the chat id.");

    return contextThreadId;
  }

  const usage = [
    "Usage:",
    "  Omnyo tidy list [--project <project-id>] [--json]",
    "  Omnyo tidy check [<chat-id>|.] [--json]",
    "  Omnyo tidy show [<chat-id>|.] [--json]",
    "  Omnyo tidy propose [--json]",
    "  Omnyo tidy dismiss [<chat-id>|.] [--json]",
    "",
    "The shared work summary recommends Ready to archive from a current assessment and current obligations. Tidy keeps the user's Not done override. Archiving requires an explicit action.",
  ].join("\n");

  api.cli.register({
    name: "tidy",
    summary: "See which chats the shared work summary recommends archiving",
    commands: [
      {
        name: "list",
        summary: "Every chat currently recommended Ready to archive",
        usage: "Omnyo tidy list [--project <project-id>] [--json]",
      },
      {
        name: "check",
        summary: "Read one chat's shared work summary and archive recommendation",
        usage: "Omnyo tidy check [<chat-id>|.] [--json]",
      },
      {
        name: "show",
        summary: "One ready chat with its recorded reason",
        usage: "Omnyo tidy show [<chat-id>|.] [--json]",
      },
      {
        name: "propose",
        summary:
          "Pin one archive approval for ready chats in this project above the owner's composer",
        usage: "Omnyo tidy propose [--json]",
      },
      {
        name: "dismiss",
        summary: "Hide a chat from Ready to archive until new input arrives",
        usage: "Omnyo tidy dismiss [<chat-id>|.] [--json]",
      },
    ],
    async run(argv, ctx) {
      const positional: string[] = [];
      let json = false;
      let project: string | undefined;

      for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--json") json = true;
        else if (arg === "--project") project = argv[++index];
        else if (arg.startsWith("--project=")) project = arg.slice(10);
        else positional.push(arg);
      }

      const reply = (value: import("@omnyo/plugin-sdk").JsonValue, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      try {
        const [command, reference] = positional;

        if (command === undefined || command === "help" || command === "--help")
          return { exitCode: 0, stdout: usage };

        if (command === "list") {
          const queue = await readQueue();

          const entries =
            project === undefined
              ? queue.entries
              : queue.entries.filter((item) => item.projectId === project);

          const lines =
            entries.length === 0
              ? ["No chats are recommended Ready to archive."]
              : entries.map((item) => `${item.title} [${item.threadId}]\n  ${item.reason}`);

          if (queue.omitted > 0) lines.push(`${queue.omitted} more not shown.`);

          if (queue.error !== null) lines.push(queue.error);

          return reply({ ...queue, entries }, lines.join("\n"));
        }

        if (command === "propose") {
          const sourceThreadId = resolveThreadId(undefined, ctx.threadId);
          const source = await api.sdk.threads.get({ threadId: sourceThreadId });
          await readCurrent();

          const chats = readyIds.flatMap((threadId) => {
            const thread = candidates.get(threadId);

            return threadId !== sourceThreadId && thread?.projectId === source.projectId
              ? [{ threadId: chatIdSchema.parse(threadId), title: threadTitle(thread) }]
              : [];
          });

          const threadIds = chats.map(({ threadId }) => threadId);

          if (stale || problem !== null)
            throw new TidyError("Archive readiness could not be refreshed.");

          if (threadIds.length > MAX_ENTRIES)
            throw new TidyError("There are too many chats to review in one approval.");

          if (threadIds.length === 0)
            return reply(
              { threadIds, pinned: false },
              "No chats in this project are ready to archive.",
            );

          const outcome = await proposals.propose(sourceThreadId, chats);

          return reply(
            { threadIds, pinned: true },
            [
              outcome === "pinned"
                ? `Pinned an approval to archive ${chatCount(threadIds.length)} above the owner's composer in this chat.`
                : `The approval to archive ${chatCount(threadIds.length)} is already pinned above the owner's composer in this chat.`,
              "The owner archives or dismisses it there. Do not paste a directive, repeat the list or ask the owner to confirm in chat.",
            ].join("\n"),
          );
        }

        const threadId = resolveThreadId(reference, ctx.threadId);

        if (command === "dismiss") {
          const wasReady = await dismiss(threadId);

          return reply(
            { threadId, dismissed: wasReady },
            "Marked Not done until new input arrives in the chat.",
          );
        }

        if (command === "show") {
          const found = await readEntry(threadId);

          return reply(
            { threadId, entry: found },
            found === null
              ? "That chat is not ready to archive."
              : `${found.title} [${threadId}]\n  ${found.reason}`,
          );
        }

        if (command === "check") {
          const thread = await api.sdk.threads.get({ threadId });
          const work = thread.work;
          const workNotes = workCaveats(thread);
          const workspaceNotes = await environmentCaveats(thread.environmentId, new Map());
          const notes = [...workNotes, ...workspaceNotes];
          const hidden = await dismissed(threadId);
          const ready = !hidden && (work?.archive.recommended ?? false);

          const reason = hidden
            ? "The user marked it Not done. New input clears that override."
            : (work?.archive.reason ?? "The shared work summary is unavailable.");

          const verdict =
            work?.assessment.availability === "available"
              ? {
                  ready: work.archive.recommended,
                  reason,
                  waitingOn: work.waits[0]?.reason ?? null,
                }
              : null;

          const headline =
            hidden || work === null || work.archive.eligible ? reason : work.primary.reason.text;

          const ownTurn =
            threadId === ctx.threadId &&
            work?.activity.some(({ kind }) => kind === "turn") === true;

          return reply(
            {
              threadId,
              ready,
              verdict,
              caveats: notes,
              blockers: work?.archive.eligible ? [] : [{ code: "work", text: reason }],
              work,
            },
            [
              `${threadTitle(thread)} [${threadId}]`,
              `  ${ready ? "Ready to archive" : "Not ready to archive"}: ${headline}`,
              ...workNotes
                .filter((note) => note.text !== headline && note.code !== "archive-ineligible")
                .map((note) => `  - ${note.text}`),
              ...(ownTurn
                ? [
                    "  This check ran inside this chat's own turn, which counts as working until it ends.",
                  ]
                : []),
              ...(work === null || ready
                ? []
                : [
                    `  Completion assessment: ${work.assessment.availability}. ${work.assessment.reason}`,
                  ]),
              ...(workspaceNotes.length === 0
                ? []
                : [
                    "  Workspace notes (advisory; they never block readiness and may belong to other chats):",
                    ...workspaceNotes.map((note) => `  - ${note.text}`),
                  ]),
            ].join("\n"),
          );
        }

        return { exitCode: 1, stderr: usage };
      } catch (cause) {
        return { exitCode: 1, stderr: errorText(cause) };
      }
    },
  });

  function withdrawProposals(threadId: string): void {
    void proposals
      .withdrawSource(threadId)
      .catch((cause) => api.log.warn(`archive approval withdrawal failed: ${errorText(cause)}`));
  }

  api.events.on("thread.deleted", ({ thread }) => {
    forgetDismissal(thread.id);
    withdrawProposals(thread.id);
  });
  api.events.on("thread.archived", ({ thread }) => {
    forgetDismissal(thread.id);
    withdrawProposals(thread.id);
  });

  api.background.service("readiness", {
    async start(signal) {
      const stopChanges = api.sdk.subscribe({
        event: "thread:changed",
        callback: ({ id, changes }) => {
          if (
            !changes.some((change) =>
              [
                "work-changed",
                "status-changed",
                "queue-changed",
                "interactions-changed",
                "thread-created",
                "thread-deleted",
                "archived-changed",
                "shelf-state-changed",
                "parent-changed",
              ].includes(change),
            )
          )
            return;

          if (id === undefined) needsFullRead = true;
          else changedIds.add(id);
          requestRefresh();
        },
      });

      const fullRead = setInterval(() => {
        needsFullRead = true;
        requestRefresh();
      }, FULL_READ_MS);

      fullRead.unref?.();

      const stopConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: ({ state }) => {
          if (state === "connected") {
            needsFullRead = true;
            requestRefresh();
          }
        },
      });

      try {
        try {
          await refresh();
          reconcileProposals();
        } catch {
          api.log.warn(
            "The initial shared work summary could not be read; reconnect or a work change will retry.",
          );
        }

        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        clearInterval(fullRead);
        stopChanges();
        stopConnection();
      }
    },
  });
  api.onDispose(() => {
    disposed = true;
    proposals.dispose();

    if (retryTimer !== null) clearTimeout(retryTimer);

    for (const resolve of fullReadWaiters.splice(0)) resolve();
  });
}
