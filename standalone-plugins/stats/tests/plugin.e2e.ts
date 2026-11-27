import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { reportSchema, summarySchema, type Counters, type ReportInput } from "../contract.ts";
import plugin from "../server.ts";

// Authoring gate: the public plugin RPC, event, and persistent SQLite boundary
// owns these independent accounting/lifecycle contracts. A replay, cumulative
// reset, fork, cache normalization, retention sweep, or stalled history read can
// change the user's totals. No existing Stats coverage or production test seam
// exists. Expected counters below are hand-calculated from provider fixtures.
const failureScenarios = [
  "Archived/hidden chats disappear from inventory and lifetime accounting",
  "Duplicate usage snapshots, replayed events, refresh, or reload double totals",
  "Reset/session changes subtract work or mistake inherited counters for work",
  "Claude extra cache and Codex cache subsets inflate reported total tokens",
  "Reasoning output is added twice to the generated-token headline",
  "Nested background usage is counted again on top of parent provider usage",
  "Archived or deleted chats erase already collected metrics",
  "Copied fork turns inflate turn counts or concurrency before child creation",
  "Fast, Normal, and Ultrafast collapse into one model cohort",
  "All-chat five-minute throughput averages rates instead of output/300 seconds",
  "Overlapping tools are subtracted twice from estimated model time",
  "UI/RPC reads replay history instead of querying the local index",
  "Source history failures render old totals as complete fresh history",
  "Unbounded breakdowns or timeseries make large histories expensive",
  "Prompt, reply, tool, or credential fields persist in the statistics database",
  "Interleaved native counters sharing a session inflate totals or drop child work",
  "Missing optional cache counters reset unrelated input/output/total baselines",
  "Claude session-wide cumulative usage is counted again as an independent nested stream",
  "Codex turns without a surviving native parent link are mistaken for one main counter",
  "Old native stream/scope eviction re-adds repeated token snapshots after restart",
  "Repeated inventory refresh discards active-agent time since the last heartbeat",
  "Source 404 drops unflushed agent time, leaves stale active groups, or retains its prior read error",
  "Model throughput history averages individual rates or fabricates speed in buckets without measured turns",
  "User forks are mislabeled as agent-controlled chats because copied parent metadata survives",
  "Editable parent-only grouping labels a user-reparented root as agent-controlled without public creation provenance",
  "Unresolved relationship provenance scans source history on every startup/refresh instead of retaining the bounded probe result",
  "A failed provenance-only read hides its error, stalls token ingestion, or retries continuously without explicit refresh",
  "Delayed positive creation provenance cannot resolve a retained Unknown role without rescanning source history",
  "Omnyo child chats or provider-native children collapse into main execution, or add canonical tokens twice",
  "Missing public relationship or execution provenance is fabricated as a known main/subagent role",
  "Legacy cohort migration resets counters/cursors, changes shipped migration hashes, or guesses mixed execution roles",
  "Role intersections with model/provider/effort/machine change global conservation or lose archived/deleted work",
  "Facet distributions use the current page instead of the complete filtered range, or omit the explicit Other remainder",
];

type EventRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number];

type EventPayload = {
  [K in EventRow["type"]]: Pick<Extract<EventRow, { type: K }>, "type" | "data">;
}[EventRow["type"]];

type ThreadRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

type Breakdown = Extract<
  EventRow,
  { type: "thread/tokenUsage/updated" }
>["data"]["tokenUsage"]["last"];

const startedAt = Date.now();

const realNow = Date.now;

const base = startedAt - 120_000;

const old = startedAt - 400 * 86_400_000;

const privateMarker = "PRIVATE_TRANSCRIPT_CONTENT_MUST_NOT_PERSIST";

const rows = new Map<string, EventRow[]>();

const sequences = new Map<string, number>();

const historyReads: { thread: string; after: number; limit: number; ids: string[] }[] = [];

const roleProbeReads: string[] = [];

const failRoleProbes = new Set<string>();

let sourceFailure = false;

let inventoryOnlyActive = false;

let gammaSource: "ok" | "error" | "missing" = "ok";

let readGate: { thread: string; reached: () => void; release: Promise<void> } | null = null;

function append(
  threadId: string,
  at: number,
  turnId: string | null,
  payload: EventPayload,
): EventRow {
  const seq = (sequences.get(threadId) ?? 0) + 1;
  sequences.set(threadId, seq);

  const row = {
    ...payload,
    id: `${threadId}-${seq}`,
    threadId,
    seq,
    createdAt: at,
    scope: turnId === null ? { kind: "thread" as const } : { kind: "turn" as const, turnId },
  };

  const threadRows = rows.get(threadId) ?? [];
  threadRows.push(row);
  rows.set(threadId, threadRows);

  return row;
}

function counter(
  input: number,
  output: number,
  total = input + output,
  cached = 0,
  read = cached,
  write = 0,
  reasoning = 0,
): Breakdown {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: cached,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    reasoningOutputTokens: reasoning,
  };
}

function begin(
  thread: string,
  turn: string,
  at: number,
  model: string,
  effort: "low" | "max" | "xhigh",
  mode: string,
): void {
  append(thread, at, null, {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId: `request-${turn}`,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: privateMarker, mentions: [] }],
      request: { method: "turn/start", params: {} },
      target: { kind: "new-turn" },
      execution: {
        model,
        reasoningLevel: effort,
        serviceTier: mode,
        permissionMode: "full",
        source: "client/turn/requested",
      },
    },
  });
  append(thread, at, turn, {
    type: "turn/started",
    data: { providerThreadId: `session-${thread}` },
  });
  append(thread, at + 1, turn, {
    type: "turn/input/accepted",
    data: { providerThreadId: `session-${thread}`, clientRequestId: `request-${turn}` },
  });
}

function creation(thread: string, at: number, senderThreadId: string | null, spawn = true): void {
  append(thread, at, null, {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId: `creation-${thread}-${spawn ? "spawn" : "tell"}`,
      source: spawn ? "spawn" : "tell",
      initiator: senderThreadId ? "agent" : "user",
      senderThreadId,
      input: [{ type: "text", text: privateMarker, mentions: [] }],
      request: { method: spawn ? "thread/start" : "turn/start", params: {} },
      target: { kind: spawn ? "thread-start" : "new-turn" },
      execution: {
        model: "model-a",
        reasoningLevel: "low",
        serviceTier: "default",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    },
  });
}

function usage(thread: string, turn: string, at: number, total: Breakdown, last: Breakdown): void {
  append(thread, at, turn, {
    type: "thread/tokenUsage/updated",
    data: {
      providerThreadId: `session-${thread}`,
      tokenUsage: { total, last, modelContextWindow: null },
    },
  });
}

function complete(thread: string, turn: string, at: number, failed = false): void {
  append(thread, at, turn, {
    type: "turn/completed",
    data: { providerThreadId: `session-${thread}`, status: failed ? "failed" : "completed" },
  });
}

function tool(thread: string, turn: string, at: number, id: string, done: boolean): void {
  append(thread, at, turn, {
    type: done ? "item/completed" : "item/started",
    data: {
      providerThreadId: `session-${thread}`,
      item: {
        type: "toolCall",
        id,
        server: "fixture",
        tool: "work",
        arguments: { text: privateMarker },
        status: done ? "completed" : "pending",
      },
    },
  });
}

