import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@omnyo/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcTestHarness } from "@omnyo/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_subagent_unload";

let harness: BridgeJsonRpcTestHarness;

let workspaceDir: string;

let requestLogPath: string;

function delegationCloseStatuses(): string[] {
  return harness.messages.flatMap((message) => {
    if (message.method !== "thread/delta") return [];

    const params = message.params as { deltas?: unknown } | undefined;

    if (!Array.isArray(params?.deltas)) return [];

    return (
      params.deltas as Array<{
        kind?: string;
        status?: string;
        item?: { type?: string };
      }>
    )
      .filter(
        (delta) =>
          delta.kind === "item.close" && delta.item?.type === "delegation",
      )
      .map((delta) => delta.status ?? "");
  });
}

function loggedMethods(): string[] {
  try {
    return readFileSync(requestLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as {
          method: string;
          params?: { threadId?: string };
        };

        return `${entry.method}:${entry.params?.threadId ?? ""}`;
      });
  } catch {
    return [];
  }
}

async function waitForLogged(predicate: (methods: string[]) => boolean) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const methods = loggedMethods();

    if (predicate(methods)) return methods;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out; saw ${JSON.stringify(loggedMethods())}`);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "omnyo-codex-subagent-unload-"));
  requestLogPath = join(workspaceDir, "requests.log");
  const scriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ requestLogPath, unloadDelayMs: 1500 }),
  );
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  harness.sendRequest(995_001, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "subagent-unload-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(995_001).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("unloads a finished sub-agent once the chat is idle and lets it close before the next turn", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });

  const providerThreadId = (
    (await harness.waitForResponse(1)).result as { providerThreadId: string }
  ).providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/subagent-finishes", mentions: [] }],
    clientRequestId: "creq_subunxdaa2",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  const unloaded = await waitForLogged((methods) =>
    methods.some((method) =>
      method.startsWith("thread/unsubscribe:codex-fx-sub-"),
    ),
  );

  expect(
    unloaded.filter((method) => method.startsWith("thread/unsubscribe:")),
  ).toEqual([expect.stringMatching(/^thread\/unsubscribe:codex-fx-sub-/)]);

  const sentAt = Date.now();

  harness.sendRequest(3, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/respond-completed", mentions: [] }],
    clientRequestId: "creq_subunxdaa3",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(3)).error).toBeUndefined();

  const methods = loggedMethods();

  const closedAt = methods.findIndex((method) =>
    method.startsWith("emitted:thread/closed:codex-fx-sub-"),
  );

  const nextTurnAt = methods.lastIndexOf(`turn/start:${providerThreadId}`);

  expect(closedAt).toBeGreaterThan(-1);
  expect(nextTurnAt).toBeGreaterThan(closedAt);
  expect(Date.now() - sentAt).toBeLessThan(5_000);
  expect(delegationCloseStatuses()).not.toContain("failed");
  expect(
    methods.filter((method) => method.startsWith("thread/unsubscribe:")),
  ).toHaveLength(1);
}, 30_000);

it("keeps a finished sub-agent loaded while its background terminal is still running", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });

  const providerThreadId = (
    (await harness.waitForResponse(1)).result as { providerThreadId: string }
  ).providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/subagent-keeps-terminal", mentions: [] }],
    clientRequestId: "creq_subunxdaa4",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  await waitForLogged((methods) =>
    methods.some((method) =>
      method.startsWith("thread/backgroundTerminals/list:codex-fx-sub-"),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    loggedMethods().filter((method) =>
      method.startsWith("thread/unsubscribe:"),
    ),
  ).toEqual([]);
  expect(delegationCloseStatuses()).not.toContain("failed");
}, 30_000);
