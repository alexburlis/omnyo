import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  createAgentRuntime,
  type AgentRuntimeBridgeLaunch,
} from "@omnyo/agent-runtime";
import {
  encodeClientTurnRequestIdNumber,
  requireThreadEventScopeTurnId,
  type RuntimeThreadExecutionOptions,
  type ThreadEvent,
} from "@omnyo/domain";
import { RuntimeManager } from "../src/runtime-manager.js";
import { RuntimeBackgroundWorkState } from "../../../packages/agent-runtime/src/runtime-background-work-state.js";

function replayNativeChildOwnership(): void {
  const owner = new RuntimeBackgroundWorkState();
  const threadId = "thr_native_child_replay";

  const child = (turnId: string, id = threadId) =>
    ({
      type: "turn/started",
      threadId: id,
      providerThreadId: "fixture-provider",
      parentToolCallId: "fixture-parent",
      scope: { kind: "turn", turnId },
    }) satisfies Extract<ThreadEvent, { type: "turn/started" }>;

  const completion = (turnId: string) =>
    ({
      type: "turn/completed",
      threadId,
      providerThreadId: "fixture-provider",
      scope: { kind: "turn", turnId },
      status: "completed",
    }) satisfies Extract<ThreadEvent, { type: "turn/completed" }>;

  const first = child("child-one");
  const second = child("child-two");
  const parent = completion("parent");
  owner.observe(first);
  owner.observe(second);
  owner.observe(parent);
  owner.observe(completion("unknown-child"));
  assert.ok(
    owner.hasOpenThreadWork(threadId),
    "root completion preserves native children",
  );
  owner.observe(completion("child-one"));
  assert.ok(
    owner.hasOpenThreadWork(threadId),
    "one child cannot release its sibling",
  );
  owner.observe(completion("child-two"));
  assert.equal(owner.hasOpenWork(), false);
  owner.observe(first);
  owner.observe(completion("child-one"));
  owner.observe(parent);
  assert.equal(
    owner.hasOpenWork(),
    false,
    "child can settle before its parent",
  );
  owner.observe(parent);
  owner.observe(second);
  assert.ok(owner.hasOpenWork(), "child can start after its parent settles");
  owner.observe(completion("child-two"));

  const task = {
    type: "item/started",
    threadId,
    providerThreadId: "fixture-provider",
    scope: { kind: "turn", turnId: "parent" },
    item: {
      type: "backgroundTask",
      id: "child-one",
      taskType: "workflow",
      description: "same identifier in a separate work namespace",
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
    },
  } satisfies Extract<ThreadEvent, { type: "item/started" }>;

  const settledTask = {
    ...task,
    item: { ...task.item, status: "completed", taskStatus: "completed" },
  } satisfies Extract<ThreadEvent, { type: "item/started" }>;

  owner.observe(task);
  owner.observe(first);
  owner.observe(completion("child-one"));
  assert.ok(owner.hasOpenWork(), "child completion preserves a same-ID task");
  owner.observe(settledTask);
  assert.equal(owner.hasOpenWork(), false);
  owner.observe(first);
  owner.observe(task);
  owner.observe(settledTask);
  assert.ok(owner.hasOpenWork(), "task completion preserves a same-ID child");
  owner.observe(completion("child-one"));
  assert.equal(owner.hasOpenWork(), false);
  owner.observe(first);
  owner.observe(child("other-child", "thr_other"));
  owner.clearThread(threadId);
  assert.equal(owner.hasOpenThreadWork(threadId), false);
  assert.equal(owner.hasOpenThreadWork("thr_other"), true);
  owner.clear();
  assert.equal(owner.hasOpenWork(), false);
  console.log(
    JSON.stringify({
      ownerReplayPassed: true,
      actualNativeProcessesProven: false,
      cases: 8,
    }),
  );
}

