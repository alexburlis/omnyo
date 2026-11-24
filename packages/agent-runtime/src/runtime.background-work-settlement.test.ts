import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@omnyo/domain";
import {
  createScriptedEchoProcessLog,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
  type LaunchBoundAgentRuntime,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import type { AgentRuntimeOptions } from "./types.js";

type ProcessExitInfo = Parameters<
  NonNullable<AgentRuntimeOptions["onProcessExit"]>
>[0];

interface BackgroundTaskRuntime {
  events: ThreadEvent[];
  processExits: ProcessExitInfo[];
  providerPids(): number[];
  runtime: LaunchBoundAgentRuntime;
}

function backgroundTaskCompletions(events: readonly ThreadEvent[]) {
  return events.filter(
    (event) => event.type === "item/backgroundTask/completed",
  );
}

function openedBackgroundTaskIds(events: readonly ThreadEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "item/started" && event.item.type === "backgroundTask"
      ? [event.item.id]
      : [],
  );
}

describe("createAgentRuntime background task settlement", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnyo-runtime-bg-settlement-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createBackgroundTaskRuntime(): BackgroundTaskRuntime {
    const events: ThreadEvent[] = [];
    const processExits: ProcessExitInfo[] = [];
    const processLog = createScriptedEchoProcessLog();

    const runtime = createScriptedEchoRuntime({
      runtime: {
        env: processLog.env,
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onProcessExit: (info) => processExits.push(info),
      },
      launch: {
        pluginId: "provider-claude-code",
        scripted: { sessionRestorable: true },
      },
    });

    return {
      events,
      processExits,
      providerPids: () =>
        processLog
          .read()
          .filter((line) => line.startsWith("spawn:"))
          .map((line) => Number(line.slice("spawn:".length))),
      runtime,
    };
  }

  async function openBackgroundTask(
    harness: BackgroundTaskRuntime,
  ): Promise<string> {
    await harness.runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "claude-code",
      options: fullRuntimeOptions,
    });
    await harness.runtime.runTurn({
      clientRequestId: "creq_bgsettxab2",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events: harness.events,
      runtime: harness.runtime,
      threadId: "t1",
    });
    expect(harness.runtime.hasOpenBackgroundWork()).toBe(true);

    const [itemId] = openedBackgroundTaskIds(harness.events);

    if (itemId === undefined) {
      throw new Error("expected the scripted turn to open a background task");
    }

    return itemId;
  }

  async function killProvider(harness: BackgroundTaskRuntime): Promise<void> {
    const [pid] = harness.providerPids();

    if (pid === undefined) {
      throw new Error("expected a spawned provider process");
    }

    process.kill(pid, "SIGKILL");
    await waitForRuntimeState({
      label: "the runtime reported the provider exit",
      predicate: () => harness.processExits.length === 1,
      timeoutMs: 10_000,
    });
  }

  it("settles an open background task as stopped once when its provider process exits", async () => {
    const harness = createBackgroundTaskRuntime();

    try {
      const itemId = await openBackgroundTask(harness);
      await killProvider(harness);

      expect(harness.processExits[0]?.expected).toBe(false);
      expect(backgroundTaskCompletions(harness.events)).toEqual([
        expect.objectContaining({
          threadId: "t1",
          scope: { kind: "thread" },
          item: expect.objectContaining({
            id: itemId,
            type: "backgroundTask",
            description: "scripted background task",
            status: "interrupted",
            taskStatus: "stopped",
          }),
        }),
      ]);

      const startedProviderThreadIds = harness.events.flatMap((event) =>
        event.type === "item/started" && event.item.id === itemId
          ? [event.providerThreadId]
          : [],
      );

      expect(
        backgroundTaskCompletions(harness.events).map(
          (event) => event.providerThreadId,
        ),
      ).toEqual(startedProviderThreadIds);
      expect(harness.runtime.hasOpenBackgroundWork()).toBe(false);
    } finally {
      await harness.runtime.shutdown();
    }
  });

  it("emits nothing for a background task the provider already settled before it exited", async () => {
    const harness = createBackgroundTaskRuntime();

    try {
      const itemId = await openBackgroundTask(harness);
      await harness.runtime.runTurn({
        clientRequestId: "creq_bgsettxab3",
        threadId: "t1",
        input: [promptTextInput({ text: "bg_task_done" })],
        options: fullRuntimeOptions,
      });
      await waitForRuntimeState({
        label: "the provider settled the background task",
        predicate: () => !harness.runtime.hasOpenBackgroundWork(),
        runtime: harness.runtime,
        timeoutMs: 5_000,
      });
      await killProvider(harness);

      expect(backgroundTaskCompletions(harness.events)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            id: itemId,
            taskStatus: "completed",
          }),
        }),
      ]);
    } finally {
      await harness.runtime.shutdown();
    }
  });

  it("settles an open background task as stopped when the thread is stopped", async () => {
    const harness = createBackgroundTaskRuntime();

    try {
      const itemId = await openBackgroundTask(harness);
      await harness.runtime.stopThread({ threadId: "t1" });

      expect(backgroundTaskCompletions(harness.events)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            id: itemId,
            status: "interrupted",
            taskStatus: "stopped",
          }),
        }),
      ]);
    } finally {
      await harness.runtime.shutdown();
    }
  });

  it("emits no settlement when the runtime shuts down", async () => {
    const harness = createBackgroundTaskRuntime();
    await openBackgroundTask(harness);
    await harness.runtime.shutdown();

    expect(backgroundTaskCompletions(harness.events)).toEqual([]);
  });

  it("emits no settlement when the thread is archived", async () => {
    const harness = createBackgroundTaskRuntime();

    try {
      await openBackgroundTask(harness);

      const providerThreadId =
        harness.runtime.getProviderSession("t1")?.providerThreadId;

      if (providerThreadId === undefined) {
        throw new Error("expected a provider session for t1");
      }

      await harness.runtime.archiveThread({
        threadId: "t1",
        providerId: "claude-code",
        providerThreadId,
      });

      expect(harness.runtime.hasOpenBackgroundWork()).toBe(false);
      expect(backgroundTaskCompletions(harness.events)).toEqual([]);
    } finally {
      await harness.runtime.shutdown();
    }
  });
});