begin("alpha", "first", base, "model-a", "low", "default");

tool("alpha", "first", base + 2_000, "tool-a", false);

tool("alpha", "first", base + 5_000, "tool-b", false);

tool("alpha", "first", base + 8_000, "tool-a", true);

tool("alpha", "first", base + 12_000, "tool-b", true);

usage(
  "alpha",
  "first",
  base + 15_000,
  counter(100, 50, 150, 20, 20, 0, 10),
  counter(100, 50, 150, 20, 20, 0, 10),
);

usage(
  "alpha",
  "first",
  base + 15_001,
  counter(100, 50, 150, 20, 20, 0, 10),
  counter(100, 50, 150, 20, 20, 0, 10),
);

usage(
  "alpha",
  "first",
  base + 19_000,
  counter(200, 110, 310, 30, 30, 0, 20),
  counter(100, 60, 160, 10, 10, 0, 10),
);

complete("alpha", "first", base + 20_000);

begin("alpha", "reset", base + 30_000, "model-a", "xhigh", "ultrafast");

usage(
  "alpha",
  "reset",
  base + 39_000,
  counter(30, 20, 50, 0, 0, 0, 3),
  counter(30, 20, 50, 0, 0, 0, 3),
);

complete("alpha", "reset", base + 40_000);

begin("alpha", "failed", base + 45_000, "model-a", "xhigh", "ultrafast");

usage(
  "alpha",
  "failed",
  base + 49_000,
  counter(40, 25, 65, 0, 0, 0, 4),
  counter(10, 5, 15, 0, 0, 0, 1),
);

complete("alpha", "failed", base + 50_000, true);

begin("beta", "claude", base + 10_000, "model-b", "max", "fast");

usage(
  "beta",
  "claude",
  base + 19_000,
  counter(10, 30, 85, 45, 40, 5),
  counter(10, 30, 85, 45, 40, 5),
);

complete("beta", "claude", base + 20_000);

begin("old", "historic", old, "model-legacy", "low", "default");

usage("old", "historic", old + 9_000, counter(11, 9), counter(11, 9));

complete("old", "historic", old + 10_000);

// Fork conversation events are copied with original timestamps. Its first real
// usage includes an inherited provider counter but only 15 new output tokens.
begin("fork", "inherited", base, "model-a", "low", "default");

complete("fork", "inherited", base + 20_000);

begin("fork", "fresh", base + 70_000, "model-a", "low", "default");

usage("fork", "fresh", base + 79_000, counter(900, 300), counter(30, 15));

complete("fork", "fresh", base + 80_000);

// Native task totals may overlap the provider's parent totals. They are useful
// supplementary metadata and must not add 1000 tokens to canonical totals.
append("delta", base + 90_000, null, {
  type: "item/backgroundTask/progress",
  data: {
    providerThreadId: "session-delta",
    item: {
      type: "backgroundTask",
      id: "native",
      taskType: "local_subagent",
      description: privateMarker,
      status: "pending",
      taskStatus: "running",
      skipTranscript: true,
      usage: { totalTokens: 1000, toolUses: 3, durationMs: 5000 },
    },
  },
});

// An agent can send a normal message to a user-owned or grouped chat. That is
// not creation provenance and must not turn editable parent metadata into ownership.
creation("gamma", base + 86_000, "delta", false);

const threads: ThreadRow[] = [
  makeThreadResponse({
    id: "alpha",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Alpha",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  }),
  makeThreadResponse({
    id: "beta",
    projectId: "project-two",
    environmentId: "env-two",
    providerId: "claude-code",
    title: "Beta",
    visibility: "hidden",
    archivedAt: startedAt - 10_000,
    createdAt: base - 60_000,
    updatedAt: base + 20_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  }),
  makeThreadResponse({
    id: "old",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Historic",
    archivedAt: old + 20_000,
    createdAt: old - 10_000,
    updatedAt: old + 10_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  }),
  makeThreadResponse({
    id: "fork",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Fork",
    sourceThreadId: "alpha",
    originKind: "fork",
    createdAt: base + 50_000,
    updatedAt: base + 80_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  }),
  makeThreadResponse({
    id: "gamma",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Child",
    parentThreadId: "delta",
    createdAt: base + 85_000,
    updatedAt: base + 90_000,
    status: "active",
    runtime: { displayStatus: "active" },
  }),
  makeThreadResponse({
    id: "delta",
    projectId: "project-two",
    environmentId: "env-two",
    providerId: "claude-code",
    title: "Root",
    createdAt: base + 85_000,
    updatedAt: base + 90_000,
    status: "active",
    runtime: { displayStatus: "active" },
    activeBackgroundAgentCount: 2,
  }),
];

const host = createFakePluginHost({
  pluginId: "stats",
  sdk: {
    threads: {
      list: async (args = {}) =>
        threads
          .filter(
            (thread) =>
              thread.deletedAt === null && (thread.archivedAt !== null) === Boolean(args.archived),
          )
          .filter((thread) => !inventoryOnlyActive || thread.status === "active")
          .filter((thread) => thread.id !== "gamma" || gammaSource !== "missing")
          .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)),
      get: async ({ threadId }) => {
        if (threadId === "gamma" && gammaSource === "missing")
          throw Object.assign(new Error("thread missing"), { status: 404 });
        const found = threads.find((thread) => thread.id === threadId && thread.deletedAt === null);

        if (!found) throw Object.assign(new Error("thread missing"), { status: 404 });

        return found;
      },
      events: {
        list: async (args) => {
          if (Number(args.limit) === 1 && args.types?.includes("client/turn/requested")) {
            roleProbeReads.push(args.threadId);

            if (failRoleProbes.has(args.threadId))
              throw new Error("synthetic provenance read failure");
          }

          if (args.threadId === "gamma" && gammaSource === "error")
            throw new Error("synthetic active source failure");

          if (args.threadId === "gamma" && gammaSource === "missing")
            throw Object.assign(new Error("thread missing"), { status: 404 });

          if (sourceFailure && args.threadId === "beta")
            throw new Error("synthetic source read failure");

          if (threads.find((thread) => thread.id === args.threadId)?.deletedAt !== null)
            throw Object.assign(new Error("thread deleted"), { status: 404 });

          if (readGate?.thread === args.threadId) {
            const gate = readGate;
            readGate = null;
            gate.reached();
            await gate.release;
          }

          const limit = Number(args.limit ?? 100);
          assert.ok(limit <= 100, "collector must respect the source page bound");

          let selected = (rows.get(args.threadId) ?? []).filter(
            (row) =>
              (!args.types || args.types.includes(row.type)) &&
              row.seq > Number(args.afterSeq ?? 0) &&
              row.seq < Number(args.beforeSeq ?? Infinity),
          );

          if (args.order === "desc") selected = selected.slice().reverse();
          selected = selected.slice(0, limit);
          historyReads.push({
            thread: args.threadId,
            after: Number(args.afterSeq ?? 0),
            limit,
            ids: selected.map((row) => row.id),
          });

          return selected;
        },
      },
    },
    environments: {
      list: async () => [
        { id: "env-one", hostId: "machine-one", projectId: "project-one", path: "/fixture/one" },
        { id: "env-two", hostId: "machine-two", projectId: "project-two", path: "/fixture/two" },
      ],
      get: async ({ environmentId }) => ({
        id: environmentId,
        hostId: environmentId === "env-one" ? "machine-one" : "machine-two",
        projectId: environmentId === "env-one" ? "project-one" : "project-two",
        path: "/fixture",
      }),
    },
    projects: {
      list: async () => [
        { id: "project-one", name: "First project" },
        { id: "project-two", name: "Second project" },
      ],
      get: async ({ projectId }) => ({
        id: projectId,
        name: projectId === "project-one" ? "First project" : "Second project",
      }),
    },
    hosts: {
      list: async () => [
        { id: "machine-one", name: "Machine One" },
        { id: "machine-two", name: "Machine Two" },
      ],
      get: async ({ hostId }) => ({
        id: hostId,
        name: hostId === "machine-one" ? "Machine One" : "Machine Two",
      }),
    },
    plugins: {
      list: async () => ({ plugins: [{ id: "account-pool", enabled: true, status: "running" }] }),
      callRpc: async () => ({
        accounts: [
          {
            id: "account-one",
            label: "Fixture account",
            email: "private-email-must-not-persist@example.invalid",
            provider: "codex",
          },
        ],
        accepting: true,
        inFlight: 2,
        enabledAccountCount: 1,
        routing: { claude: true, codex: true },
      }),
    },
  },
});