if (process.argv.includes("--owner-replay")) {
  replayNativeChildOwnership();
} else {
  const round = process.argv[2];
  const nativeLog = process.argv[3];
  const sampler = process.argv[4];
  const candidate = process.argv[5] === "candidate";
  const guard = process.argv[6] === "child";
  assert.ok(round && nativeLog && sampler);
  const nowOriginal = Date.now;
  const epoch = 1_800_000_000_000;
  let now = epoch;
  Date.now = () => now;
  const events: ThreadEvent[] = [];
  const errors: string[] = [];

  const options = {
    model: "fixture-model",
    serviceTier: "default",
    reasoningLevel: "medium",
    providerOptions: {},
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  } satisfies RuntimeThreadExecutionOptions;

  const instructions =
    "Native fixture instructions " + (guard ? "PARENT" : "IDLE");

  const manager = new RuntimeManager({
    bridgeBundleDir: process.env.NATIVE_IDLE_BUNDLE_DIR,
    createRuntime: (args) =>
      createAgentRuntime({
        ...args,
        env: {
          HOME: path.join(round, "home"),
          CODEX_HOME: path.join(round, "codex"),
          TMPDIR: round,
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
          OMNYO_PROVIDER_BRIDGE_RECORD_DIR: path.join(round, "recordings"),
        },
      }),
    onEvent: ({ event }) => events.push(event),
    onStderr: (line) => errors.push(line),
  });

  const launch: AgentRuntimeBridgeLaunch = {
    pluginId: "provider-codex",
    dataDir: path.join(round, "plugin-data"),
    source: {
      kind: "artifact" as const,
      digest: "restored-dedicated-native-idle",
      artifactPath: path.join(
        process.env.NATIVE_IDLE_BUNDLE_DIR ?? "",
        "codex-provider.mjs",
      ),
    },
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: true,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint" as const,
    },
    providerOptions: {},
    envPassthrough: [
      "OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND",
      "OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS",
    ],
  };

  const threadId = "thr_native_idle";

  async function until(predicate: () => boolean, label: string) {
    const deadline = performance.now() + 30_000;

    while (!predicate()) {
      assert.ok(
        performance.now() < deadline,
        `Native idle timeout: ${label}; errors: ${errors.join(" | ")}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function pids() {
    try {
      return (await readFile(nativeLog, "utf8")).trim().split("\n").map(Number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function ownerBridgePid(nativePid: number): Promise<number> {
    const response = await fetch(
      process.env.NATIVE_IDLE_FIXTURE_URL + "/fixture/parent/" + nativePid,
    );

    assert.equal(response.status, 200);

    return ((await response.json()) as { bridgePid: number }).bridgePid;
  }

  async function sample(nativePid: number, bridgePid: number) {
    const response = await fetch(
      process.env.NATIVE_IDLE_FIXTURE_URL +
        "/fixture/sample/" +
        nativePid +
        "," +
        bridgePid,
    );

    assert.equal(response.status, 200);

    return (await response.json()) as {
      native: {
        processCount: number;
        residentBytes: number;
        physicalFootprintBytes: number;
        userNs: number;
        systemNs: number;
      };
      bridgeAlone: {
        processCount: number;
        residentBytes: number;
        physicalFootprintBytes: number;
      };
      nativePid: number;
      bridgePid: number;
      nativeAlive: boolean;
      bridgeAlive: boolean;
    };
  }

  async function untilOwnersExit(
    nativePid: number,
    bridgePid: number,
  ): Promise<void> {
    const deadline = performance.now() + 30_000;

    while (true) {
      const observed = await sample(nativePid, bridgePid);

      if (!observed.nativeAlive && !observed.bridgeAlive) return;
      assert.ok(
        performance.now() < deadline,
        "Owned native and bridge processes must exit",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function nativeWire() {
    const root = path.join(round, "recordings", "codex", threadId);

    const outgoing = (
      await readFile(path.join(root, "bridge→provider.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) =>
        (() => {
          const record = JSON.parse(line);

          return { ...JSON.parse(record.line), nativeRecordRun: record.run };
        })(),
      );

    const incoming = (
      await readFile(path.join(root, "provider→bridge.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) =>
        (() => {
          const record = JSON.parse(line);

          return { ...JSON.parse(record.line), nativeRecordRun: record.run };
        })(),
      );

    return { outgoing, incoming };
  }

  async function rollout() {
    const root = path.join(round, "codex", "sessions");
    const files = await readdir(root, { recursive: true });
    const selected = files.filter((name) => name.endsWith(".jsonl"));
    assert.equal(selected.length, 1);

    return (await readFile(path.join(root, selected[0] ?? ""), "utf8"))
      .trim()
      .split("\n");
  }

  let report;

  try {
    const entry = await manager.ensureEnvironment({
      environmentId: "env-native",
      workspacePath: path.join(round, "workspace"),
    });

    await entry.runtime.startThread({
      bridgeLaunch: launch,
      environmentId: entry.environmentId,
      threadId,
      projectId: "p-local",
      providerId: "codex",
      instructions,
      instructionMode: "replace",
      options,
    });
    const prior = entry.runtime.getProviderSession(threadId);
    assert.ok(prior);
    assert.ok(prior.providerThreadId);

    async function turn(text: string, id: number) {
      const before = events.length;
      await entry.runtime.runTurn({
        threadId,
        clientRequestId: encodeClientTurnRequestIdNumber({ value: id }),
        input: [{ type: "text", text, mentions: [] }],
        options,
      });
      await until(() => {
        const started = events
          .slice(before)
          .find(
            (event) => event.type === "turn/started" && !event.parentToolCallId,
          );

        return (
          started !== undefined &&
          events
            .slice(before)
            .some(
              (event) =>
                event.type === "turn/completed" &&
                event.scope.kind === "turn" &&
                started.scope.kind === "turn" &&
                event.scope.turnId === started.scope.turnId,
            )
        );
      }, text);
      assert.equal(entry.runtime.getActiveTurnId(threadId), null);
      assert.equal(
        events
          .slice(before)
          .filter((event) => event.type === "turn/completed")
          .at(-1)?.status,
        "completed",
      );
    }

    if (guard) {
      await turn("PARENT", 1);

      const children = () =>
        events.filter(
          (event): event is Extract<ThreadEvent, { type: "turn/started" }> =>
            event.type === "turn/started" && Boolean(event.parentToolCallId),
        );

      await until(() => children().length === 2, "two native children started");
      const childStarts = children();

      const childIds = childStarts.map((event) =>
        requireThreadEventScopeTurnId({ type: event.type, scope: event.scope }),
      );

      assert.equal(new Set(childIds).size, 2);
      const control = process.env.NATIVE_IDLE_FIXTURE_URL;
      assert.ok(control);

      const status = (await (
        await fetch(control + "/fixture/status")
      ).json()) as {
        started: string[];
      };

      assert.deepEqual(status.started, ["CHILD_ONE", "CHILD_TWO"]);

      const rootCompletion = events.find(
        (event): event is Extract<ThreadEvent, { type: "turn/completed" }> =>
          event.type === "turn/completed" &&
          event.scope.kind === "turn" &&
          !childIds.includes(event.scope.turnId),
      );

      assert.ok(rootCompletion);
      assert.equal(entry.runtime.getActiveTurnId(threadId), null);
      const nativePid = (await pids())[0];
      assert.ok(nativePid);
      const bridgePid = await ownerBridgePid(nativePid);
      const before = await sample(nativePid, bridgePid);
      now += 31 * 60_000;
      const start = performance.now();
      const cpuStart = process.cpuUsage();

      const result = await manager.reapIdleProviderSessions({
        idleForMs: 30 * 60_000,
        nowMs: now,
      });

      const cpu = process.cpuUsage(cpuStart);
      const elapsedMs = performance.now() - start;
      const after = await sample(nativePid, bridgePid);

      const guardSample = {
        candidate,
        childIds,
        rootIdle: true,
        rootCompleted: true,
        heldNativeChildren: status.started,
        before,
        after,
        elapsedMs,
        parentCpuMs: (cpu.user + cpu.system) / 1000,
        reapedSessions: result.reapedSessions,
      };

      if (result.reapedSessions.length > 0)
        console.log(JSON.stringify({ nativeChildRegression: guardSample }));
      assert.deepEqual(
        result.reapedSessions,
        [],
        "Completed parent with started native children must block thirty-minute reaping",
      );
      assert.ok(entry.runtime.hasOpenBackgroundWork());
      await turn("ROOT_REPEAT", 2);
      now += 31 * 60_000;
      assert.ok(
        entry.runtime.hasOpenBackgroundWork(),
        "ordinary root completion preserves both children",
      );

      const childCompletions = () =>
        events.filter(
          (event): event is Extract<ThreadEvent, { type: "turn/completed" }> =>
            event.type === "turn/completed" &&
            event.scope.kind === "turn" &&
            childIds.includes(event.scope.turnId),
        );

      await fetch(control + "/fixture/release/CHILD_ONE");
      await until(
        () => childCompletions().length === 1,
        "first native child settles",
      );
      assert.ok(
        entry.runtime.hasOpenBackgroundWork(),
        "second native child keeps root protected",
      );
      assert.deepEqual(
        (
          await manager.reapIdleProviderSessions({
            idleForMs: 30 * 60_000,
            nowMs: now,
          })
        ).reapedSessions,
        [],
      );
      await fetch(control + "/fixture/release/CHILD_TWO");
      await until(
        () => childCompletions().length === 2,
        "second native child settles",
      );
      assert.equal(entry.runtime.hasOpenBackgroundWork(), false);
      const completed = childCompletions();
      assert.ok(
        completed.every((event) => !("parentToolCallId" in event)),
        "Actual native child completion omits parent linkage",
      );
      const owner = new RuntimeBackgroundWorkState();
      const firstStart = childStarts[0];
      const secondStart = childStarts[1];

      const firstCompletion = completed.find(
        (event) =>
          event.scope.kind === "turn" &&
          firstStart?.scope.kind === "turn" &&
          event.scope.turnId === firstStart.scope.turnId,
      );

      const secondCompletion = completed.find(
        (event) =>
          event.scope.kind === "turn" &&
          secondStart?.scope.kind === "turn" &&
          event.scope.turnId === secondStart.scope.turnId,
      );

      assert.ok(
        firstStart && secondStart && firstCompletion && secondCompletion,
      );
      owner.observe(firstStart);
      owner.observe(secondStart);
      owner.observe(rootCompletion);
      owner.observe({
        ...firstCompletion,
        scope: { kind: "turn", turnId: "unknown-child" },
      });
      assert.ok(owner.hasOpenThreadWork(threadId));
      owner.observe(firstCompletion);
      assert.ok(owner.hasOpenThreadWork(threadId));
      owner.observe(secondCompletion);
      assert.equal(owner.hasOpenWork(), false);
      owner.observe(firstStart);
      owner.observe(firstCompletion);
      owner.observe(rootCompletion);
      assert.equal(
        owner.hasOpenWork(),
        false,
        "child settlement before root completion",
      );
      owner.observe(rootCompletion);
      owner.observe(secondStart);
      assert.ok(owner.hasOpenWork(), "child starts after root completion");
      owner.observe(secondCompletion);
      assert.equal(owner.hasOpenWork(), false);
      owner.observe(firstStart);
      owner.observe({ ...secondStart, threadId: "other-omnyo-thread" });
      owner.clearThread(threadId);
      assert.equal(owner.hasOpenThreadWork(threadId), false);
      assert.equal(owner.hasOpenThreadWork("other-omnyo-thread"), true);
      owner.clear();
      assert.equal(owner.hasOpenWork(), false);

      const task = {
        ...rootCompletion,
        providerThreadId: prior.providerThreadId,
        type: "item/started",
        item: {
          type: "backgroundTask",
          id: childIds[0] ?? "",
          taskType: "workflow",
          description: "canonical background task namespace replay",
          status: "pending",
          taskStatus: "running",
          skipTranscript: false,
        },
      } satisfies Extract<ThreadEvent, { type: "item/started" }>;

      owner.observe(task);
      owner.observe(firstStart);
      owner.observe(firstCompletion);
      assert.ok(
        owner.hasOpenWork(),
        "child completion does not clear same-ID task",
      );
      owner.observe({
        ...task,
        item: { ...task.item, status: "completed", taskStatus: "completed" },
      });
      assert.equal(owner.hasOpenWork(), false);
      owner.observe(firstStart);
      owner.observe(task);
      owner.observe({
        ...task,
        item: { ...task.item, status: "completed", taskStatus: "completed" },
      });
      assert.ok(
        owner.hasOpenWork(),
        "task completion does not clear same-ID child",
      );
      owner.observe(firstCompletion);
      assert.equal(owner.hasOpenWork(), false);
      now += 31 * 60_000;
      assert.equal(
        (
          await manager.reapIdleProviderSessions({
            idleForMs: 30 * 60_000,
            nowMs: now,
          })
        ).reapedSessions.length,
        1,
      );
      await untilOwnersExit(nativePid, bridgePid);
      report = {
        nativeChildGuard: guardSample,
        actualNativeChildren: 2,
        actualCompletionsWithoutParentLinkage: true,
        existingOwnerReplayChecks: [
          "root and unknown completions",
          "independent children",
          "before and after parent completion",
          "clearThread isolation",
          "global clear",
          "task and turn namespaces",
        ],
        settledAllowsRelease: true,
        providerSpend: 0,
      };
    } else {
      await turn("IDLE", 1);
      const beforeRollout = await rollout();
      assert.ok(beforeRollout.some((line) => line.includes("COMPLETED_IDLE")));
      const nativePid = (await pids())[0];
      assert.ok(nativePid);
      const bridgePid = await ownerBridgePid(nativePid);
      assert.ok(bridgePid > 0);
      const before = await sample(nativePid, bridgePid);
      assert.equal(before.native.processCount, 1);
      assert.equal(before.bridgeAlone.processCount, 1);
      now += 6 * 60_000;
      const sixStart = performance.now();
      const sixCpuStart = process.cpuUsage();

      const sixResult = await manager.reapIdleProviderSessions({
        idleForMs: 30 * 60_000,
        nowMs: now,
      });

      const sixCpu = process.cpuUsage(sixCpuStart);
      const sixElapsedMs = performance.now() - sixStart;
      assert.deepEqual(sixResult.reapedSessions, []);
      const sixAfter = await sample(nativePid, bridgePid);
      assert.equal(sixAfter.nativeAlive, true);
      assert.equal(sixAfter.bridgeAlive, true);
      now = epoch + 31 * 60_000;
      const start = performance.now();
      const cpuStart = process.cpuUsage();

      const result = await manager.reapIdleProviderSessions({
        idleForMs: 30 * 60_000,
        nowMs: now,
      });

      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      assert.equal(result.reapedSessions.length, 1);
      const after = await sample(nativePid, bridgePid);
      assert.equal(after.nativeAlive, false);
      assert.equal(after.bridgeAlive, false);
      await untilOwnersExit(nativePid, bridgePid);
      const resumeStart = performance.now();
      await entry.runtime.resumeThread({
        bridgeLaunch: launch,
        environmentId: entry.environmentId,
        threadId,
        projectId: "p-local",
        providerId: "codex",
        providerThreadId: prior.providerThreadId,
        instructions,
        instructionMode: "replace",
        options,
      });
      assert.equal(
        entry.runtime.getProviderSession(threadId)?.providerThreadId,
        prior.providerThreadId,
      );
      await turn("RESUME_IDLE", 2);
      const resumeElapsedMs = performance.now() - resumeStart;
      const afterRollout = await rollout();
      assert.deepEqual(
        afterRollout.slice(0, beforeRollout.length),
        beforeRollout,
      );
      const wire = await nativeWire();

      const startWire = wire.outgoing.find(
        (message) => message.method === "thread/start",
      );

      const resumeWire = wire.outgoing.find(
        (message) => message.method === "thread/resume",
      );

      assert.ok(startWire && resumeWire);
      assert.equal(resumeWire.params.cwd, path.join(round, "workspace"));
      assert.equal(resumeWire.params.approvalPolicy, "on-request");
      assert.equal(resumeWire.params.approvalsReviewer, "user");
      assert.equal(resumeWire.params.sandbox, "workspace-write");
      assert.equal(resumeWire.params.baseInstructions, instructions);
      assert.equal(resumeWire.params.model, "fixture-model");

      for (const field of [
        "cwd",
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
        "baseInstructions",
        "model",
        "serviceTier",
      ])
        assert.deepEqual(
          resumeWire.params[field],
          startWire.params[field],
          `Saved native setting ${field}`,
        );
      assert.equal(resumeWire.params.threadId, prior.providerThreadId);

      const response = wire.incoming.find(
        (message) =>
          message.id === resumeWire.id &&
          message.nativeRecordRun === resumeWire.nativeRecordRun &&
          message.result,
      );

      assert.ok(response);

      const startResponse = wire.incoming.find(
        (message) =>
          message.id === startWire.id &&
          message.nativeRecordRun === startWire.nativeRecordRun &&
          message.result,
      );

      assert.ok(startResponse);
      assert.equal(response.result.cwd, path.join(round, "workspace"));
      assert.equal(response.result.approvalPolicy, "on-request");
      assert.equal(response.result.approvalsReviewer, "user");
      assert.equal(response.result.sandbox.type, "workspaceWrite");
      assert.equal(response.result.model, "fixture-model");

      for (const field of [
        "cwd",
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
        "model",
        "serviceTier",
      ])
        assert.deepEqual(
          response.result[field],
          startResponse.result[field],
          `Native response setting ${field}`,
        );
      report = {
        candidate,
        before,
        after,
        idleAgeMs: 1860000,
        sixMinuteNoPolicyChange: {
          reapedSessions: sixResult.reapedSessions,
          after: sixAfter,
          elapsedMs: sixElapsedMs,
          parentCpuMs: (sixCpu.user + sixCpu.system) / 1000,
        },
        elapsedMs,
        parentCpuMs: (cpu.user + cpu.system) / 1000,
        resumeElapsedMs,
        nativeStarts: (await pids()).length,
        nativeIdentityPreserved: true,
        savedSettings: Object.fromEntries(
          [
            "cwd",
            "approvalPolicy",
            "approvalsReviewer",
            "sandbox",
            "baseInstructions",
            "model",
            "serviceTier",
          ].map((field) => [field, resumeWire.params[field]]),
        ),
        nativeResumeResponseSettings: {
          approvalPolicy: response.result.approvalPolicy,
          approvalsReviewer: response.result.approvalsReviewer,
          sandbox: response.result.sandbox,
        },
        retainedRolloutPrefixSha256: createHash("sha256")
          .update(beforeRollout.join("\n"))
          .digest("hex"),
        retainedHistoryEntries: beforeRollout.length,
        historyPrefixPreserved: true,
        beforeNativePid: nativePid,
        beforeBridgePid: bridgePid,
        noInferenceProvider: true,
        localCannedTurns: 2,
      };
    }
  } catch (error) {
    console.error(JSON.stringify({ failure: String(error), errors }));
    throw error;
  } finally {
    await manager.shutdownAll();
    Date.now = nowOriginal;
    const owned = await pids();

    for (const nativePid of owned)
      await untilOwnersExit(nativePid, await ownerBridgePid(nativePid));
  }

  console.log(JSON.stringify(report));
}
