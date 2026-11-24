import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const lapsed = {
  state: "skipped",
  at: "2026-11-11T12:50:00.000Z",
  reason: "lapsed",
  cacheReadShare: null,
};

describe("omnyo thread context", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("prints provider-defined categories and marks deferred counts separately", async () => {
    const get = vi.fn(async () => ({
      autoCompaction: {
        state: "done",
        at: "2026-11-11T12:50:00.000Z",
        reason: null,
        cacheReadShare: 0.964,
      },
      usage: {
        usedTokens: 100,
        modelContextWindow: 1_000,
        estimated: true,
        snapshot: {
          capturedAt: "2026-09-11T12:00:00.000Z",
          categories: [
            {
              id: "custom",
              label: "Custom category",
              kind: "used",
              tokens: 100,
              entries: [{ id: "file", label: "project.md", tokens: 100 }],
            },
            {
              id: "deferred",
              label: "Future tools",
              kind: "deferred",
              tokens: 500,
              entries: [],
            },
          ],
        },
      },
    }));

    stubServerApi({ "v1.threads.:id.context.$get": get });
    await runCommand(["thread", "context", "thread-1"], register);
    expect(get).toHaveBeenCalledWith({ param: { id: "thread-1" } });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Estimated context: 100 / 1,000 tokens",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Custom category: 100",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "  project.md: 100",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Future tools (deferred): 500",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Automatic compaction: done at 2026-11-11T12:50:00.000Z, cache-read share 0.96",
    );
  });

  it("prints the automatic compaction state when usage is missing", async () => {
    stubServerApi({
      "v1.threads.:id.context.$get": vi.fn(async () => ({
        usage: null,
        autoCompaction: {
          state: "disabled",
          at: null,
          reason: "opted-out",
          cacheReadShare: null,
        },
      })),
    });
    await runCommand(["thread", "context", "thread-1"], register);
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Context usage is not available yet.",
      "Automatic compaction: off (opted-out)",
    ]);
  });

  it("returns explicit missing usage in JSON", async () => {
    stubServerApi({
      "v1.threads.:id.context.$get": vi.fn(async () => ({
        usage: null,
        autoCompaction: lapsed,
      })),
    });
    await runCommand(["thread", "context", "thread-1", "--json"], register);
    expect(
      JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n")),
    ).toEqual({ usage: null, autoCompaction: lapsed });
  });
});

describe("omnyo thread auto-compaction", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each([
    [
      "--off",
      false,
      "Automatic compaction is off. The chat keeps its full history.",
    ],
    ["--on", true, "Automatic compaction is on for this chat."],
  ] as const)("sends %s for one chat", async (flag, enabled, line) => {
    const put = vi.fn(async () => ({ enabled }));

    stubServerApi({ "v1.threads.:id.auto-compaction.$put": put });
    await runCommand(["thread", "auto-compaction", "thread-1", flag], register);
    expect(put).toHaveBeenCalledWith({
      param: { id: "thread-1" },
      json: { enabled },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([line]);
  });

  it.each([[[]], [["--on", "--off"]]])(
    "requires exactly one of --on or --off (%j)",
    async (flags) => {
      const put = vi.fn(async () => ({ enabled: true }));

      stubServerApi({ "v1.threads.:id.auto-compaction.$put": put });
      await expect(
        runCommand(
          ["thread", "auto-compaction", "thread-1", ...flags],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(put).not.toHaveBeenCalled();
    },
  );
});