let current = host;

let service: ReturnType<typeof host.harness.behavior.runService> | null = null;

const checkpoints: string[] = [];

async function legacyMigrationAcceptance() {
  const fixture = z
    .object({
      schema: z.array(z.object({ name: z.string(), sql: z.string() })),
      migrations: z.array(
        z.object({ id: z.number(), applied_at: z.number(), statement_hash: z.string() }),
      ),
    })
    .parse(
      JSON.parse(await readFile(new URL("./fixtures/legacy-v1.json", import.meta.url), "utf8")),
    );

  type DailyRow = Counters & { at: number; cohortId: number; observedMs: number; peak: number };

  const legacyThreads = [
    makeThreadResponse({
      id: "legacy-main",
      projectId: "project-one",
      environmentId: "env-one",
      providerId: "codex",
      status: "idle",
      runtime: { displayStatus: "idle" },
    }),
    makeThreadResponse({
      id: "legacy-child",
      parentThreadId: "legacy-main",
      lifecycleOwnerThreadId: "legacy-main",
      projectId: "project-one",
      environmentId: "env-one",
      providerId: "codex",
      archivedAt: base,
      status: "idle",
      runtime: { displayStatus: "idle" },
    }),
    makeThreadResponse({
      id: "legacy-fork",
      parentThreadId: "legacy-main",
      sourceThreadId: "legacy-main",
      originKind: "fork",
      lifecycleOwnerThreadId: null,
      projectId: "project-one",
      environmentId: "env-one",
      providerId: "codex",
      status: "idle",
      runtime: { displayStatus: "idle" },
    }),
  ];

  let legacy = createFakePluginHost({
    pluginId: "stats",
    sdk: {
      threads: {
        list: async (args = {}) =>
          legacyThreads.filter((thread) => (thread.archivedAt !== null) === Boolean(args.archived)),
        get: async ({ threadId }) => {
          const thread = legacyThreads.find((value) => value.id === threadId);

          if (!thread) throw Object.assign(new Error("legacy source gone"), { status: 404 });

          return thread;
        },
        events: { list: async () => [] },
      },
      environments: {
        list: async () => [
          { id: "env-one", hostId: "machine-one", projectId: "project-one", path: "/fixture" },
        ],
      },
      projects: { list: async () => [{ id: "project-one", name: "First project" }] },
      hosts: { list: async () => [{ id: "machine-one", name: "Machine One" }] },
      plugins: {
        list: async () => ({ plugins: [] }),
        callRpc: async () => {
          throw new Error("Account Pooler is not installed.");
        },
      },
    },
  });

  let legacyService: ReturnType<typeof legacy.harness.behavior.runService> | null = null;

  try {
    const db = legacy.api.storage.database();

    for (const entry of fixture.schema) db.exec(entry.sql);

    const insertMigration = db.prepare<[number, number, string]>(
      "INSERT INTO _bb_migrations(id,applied_at,statement_hash) VALUES(?,?,?)",
    );

    for (const entry of fixture.migrations)
      insertMigration.run(entry.id, entry.applied_at, entry.statement_hash);
    db.exec(
      "INSERT INTO cohorts VALUES(0,'__global','__global','__global','__global','__global','__global','__global','__global')",
    );
    const outputs = [100, 60, 20, 10, 5];

    const chatIds = [
      "legacy-main",
      "legacy-child",
      "legacy-fork",
      "legacy-deleted",
      "legacy-unavailable",
    ];

    const insertCohort = db.prepare<[number, string]>(
      "INSERT INTO cohorts VALUES(?,'machine-one','project-one',?,'codex','legacy-model','max','fast','')",
    );

    const insertChat = db.prepare<[string, string, number, number]>(
      "INSERT INTO chats VALUES(?,?,'Machine One','First project',?,?)",
    );

    for (let index = 0; index < chatIds.length; index++) {
      insertCohort.run(index + 1, chatIds[index]);
      insertChat.run(chatIds[index], chatIds[index], index === 3 ? 1 : 0, index === 1 ? 1 : 0);
      db.prepare("INSERT INTO cursors(threadId,seq,complete) VALUES(?,40,1)").run(chatIds[index]);
    }

    const globalOutput = 195;

    for (const [id, output] of [globalOutput, ...outputs].entries()) {
      db.prepare("INSERT INTO totals(cohortId,input,output,total) VALUES(?,?,?,?)").run(
        id,
        output * 10,
        output,
        output * 11,
      );

      for (const [table, at] of [
        ["minute_buckets", Math.floor(base / 60000) * 60000],
        ["daily_buckets", Math.floor(base / 86400000) * 86400000],
      ] as const)
        db.prepare(`INSERT INTO ${table}(at,cohortId,input,output,total) VALUES(?,?,?,?,?)`).run(
          at,
          id,
          output * 10,
          output,
          output * 11,
        );

      if (id > 0)
        db.prepare("INSERT INTO observations(at,cohortId,output) VALUES(?,?,?)").run(
          base,
          id,
          output,
        );
    }

    db.prepare(
      "INSERT INTO speed_samples(id,at,cohortId,output,modelMs) VALUES('legacy-speed',?,1,100,10000)",
    ).run(base);
    db.exec("INSERT INTO stream_baselines VALUES('legacy-main','old-main',1000,100,1100,0,0,0,0)");
    db.prepare(
      "INSERT INTO turn_scopes VALUES('legacy-main','old-child','native:old-child',1,?,'old-session')",
    ).run(base);

    const retained = {
      totals: db.prepare("SELECT * FROM totals ORDER BY cohortId").all(),
      daily: db
        .prepare<[], DailyRow>("SELECT * FROM daily_buckets ORDER BY cohortId")
        .all()
        .map(({ observedMs: _observedMs, ...entry }) => entry),
      streams: db.prepare("SELECT * FROM stream_baselines").all(),
      scopes: db.prepare("SELECT * FROM turn_scopes").all(),
      speeds: db.prepare("SELECT * FROM speed_samples").all(),
    };

    await plugin(legacy.api);
    legacyService = legacy.harness.behavior.runService("collector");

    const get = async (input: Partial<ReportInput> = {}) =>
      reportSchema.parse(
        await legacy.harness.behavior.callRpc("report", { range: "all", ...input }),
      );

    const ready = async () => {
      const deadline = performance.now() + 15000;

      while ((await get()).health.indexing || !(await get()).summary.liveReady) {
        if (performance.now() > deadline)
          throw new Error("legacy migration inventory did not settle");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    };

    await ready();
    const control = await get({ groupBy: "chatRole" });
    assert.match(control.health.accountState, /Account Pooler is not enabled/);
    assert.deepEqual(control.health.accounts, []);
    assert.equal(control.counters.output, globalOutput);
    assert.equal(control.summary.allTime.total, 2145);
    assert.equal(control.groups.find((group) => group.key === "main")?.counters.output, 120);
    assert.equal(control.groups.find((group) => group.key === "subagent")?.counters.output, 60);
    assert.equal(control.groups.find((group) => group.key === "unknown")?.counters.output, 15);
    const execution = await get({ groupBy: "agentRole" });
    assert.equal(
      execution.groups.find((group) => group.key === "unknown")?.counters.output,
      globalOutput,
    );
    assert.equal(
      (
        await get({
          filters: {
            chatRole: "subagent",
            agentRole: "unknown",
            model: "legacy-model",
            provider: "codex",
            machine: "machine-one",
            effort: "max",
          },
        })
      ).counters.output,
      60,
    );
    assert.equal(
      (await get({ filters: { chat: "legacy-fork", chatRole: "main" } })).counters.output,
      20,
    );
    assert.deepEqual(db.prepare("SELECT * FROM totals ORDER BY cohortId").all(), retained.totals);
    assert.deepEqual(
      db
        .prepare<[], DailyRow>("SELECT * FROM daily_buckets ORDER BY cohortId")
        .all()
        .map(({ observedMs: _observedMs, ...entry }) => entry),
      retained.daily,
    );
    assert.deepEqual(db.prepare("SELECT * FROM stream_baselines").all(), retained.streams);
    assert.deepEqual(db.prepare("SELECT * FROM turn_scopes").all(), retained.scopes);
    assert.deepEqual(db.prepare("SELECT * FROM speed_samples").all(), retained.speeds);
    assert.ok(
      db
        .prepare<[], { seq: number }>("SELECT seq FROM cursors")
        .all()
        .every((cursor) => cursor.seq === 40),
    );
    assert.ok(
      (await get({ groupBy: "chat" })).groups.find((group) => group.key === "legacy-deleted")
        ?.deleted,
    );
    legacyService.controller.abort();
    await legacyService.done;
    legacyService = null;
    legacy = await legacy.harness.lifecycle.reload(plugin);
    legacyService = legacy.harness.behavior.runService("collector");
    await ready();
    const afterReload = await get({ groupBy: "chatRole" });
    assert.equal(afterReload.counters.output, globalOutput);
    assert.equal(afterReload.groups.find((group) => group.key === "subagent")?.counters.output, 60);
    assert.equal(
      (await get({ groupBy: "agentRole" })).groups.find((group) => group.key === "unknown")
        ?.counters.output,
      globalOutput,
    );

    return {
      globalOutput,
      total: 2145,
      mainOutput: 120,
      subagentOutput: 60,
      unknownChatOutput: 15,
      unknownLegacyExecution: globalOutput,
      originalMigrationCount: fixture.migrations.length,
      preserved: [
        "totals",
        "daily buckets",
        "streams",
        "scopes",
        "speed samples",
        "cursor sequences",
      ],
    };
  } finally {
    legacyService?.controller.abort();
    await legacyService?.done;
    await legacy.harness.lifecycle.dispose();
  }
}

async function report(
  input: {
    range?: "day" | "all";
    groupBy?:
      | "provider"
      | "mode"
      | "chat"
      | "machine"
      | "project"
      | "model"
      | "effort"
      | "account"
      | "chatRole"
      | "agentRole";
    filters?: Record<string, string>;
    offset?: number;
    limit?: number;
  } = {},
) {
  return reportSchema.parse(await current.harness.behavior.callRpc("report", input));
}

async function settle(): Promise<void> {
  const deadline = performance.now() + 15_000;

  for (;;) {
    const value = await report();

    if (
      !value.health.indexing &&
      value.health.queueDepth === 0 &&
      value.health.backfillPending === 0 &&
      value.summary.liveReady
    )
      return;

    if (performance.now() >= deadline)
      throw new Error(`collector failed to settle: ${JSON.stringify(value.health)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  const migrationProof = await legacyMigrationAcceptance();
  checkpoints.push(
    "shipped v1 migration preserves counters and ledgers, classifies current Omnyo controllers, and keeps old mixed execution Unknown through reload",
  );
  await plugin(current.api);
  service = current.harness.behavior.runService("collector");
  await settle();
  let value = await report({ range: "all", groupBy: "provider" });
  assert.equal(value.counters.output, 189);
  assert.equal(value.counters.input, 291);
  assert.equal(value.counters.total, 525);
  assert.equal(value.counters.cached, 75);
  assert.equal(value.counters.cacheRead, 70);
  assert.equal(value.counters.cacheWrite, 5);
  assert.equal(value.counters.reasoning, 24);
  assert.equal(value.summary.allTime.output, 189);
  assert.equal(value.summary.output5m, 180);
  assert.equal(value.summary.tps5m, 180 / 300);
  assert.equal(value.summary.activeChats, 2);
  assert.equal(value.summary.nestedAgents, 2);
  assert.equal(value.summary.running, 4);
  assert.ok(value.series.length <= 600);
  assert.ok(value.groups.length <= 50);
  assert.equal(value.groups.find((group) => group.key === "claude-code")?.counters.total, 85);
  assert.equal(value.groups.find((group) => group.key === "codex")?.counters.total, 440);
  checkpoints.push(
    "provider counters, archived/hidden history, five-minute throughput, and reported native concurrency",
  );

  const initialRoles = await report({ range: "all", groupBy: "chatRole" });
  assert.equal(initialRoles.groups.find((group) => group.key === "main")?.counters.output, 189);
  assert.equal(initialRoles.summary.mainChats, 1);
  assert.equal(initialRoles.summary.subagentChats, 0);
  assert.equal(initialRoles.summary.unknownChats, 1);
  const initialScopes = await report({ range: "all", groupBy: "agentRole" });
  assert.equal(initialScopes.groups.find((group) => group.key === "main")?.counters.output, 189);
  assert.equal(initialScopes.groups.find((group) => group.key === "subagent")?.active, 2);
  assert.equal(initialScopes.groups.find((group) => group.key === "unknown")?.active, 1);

  const gammaProbes = historyReads.filter(
    (read) => read.thread === "gamma" && read.limit === 1,
  ).length;

  assert.equal(gammaProbes, 1);
  checkpoints.push(
    "Omnyo chat controllers and native execution agents split live concurrency without duplicating totals",
  );

  const modes = await report({ range: "all", groupBy: "mode" });
  assert.equal(modes.groups.find((group) => group.key === "ultrafast")?.counters.output, 25);
  assert.equal(modes.groups.find((group) => group.key === "fast")?.counters.output, 30);

  const normal = modes.speeds.find(
    (speed) => speed.model === "model-a" && speed.mode === "default",
  );

  assert.ok(normal);
  assert.ok(normal.modelTps !== null);
  assert.equal(normal.counters.speedOutput, 110);
  assert.equal(normal.counters.modelMs, 10_000);
  assert.equal(normal.modelTps, 11);
  assert.equal(normal.medianTps, 11);
  assert.equal(normal.medianSampleCount, 1);
  const legacy = modes.speeds.find((speed) => speed.model === "model-legacy");
  assert.equal(legacy?.counters.measuredTurns, 1);
  assert.equal(legacy?.medianTps, null);
  assert.equal(legacy?.medianSampleCount, 0);
  const fork = await report({ range: "all", groupBy: "chat", filters: { chat: "fork" } });
  assert.equal(fork.counters.output, 15);
  assert.equal(fork.counters.turns, 1);
  assert.equal(fork.counters.total, 45);
  checkpoints.push("mode/effort cohorts, overlapping tools, and inherited fork baseline exclusion");

  const measuredSamples = [
    { at: base + 20_000, output: 110, ms: 10_000, model: "model-a", mode: "default" },
    { at: base + 40_000, output: 20, ms: 10_000, model: "model-a", mode: "ultrafast" },
    { at: base + 20_000, output: 30, ms: 10_000, model: "model-b", mode: "fast" },
    { at: old + 10_000, output: 9, ms: 10_000, model: "model-legacy", mode: "default" },
  ];

  for (const [range, filters] of [
    ["day", {}],
    ["all", {}],
    ["day", { model: "model-a", mode: "default" }],
  ] as const) {
    const timeline = await report({ range, filters });
    const width = timeline.resolutionSeconds * 1000;

    for (const point of timeline.series) {
      const samples = measuredSamples.filter(
        (sample) =>
          sample.at >= timeline.from &&
          sample.at <= timeline.to &&
          (!("model" in filters) || sample.model === filters.model) &&
          (!("mode" in filters) || sample.mode === filters.mode) &&
          Math.floor((Math.floor(sample.at / 60_000) * 60_000) / width) * width === point.at,
      );

      const expected = samples.length
        ? (samples.reduce((sum, sample) => sum + sample.output, 0) * 1000) /
          samples.reduce((sum, sample) => sum + sample.ms, 0)
        : null;

      assert.equal(point.modelTps, expected);
    }

    assert.ok(timeline.series.length <= 600);
    assert.ok(timeline.series.some((point) => point.modelTps !== null));
  }

  assert.ok(fork.series.every((point) => point.modelTps === null));
  checkpoints.push(
    "model speed timeline pools output/time within each filtered bucket and leaves unmeasured buckets unavailable",
  );

  const readsBeforeReports = historyReads.length;

  for (const dimension of [
    "machine",
    "project",
    "chat",
    "provider",
    "model",
    "effort",
    "mode",
    "account",
    "chatRole",
    "agentRole",
  ] as const) {
    const page = await report({ range: "all", groupBy: dimension, limit: 1 });
    assert.ok(page.groups.length <= 1);
    assert.equal(page.counters.output, 189);

    if (page.groupCount > 1) assert.equal(page.nextOffset, 1);
  }

  assert.equal(historyReads.length, readsBeforeReports, "reports must remain cache-only");
  const storedDb = current.api.storage.database();

  const tables = storedDb
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();

  for (const table of tables) {
    const persisted = JSON.stringify(
      storedDb.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
    );

    assert.ok(!persisted.includes(privateMarker), `private transcript leaked into ${table.name}`);
    assert.ok(
      !persisted.includes("private-email-must-not-persist"),
      `account email leaked into ${table.name}`,
    );
  }

  checkpoints.push(
    "bounded pagination, all ten dimensions, cache-only reports, and numeric-only storage",
  );

  const { agentMs: activeTimeBeforeRefresh, ...unchanged } = value.summary.allTime;
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const { agentMs: activeTimeAfterRefresh, ...afterRefresh } = (await report({ range: "all" }))
    .summary.allTime;

  assert.deepEqual(afterRefresh, unchanged);
  assert.ok(activeTimeAfterRefresh >= activeTimeBeforeRefresh);
  service.controller.abort();
  await service.done;
  service = null;
  current = await current.harness.lifecycle.reload(plugin);
  service = current.harness.behavior.runService("collector");
  await settle();

  const { agentMs: activeTimeAfterReload, ...afterReload } = (await report({ range: "all" }))
    .summary.allTime;

  assert.deepEqual(afterReload, unchanged);
  assert.ok(activeTimeAfterReload >= activeTimeAfterRefresh);
  assert.equal(
    historyReads.filter((read) => read.thread === "gamma" && read.limit === 1).length,
    gammaProbes,
  );
  assert.equal(
    (await report({ range: "all", filters: { chatRole: "main", agentRole: "main" } })).counters
      .output,
    189,
  );
  checkpoints.push("refresh and real SQLite reload preserve totals without replays");

  const alpha = threads.find((thread) => thread.id === "alpha");
  assert.ok(alpha);
  alpha.deletedAt = Date.now();
  await current.harness.behavior.emitThreadEvent("thread.deleted", { thread: alpha });
  await settle();
  await current.harness.behavior.callRpc("refresh", null);
  await settle();
  value = await report({ range: "all", groupBy: "chat" });
  assert.equal(value.summary.allTime.output, 189);
  assert.equal(value.counters.output, 189);
  assert.equal(value.groups.find((group) => group.key === "alpha")?.deleted, true);
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chatRole: "main", agentRole: "main", chat: "alpha" },
      })
    ).counters.output,
    135,
  );
  checkpoints.push("deleted source chat remains in lifetime totals and historical chat breakdown");

  const beta = threads.find((thread) => thread.id === "beta");
  assert.ok(beta);
  beta.updatedAt = Date.now();
  sourceFailure = true;
  await current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: beta,
    sequence: (sequences.get("beta") ?? 0) + 1,
  });
  const failureDeadline = Date.now() + 5_000;

  for (;;) {
    value = await report({ range: "all" });

    if (value.health.error) break;

    if (Date.now() > failureDeadline) throw new Error("history failure was not visible in health");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(value.summary.allTime.output, 189);
  sourceFailure = false;
  await current.harness.behavior.callRpc("refresh", null);
  await settle();
  const summary = summarySchema.parse(await current.harness.behavior.callRpc("summary", null));
  assert.equal(summary.allTime.output, 189);
  checkpoints.push("history failure is visible while collected counters remain durable");

  // Public Codex histories contain distinct native turn streams sharing the
  // normalized parent session. Repeated snapshots may be separated by another
  // child's events, including while the parent's root turn is active.
  const interleaved = makeThreadResponse({
    id: "interleaved",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Interleaved native counters",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(interleaved);
  begin("interleaved", "main-one", base, "model-a", "low", "default");
  usage("interleaved", "main-one", base + 1_000, counter(1000, 100), counter(1000, 100));

  for (const [turnId, parentToolCallId] of [
    ["native-one", "spawn-one"],
    ["native-two", "spawn-two"],
  ]) {
    append("interleaved", base + 2_000, turnId, {
      type: "turn/started",
      data: { providerThreadId: "session-interleaved", parentToolCallId },
    });
  }

  usage("interleaved", "native-one", base + 3_000, counter(300, 30), counter(20, 2));
  usage("interleaved", "native-two", base + 4_000, counter(200, 20), counter(10, 3));
  complete("interleaved", "main-one", base + 5_000);
  usage("interleaved", "native-one", base + 6_000, counter(340, 34), counter(40, 4));
  usage("interleaved", "native-two", base + 7_000, counter(250, 25), counter(50, 5));
  usage("interleaved", "native-one", base + 8_000, counter(340, 34), counter(40, 4));
  usage("interleaved", "native-two", base + 9_000, counter(250, 25), counter(50, 5));
  complete("interleaved", "native-one", base + 10_000);
  complete("interleaved", "native-two", base + 10_000);
  begin("interleaved", "main-two", base + 11_000, "model-a", "low", "default");
  usage("interleaved", "main-two", base + 12_000, counter(1100, 110), counter(100, 10));
  complete("interleaved", "main-two", base + 13_000);

  // Native parent links are not always present in surviving real histories.
  // Only client input acceptance can vouch that a turn owns the main counter.
  for (const turnId of ["unlinked-one", "unlinked-two"]) {
    append("interleaved", base + 14_000, turnId, {
      type: "turn/started",
      data: { providerThreadId: "session-interleaved" },
    });
  }

  usage("interleaved", "unlinked-one", base + 15_000, counter(300, 30), counter(20, 2));
  usage("interleaved", "unlinked-two", base + 16_000, counter(200, 20), counter(10, 3));
  usage("interleaved", "unlinked-one", base + 17_000, counter(340, 34), counter(40, 4));
  usage("interleaved", "unlinked-two", base + 18_000, counter(250, 25), counter(50, 5));
  usage("interleaved", "unlinked-one", base + 19_000, counter(340, 34), counter(40, 4));
  complete("interleaved", "unlinked-one", base + 20_000);
  complete("interleaved", "unlinked-two", base + 20_000);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const streams = await report({ range: "all", filters: { chat: "interleaved" } });

  assert.equal(streams.counters.output, 138);
  assert.equal(streams.counters.input, 1340);
  assert.equal(streams.counters.total, 1478);
  assert.equal(streams.counters.turns, 2, "native turns must not inflate root turn counts");
  assert.equal(streams.counters.unknownBaselines, 4);
  const anonymous = streams.groups.find((group) => group.key === "");

  assert.equal(anonymous?.counters.output, 28, "native execution model must remain unknown");

  const executionRoles = await report({
    range: "all",
    groupBy: "agentRole",
    filters: { chat: "interleaved" },
  });

  assert.equal(executionRoles.groups.find((group) => group.key === "main")?.counters.output, 110);
  assert.equal(
    executionRoles.groups.find((group) => group.key === "subagent")?.counters.output,
    14,
  );
  assert.equal(executionRoles.groups.find((group) => group.key === "unknown")?.counters.output, 14);
  assert.equal(
    executionRoles.groups.reduce((sum, group) => sum + group.counters.output, 0),
    138,
  );
  assert.equal(
    (
      await report({
        range: "all",
        filters: {
          chat: "interleaved",
          agentRole: "main",
          chatRole: "main",
          model: "model-a",
          effort: "low",
          provider: "codex",
          machine: "machine-one",
        },
      })
    ).counters.output,
    110,
  );
  checkpoints.push(
    "interleaved native streams, intervening duplicate snapshots, and parent timing isolation",
  );
  checkpoints.push(
    "main chat execution splits accepted main, native subagent and unvouched Unknown tokens with exact intersections",
  );

  const optional = makeThreadResponse({
    id: "optional-cache",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Optional cache counters",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(optional);
  begin("optional-cache", "cache", base, "model-a", "low", "default");
  usage(
    "optional-cache",
    "cache",
    base + 1_000,
    counter(100, 10, 110, 20),
    counter(100, 10, 110, 20),
  );
  const optionalTotal = counter(200, 20, 220, 30);

  delete optionalTotal.cacheReadInputTokens;
  delete optionalTotal.cacheWriteInputTokens;
  usage("optional-cache", "cache", base + 2_000, optionalTotal, counter(100, 10, 110, 10));
  usage(
    "optional-cache",
    "cache",
    base + 3_000,
    counter(200, 20, 220, 30),
    counter(100, 10, 110, 10),
  );
  complete("optional-cache", "cache", base + 4_000);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const cacheOptional = await report({ range: "all", filters: { chat: "optional-cache" } });

  assert.equal(cacheOptional.counters.output, 20);
  assert.equal(cacheOptional.counters.input, 200);
  assert.equal(cacheOptional.counters.total, 220);
  assert.equal(cacheOptional.counters.cached, 30);
  checkpoints.push("optional cache omission does not replay unrelated counters");

  const claudeGlobal = makeThreadResponse({
    id: "claude-global",
    projectId: "project-two",
    environmentId: "env-two",
    providerId: "claude-code",
    title: "Claude shared cumulative usage",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(claudeGlobal);
  begin("claude-global", "claude-main", base, "model-b", "max", "default");
  usage("claude-global", "claude-main", base + 1_000, counter(100, 10), counter(100, 10));
  append("claude-global", base + 2_000, "claude-nested", {
    type: "turn/started",
    data: { providerThreadId: "session-claude-global", parentToolCallId: "claude-spawn" },
  });
  usage("claude-global", "claude-nested", base + 3_000, counter(120, 12), counter(20, 2));
  usage("claude-global", "claude-main", base + 4_000, counter(200, 20), counter(80, 8));
  usage("claude-global", "claude-nested", base + 5_000, counter(200, 20), counter(80, 8));
  complete("claude-global", "claude-nested", base + 6_000);
  complete("claude-global", "claude-main", base + 7_000);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const claudeSession = await report({ range: "all", filters: { chat: "claude-global" } });

  assert.equal(claudeSession.counters.output, 20);
  assert.equal(claudeSession.counters.input, 200);
  assert.equal(claudeSession.counters.total, 220);
  checkpoints.push("Claude session-global cumulative usage across nested scopes");

  const evicted = makeThreadResponse({
    id: "many-streams",
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Durable native ledger",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(evicted);

  for (let index = 0; index < 140; index++) {
    const turnId = `ledger-${index}`;

    append("many-streams", base + index * 10, turnId, {
      type: "turn/started",
      data: { providerThreadId: "session-many-streams", parentToolCallId: `spawn-${index}` },
    });
    usage(
      "many-streams",
      turnId,
      base + index * 10 + 1,
      counter(1000 + index, 100 + index),
      counter(1, 1),
    );
    complete("many-streams", turnId, base + index * 10 + 2);
  }

  usage("many-streams", "ledger-0", base + 10_000, counter(1000, 100), counter(1, 1));
  usage("many-streams", "ledger-139", base + 11_000, counter(1139, 239), counter(1, 1));
  usage("many-streams", "ledger-0", base + 12_000, counter(1002, 103), counter(2, 3));
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const many = await report({ range: "all", filters: { chat: "many-streams" } });

  assert.equal(many.counters.output, 143);
  assert.equal(many.counters.input, 142);
  assert.equal(many.counters.total, 285);
  assert.equal(many.counters.unknownBaselines, 140);
  service.controller.abort();
  await service.done;
  service = null;
  current = await current.harness.lifecycle.reload(plugin);
  service = current.harness.behavior.runService("collector");
  await settle();
  usage("many-streams", "ledger-0", base + 13_000, counter(1002, 103), counter(2, 3));
  await current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: evicted,
    sequence: sequences.get("many-streams") ?? 0,
  });
  await settle();

  const restartedLedger = await report({ range: "all", filters: { chat: "many-streams" } });

  assert.equal(restartedLedger.counters.output, 143);
  assert.equal(restartedLedger.counters.input, 142);
  assert.equal(restartedLedger.counters.total, 285);
  assert.equal(restartedLedger.counters.unknownBaselines, 140);
  checkpoints.push(
    "140 native streams and scopes preserve replay identity through real SQLite reload",
  );

  const controlledChild = makeThreadResponse({
    id: "controlled-child",
    parentThreadId: "delta",
    lifecycleOwnerThreadId: null,
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    title: "Controlled child",
    createdAt: base - 1000,
    updatedAt: base + 94000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(controlledChild);
  creation(controlledChild.id, base - 500, "delta");
  let childCumulative = 0;

  for (let index = 0; index < 7; index++) {
    const turnId = `controlled-${index}`;
    const at = base + 90000 + index * 500;
    begin(controlledChild.id, turnId, at, `child-model-${index}`, "max", "fast");
    childCumulative += index + 1;
    usage(
      controlledChild.id,
      turnId,
      at + 100,
      counter(childCumulative, childCumulative),
      counter(index + 1, index + 1),
    );
    complete(controlledChild.id, turnId, at + 200);
  }

  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const childPage = await report({
    range: "all",
    groupBy: "model",
    filters: {
      chatRole: "subagent",
      agentRole: "subagent",
      provider: "codex",
      machine: "machine-one",
      effort: "max",
    },
    limit: 1,
  });

  assert.equal(childPage.groups.length, 1);
  assert.equal(childPage.groupCount, 7);
  assert.equal(childPage.counters.output, 28);
  const modelsFacet = childPage.facets.find((facet) => facet.dimension === "model");
  assert.ok(modelsFacet);
  assert.equal(modelsFacet.groups.length, 6);
  assert.equal(modelsFacet.totalGroups, 7);
  assert.equal(modelsFacet.totalOutput, 28);
  assert.equal(modelsFacet.groups.find((group) => group.key === "__other")?.output, 3);
  assert.equal(
    modelsFacet.groups.reduce((sum, group) => sum + group.output, 0),
    28,
  );

  for (const facet of childPage.facets) {
    assert.ok(facet.groups.length <= 6);
    assert.equal(facet.totalOutput, 28);
    assert.equal(
      facet.groups.reduce((sum, group) => sum + group.output, 0),
      28,
    );
  }

  const laterChildPage = await report({
    range: "all",
    groupBy: "model",
    filters: {
      chatRole: "subagent",
      agentRole: "subagent",
      provider: "codex",
      machine: "machine-one",
      effort: "max",
    },
    limit: 1,
    offset: 5,
  });

  assert.deepEqual(laterChildPage.facets, childPage.facets);
  controlledChild.archivedAt = realNow();
  await current.harness.behavior.emitThreadEvent("thread.archived", { thread: controlledChild });
  await settle();
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chat: controlledChild.id, chatRole: "subagent", agentRole: "subagent" },
      })
    ).counters.output,
    28,
  );
  controlledChild.deletedAt = realNow();
  await current.harness.behavior.emitThreadEvent("thread.deleted", { thread: controlledChild });
  await settle();
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chat: controlledChild.id, chatRole: "subagent", agentRole: "subagent" },
      })
    ).counters.output,
    28,
  );
  checkpoints.push(
    "agent-controlled Omnyo chat tokens and full-range top-five-plus-Other facets survive pagination, archive and deletion",
  );

  const reparentedUser = makeThreadResponse({
    id: "user-reparented",
    parentThreadId: "delta",
    lifecycleOwnerThreadId: null,
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    createdAt: base - 1000,
    updatedAt: base + 95000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(reparentedUser);
  creation(reparentedUser.id, base - 500, null);
  begin(reparentedUser.id, "user-main", base + 94000, "user-model", "low", "default");
  usage(reparentedUser.id, "user-main", base + 94100, counter(1, 1), counter(1, 1));
  complete(reparentedUser.id, "user-main", base + 94200);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chat: reparentedUser.id, chatRole: "main", agentRole: "main" },
      })
    ).counters.output,
    1,
  );
  assert.equal(
    (await report({ range: "all", filters: { chat: reparentedUser.id, chatRole: "subagent" } }))
      .counters.output,
    0,
  );
  checkpoints.push(
    "public creation provenance distinguishes user-reparented roots and agent-spawned children; unsupported parent-only provenance stays Unknown",
  );
  const beforeRoleRefresh = historyReads.filter((read) => read.limit === 1).length;
  assert.equal(
    historyReads.filter((read) => read.thread === controlledChild.id && read.limit === 1).length,
    1,
  );
  assert.equal(
    historyReads.filter((read) => read.thread === reparentedUser.id && read.limit === 1).length,
    1,
  );
  await current.harness.behavior.callRpc("refresh", null);
  await settle();
  assert.equal(historyReads.filter((read) => read.limit === 1).length, beforeRoleRefresh);

  const delayedRole = makeThreadResponse({
    id: "delayed-role",
    parentThreadId: "delta",
    lifecycleOwnerThreadId: null,
    projectId: "project-one",
    environmentId: "env-one",
    providerId: "codex",
    createdAt: base - 1000,
    updatedAt: base + 98000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(delayedRole);
  creation(delayedRole.id, base - 500, "delta", false);
  begin(delayedRole.id, "unresolved-first", base + 95000, "delayed-model", "low", "default");
  usage(delayedRole.id, "unresolved-first", base + 95100, counter(2, 2), counter(2, 2));
  complete(delayedRole.id, "unresolved-first", base + 95200);
  failRoleProbes.add(delayedRole.id);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const failedRole = await report({
    range: "all",
    filters: { chat: delayedRole.id, chatRole: "unknown", agentRole: "unknown" },
  });

  assert.equal(failedRole.counters.output, 2);
  assert.equal(failedRole.health.roleReadFailures, 1);
  assert.match(failedRole.health.error ?? "", /Could not resolve 1 chat roles/);
  assert.equal(roleProbeReads.filter((thread) => thread === delayedRole.id).length, 1);
  await report();
  assert.equal(roleProbeReads.filter((thread) => thread === delayedRole.id).length, 1);
  failRoleProbes.delete(delayedRole.id);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const retryRole = await report({
    range: "all",
    filters: { chat: delayedRole.id, chatRole: "unknown" },
  });

  assert.equal(retryRole.counters.output, 2);
  assert.equal(retryRole.health.roleReadFailures, 0);
  assert.equal(retryRole.health.error, null);
  assert.equal(roleProbeReads.filter((thread) => thread === delayedRole.id).length, 2);
  creation(delayedRole.id, base + 96000, null);
  begin(delayedRole.id, "resolved-second", base + 97000, "delayed-model", "low", "default");
  usage(delayedRole.id, "resolved-second", base + 97100, counter(3, 3), counter(1, 1));
  complete(delayedRole.id, "resolved-second", base + 97200);
  await current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: delayedRole,
    sequence: sequences.get(delayedRole.id) ?? 0,
  });
  await settle();
  assert.equal(
    (await report({ range: "all", filters: { chat: delayedRole.id, chatRole: "main" } })).counters
      .output,
    3,
  );
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chat: delayedRole.id, chatRole: "main", agentRole: "main" },
      })
    ).counters.output,
    1,
  );
  assert.equal(
    (
      await report({
        range: "all",
        filters: { chat: delayedRole.id, chatRole: "main", agentRole: "unknown" },
      })
    ).counters.output,
    2,
  );
  assert.equal(roleProbeReads.filter((thread) => thread === delayedRole.id).length, 2);
  checkpoints.push(
    "provenance-only failures stay visible without blocking tokens; explicit retry clears the error and delayed creation resolves Unknown without another probe",
  );

  inventoryOnlyActive = true;
  let observedAt = realNow();

  Date.now = () => observedAt;
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const beforeInventory = summarySchema.parse(
    await current.harness.behavior.callRpc("summary", null),
  );

  assert.equal(beforeInventory.running, 4);
  observedAt += 10_000;
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const afterInventory = summarySchema.parse(
    await current.harness.behavior.callRpc("summary", null),
  );

  assert.ok(
    afterInventory.allTime.agentMs - beforeInventory.allTime.agentMs >= 40_000,
    "refresh must flush at least 10 seconds of four-agent coverage before replacing inventory",
  );
  checkpoints.push("inventory refresh preserves the in-progress active-agent coverage interval");

  const activeGamma = threads.find((thread) => thread.id === "gamma");

  assert.ok(activeGamma);
  gammaSource = "error";
  await current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: activeGamma,
    sequence: 2,
  });
  const activeErrorDeadline = performance.now() + 5000;

  for (;;) {
    if ((await report()).health.error) break;

    if (performance.now() > activeErrorDeadline)
      throw new Error("active source error was not visible");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  gammaSource = "missing";
  observedAt += 10_000;
  await current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: activeGamma,
    sequence: 3,
  });
  await settle();

  const missingActive = await report({ range: "all", groupBy: "chat" });

  assert.equal(missingActive.summary.running, 3);
  assert.equal(missingActive.summary.activeChats, 1);
  assert.equal(missingActive.groups.find((group) => group.key === "gamma")?.active, 0);
  assert.equal(missingActive.health.error, null);
  assert.equal(missingActive.summary.allTime.output, 542);
  assert.ok(missingActive.summary.allTime.agentMs - afterInventory.allTime.agentMs >= 40_000);
  checkpoints.push(
    "source 404 flushes prior active coverage and clears live groups and stale read errors",
  );

  const repairedSummary = summarySchema.parse(
    await current.harness.behavior.callRpc("summary", null),
  );

  assert.equal(repairedSummary.allTime.output, 542);

  inventoryOnlyActive = false;

  const hostless = makeThreadResponse({
    id: "hostless",
    projectId: "project-one",
    providerId: "codex",
    title: "Hostless",
    createdAt: base - 60_000,
    updatedAt: base + 50_000,
    status: "idle",
    runtime: { displayStatus: "idle" },
  });

  threads.push(hostless);
  begin("hostless", "hostless-turn", base, "model-a", "low", "default");
  usage("hostless", "hostless-turn", base + 1_000, counter(40, 7), counter(40, 7));
  complete("hostless", "hostless-turn", base + 2_000);
  await current.harness.behavior.callRpc("refresh", null);
  await settle();

  const machines = await report({ range: "all", groupBy: "machine" });
  const unknownMachine = machines.groups.find((group) => group.key === "");
  assert.equal(unknownMachine?.label, "Unknown machine");
  assert.ok((unknownMachine?.counters.output ?? 0) >= 7);
  assert.equal(
    machines.facets
      .find((facet) => facet.dimension === "machine")
      ?.groups.find((group) => group.key === "")?.label,
    "Unknown machine",
  );
  checkpoints.push("unattributed machine output keeps its Unknown label instead of a chat's host");

  const archivedAt = Date.now();
  const backlogIds = ["backlog-1", "backlog-2", "backlog-3"];

  for (const id of [...backlogIds, "retiring"]) {
    threads.push(
      makeThreadResponse({
        id,
        projectId: "project-one",
        environmentId: "env-one",
        providerId: "codex",
        title: id,
        archivedAt,
        createdAt: base - 60_000,
        updatedAt: base + 50_000,
        status: "idle",
        runtime: { displayStatus: "idle" },
      }),
    );
    begin(id, `${id}-turn`, base, "model-a", "low", "default");
    usage(id, `${id}-turn`, base + 1_000, counter(10, 1), counter(10, 1));
    complete(id, `${id}-turn`, base + 2_000);
  }

  let releaseGate = () => {};

  const gateReached = new Promise<void>((reached) => {
    readGate = {
      thread: "backlog-1",
      reached,
      release: new Promise<void>((release) => {
        releaseGate = release;
      }),
    };
  });

  await current.harness.behavior.callRpc("refresh", null);
  await gateReached;
  const retiring = threads.find((thread) => thread.id === "retiring");
  assert.ok(retiring);

  const event = current.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: retiring,
    sequence: sequences.get("retiring") ?? 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const releasedAt = historyReads.length;
  releaseGate();
  await event;
  await settle();

  const nextRead = historyReads
    .slice(releasedAt)
    .find((read) => read.thread === "retiring" || backlogIds.slice(1).includes(read.thread));

  assert.equal(nextRead?.thread, "retiring");
  assert.equal((await report({ range: "all", filters: { chat: "retiring" } })).counters.output, 1);
  checkpoints.push("a finished chat's new events are read before the discovery backlog");

  const evidenceDir = process.env.OMNYO_THREAD_STORAGE;

  if (evidenceDir) {
    await mkdir(`${evidenceDir}/stats-redesign-evidence`, { recursive: true });
    await writeFile(
      `${evidenceDir}/stats-redesign-evidence/backend-acceptance.json`,
      `${JSON.stringify({ checkedAt: new Date().toISOString(), failureScenarios, checkpoints, migrationProof, summary: repairedSummary, sourcePages: historyReads.length, surface: "public Plugin SDK harness with real SQLite; synthetic provider events and shipped v1 persistence fixture", storage: "SDK harness disposable SQLite removed by lifecycle.dispose" }, null, 2)}\n`,
    );
  }

  console.log(
    `PASS: ${checkpoints.length} Stats acceptance checkpoints; output=${repairedSummary.allTime.output}, total=${repairedSummary.allTime.total}, TPS5m=${repairedSummary.tps5m}`,
  );
} finally {
  service?.controller.abort();
  await service?.done;
  await current.harness.lifecycle.dispose();
  Date.now = realNow;
}
