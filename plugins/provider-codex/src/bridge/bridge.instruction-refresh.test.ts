import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PromptInput } from "@omnyo/plugin-sdk/provider-bridge";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@omnyo/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_instruction_refresh_1";

const REQUEST_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function instructionsWith(canvas: string): string {
  return [
    "Omnyo owns native questions.",
    'The following dynamic instructions come from the Omnyo plugin "canvas":',
    canvas,
    'The following dynamic instructions come from the Omnyo plugin "inline-ui":',
    "Use inline blocks.",
  ].join("\n\n");
}

const OLD_RULE = "Turn Canvas on for multi-step experiments.";

const NEW_RULE = "Leave Canvas off for linear investigations.";

const COMPACT_INPUT: PromptInput[] = [
  {
    type: "text",
    text: "/compact",
    mentions: [
      {
        start: 0,
        end: "/compact".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "compact",
          source: "command",
          origin: "builtin",
          label: "compact",
          argumentHint: null,
        },
      },
    ],
  },
];

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;

let workspaceDir: string;

let requestLogPath: string;

let nextRequestId = 1;

async function loadBridge(): Promise<void> {
  const bridge = await import("./bridge.js");
  bridge.experimental_providerBridge.start?.({
    pluginId: "codex",
    dataDir: join(workspaceDir, "data"),
    tempDir: join(workspaceDir, "temp"),
  });
  harness = createBridgeJsonRpcTestHarness(bridge.handleLine);
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "omnyo-codex-instructions-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }));
  stubFakeCodexAppServer(scriptPath);
  vi.resetModules();
  await loadBridge();
});

afterEach(async () => {
  await releaseThread();
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function request(
  method: string,
  params: Parameters<typeof harness.sendRequest>[2],
) {
  const id = nextRequestId;
  nextRequestId += 1;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  expect(response.error).toBeUndefined();

  return response.result;
}

async function releaseThread(): Promise<void> {
  const id = nextRequestId;
  nextRequestId += 1;
  harness.sendRequest(id, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "instruction-refresh-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(id).catch(() => undefined);
}

async function construct(
  method: "thread/start" | "thread/resume",
  rule: string,
  providerThreadId?: string,
): Promise<string> {
  const result = await request(method, {
    threadId: THREAD_ID,
    ...(providerThreadId === undefined ? {} : { providerThreadId }),
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      ...FULL_ACCESS_SESSION_OPTIONS,
      instructions: instructionsWith(rule),
    },
  });

  return z.object({ providerThreadId: z.string() }).parse(result)
    .providerThreadId;
}

async function turn(
  providerThreadId: string,
  rule: string,
  input: PromptInput[] = [{ type: "text", text: "say hello", mentions: [] }],
): Promise<void> {
  await request("turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: `creq_refreshx${REQUEST_ID_ALPHABET[Math.floor(nextRequestId / 32) % 32]}${REQUEST_ID_ALPHABET[nextRequestId % 32]}`,
    input,
    options: {
      ...FULL_ACCESS_SESSION_OPTIONS,
      instructions: instructionsWith(rule),
    },
  });
}

async function compact(providerThreadId: string, rule: string): Promise<void> {
  const completedBefore = completedTurns();
  await turn(providerThreadId, rule, COMPACT_INPUT);
  const deadline = Date.now() + 15_000;

  while (completedTurns() === completedBefore && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  expect(completedTurns()).toBeGreaterThan(completedBefore);
}

function completedTurns(): number {
  return assembleCapturedThreadEvents(harness.messages, "codex").filter(
    (event) => event.type === "turn/completed",
  ).length;
}

function injectedTexts(): string[] {
  const injection = z.object({
    method: z.literal("thread/inject_items"),
    params: z.object({
      items: z.tuple([
        z.object({
          type: z.literal("message"),
          role: z.literal("developer"),
          content: z.tuple([
            z.object({ type: z.literal("input_text"), text: z.string() }),
          ]),
        }),
      ]),
    }),
  });

  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => injection.safeParse(JSON.parse(line)))
    .flatMap((parsed) =>
      parsed.success ? [parsed.data.params.items[0].content[0].text] : [],
    );
}

it("sends only the instruction sections that changed since the thread last saw them", async () => {
  const providerThreadId = await construct("thread/start", OLD_RULE);

  await turn(providerThreadId, OLD_RULE);
  expect(injectedTexts()).toEqual([]);

  await turn(providerThreadId, NEW_RULE);
  await turn(providerThreadId, NEW_RULE);

  const injected = injectedTexts();
  expect(injected).toHaveLength(1);
  expect(injected[0]).toContain(
    'The following dynamic instructions come from the Omnyo plugin "canvas":',
  );
  expect(injected[0]).toContain(NEW_RULE);
  expect(injected[0]).not.toContain(OLD_RULE);
  expect(injected[0]).not.toContain("Use inline blocks.");
  expect(injected[0]).not.toContain("Omnyo owns native questions.");
}, 30_000);

it("resends changed sections after a compaction restores the constructed instructions", async () => {
  const providerThreadId = await construct("thread/start", OLD_RULE);

  await turn(providerThreadId, NEW_RULE);
  await compact(providerThreadId, NEW_RULE);
  await turn(providerThreadId, NEW_RULE);

  const injected = injectedTexts();
  expect(injected).toHaveLength(2);
  expect(injected[1]).toContain(NEW_RULE);
}, 30_000);

it("remembers delivered sections when a restarted bridge resumes the thread", async () => {
  const providerThreadId = await construct("thread/start", OLD_RULE);
  await turn(providerThreadId, NEW_RULE);
  await releaseThread();
  harness.restore();
  vi.resetModules();
  await loadBridge();

  const resumedThreadId = await construct(
    "thread/resume",
    NEW_RULE,
    providerThreadId,
  );

  await turn(resumedThreadId, NEW_RULE);

  expect(resumedThreadId).toBe(providerThreadId);
  expect(injectedTexts()).toHaveLength(1);
}, 30_000);

it("resends every section when a resumed thread has no saved record", async () => {
  const providerThreadId = await construct(
    "thread/resume",
    NEW_RULE,
    "codex-thread-without-record",
  );

  await turn(providerThreadId, NEW_RULE);

  const injected = injectedTexts();
  expect(injected).toHaveLength(1);
  expect(injected[0]).toContain("Omnyo owns native questions.");
  expect(injected[0]).toContain(NEW_RULE);
  expect(injected[0]).toContain("Use inline blocks.");
}, 30_000);
