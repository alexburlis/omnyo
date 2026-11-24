import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNativeChat, scanNativeChats } from "../host.js";
import {
  codexAgentMessage,
  codexEvent,
  codexItem,
  codexMeta,
  codexRolloutPath,
  codexTaskComplete,
  codexTaskStarted,
  codexTurnAborted,
  codexUserMessage,
  createFixtureHome,
  DAY_MS,
  fingerprintTree,
  HOUR_MS,
  NOW_MS,
  writeJsonl,
  writeSimpleCodexChat,
  type FixtureHome,
} from "./testing/fixture-store.js";

let home: FixtureHome;

beforeEach(async () => {
  home = await createFixtureHome();
});

afterEach(async () => {
  await home.cleanup();
});

const RECENT = NOW_MS - 3 * HOUR_MS;

function scan(days = 2) {
  return scanNativeChats(home.environment(), {
    days,
    nowMs: NOW_MS,
    resolvePaths: [],
  });
}

describe("Codex scan", () => {
  it("keeps interactive CLI and IDE chats and counts every excluded kind", async () => {
    const chat = (
      id: string,
      meta: Parameters<typeof writeSimpleCodexChat>[1]["meta"] = {},
    ) =>
      writeSimpleCodexChat(home.codexHome, {
        id,
        cwd: home.workDir,
        startAt: RECENT - HOUR_MS,
        lastAt: RECENT,
        prompt: `prompt for ${id}`,
        meta,
      });

    await chat("tui");
    await chat("rs", { originator: "codex_cli_rs", threadSource: null });
    await chat("ide", { originator: "codex_vscode" });
    await chat("omnyo", { originator: "omnyo", threadSource: null });
    await chat("bb", { originator: "bb" });
    await chat("predict", { originator: "bb_composer_predictions" });
    await chat("pool", { modelProvider: "omnyo-account-pool" });
    await chat("spawned", {
      source: { subagent: { thread_spawn: { depth: 1 } } },
      threadSource: "subagent",
    });
    await chat("guardian", { threadSource: "guardian_review" });
    await chat("exec", { originator: "codex_exec", source: "exec" });
    await chat("probe", { originator: "bb-nc-probe" });
    await writeSimpleCodexChat(home.codexHome, {
      id: "silent",
      cwd: home.workDir,
      startAt: RECENT - HOUR_MS,
      lastAt: RECENT,
    });
    await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, "broken"),
      ["{not json"],
      RECENT,
    );

    const result = await scan();

    expect(result.roots).toEqual({ codex: home.codexHome, claude: null });
    expect(
      result.chats.map((entry) => [entry.sourceProviderThreadId, entry.client]),
    ).toEqual(
      expect.arrayContaining([
        ["tui", "cli"],
        ["rs", "cli"],
        ["ide", "ide"],
      ]),
    );
    expect(result.chats).toHaveLength(3);
    expect(result.dropped).toEqual([
      { providerId: "codex", reason: "no-user-message", count: 1 },
      { providerId: "codex", reason: "omnyo-session", count: 4 },
      { providerId: "codex", reason: "scripted-session", count: 2 },
      { providerId: "codex", reason: "subagent-session", count: 2 },
      { providerId: "codex", reason: "unreadable", count: 1 },
    ]);
    expect(result.chats[0]).toMatchObject({
      providerId: "codex",
      cwd: home.workDir,
      cwdExists: true,
      cwdMatchesStore: true,
      projectRoot: {
        path: home.workDir,
        kind: "folder",
        mainRepositoryPath: null,
      },
      createdAt: RECENT - HOUR_MS,
      lastMessageAt: RECENT,
    });
    expect(result.homeDir).toBe(home.homeDir);
  });

  it("applies the window to the last message, not the file time", async () => {
    await writeSimpleCodexChat(home.codexHome, {
      id: "stale-mtime-recent",
      cwd: home.workDir,
      startAt: NOW_MS - 10 * DAY_MS,
      lastAt: NOW_MS - 5 * DAY_MS,
      prompt: "old work",
    });

    const touched = codexRolloutPath(
      home.codexHome,
      NOW_MS - 10 * DAY_MS,
      "stale-mtime-recent",
    );

    await fs.utimes(touched, RECENT / 1000, RECENT / 1000);
    await writeSimpleCodexChat(home.codexHome, {
      id: "old-file",
      cwd: home.workDir,
      startAt: NOW_MS - 20 * DAY_MS,
      lastAt: NOW_MS - 19 * DAY_MS,
      prompt: "ancient",
    });
    await writeSimpleCodexChat(home.codexHome, {
      id: "week",
      cwd: home.workDir,
      startAt: NOW_MS - 4 * DAY_MS,
      lastAt: NOW_MS - 4 * DAY_MS + HOUR_MS,
      prompt: "this week",
    });

    const twoDays = await scan(2);

    expect(twoDays.chats).toEqual([]);
    expect(twoDays.dropped).toEqual([
      { providerId: "codex", reason: "older-than-window", count: 1 },
    ]);

    const sevenDays = await scan(7);

    expect(
      sevenDays.chats.map((chat) => chat.sourceProviderThreadId).sort(),
    ).toEqual(["stale-mtime-recent", "week"]);
  });

  it("ignores archived sessions, compressed rollouts and non-rollout files", async () => {
    const live = await writeSimpleCodexChat(home.codexHome, {
      id: "live",
      cwd: home.workDir,
      startAt: RECENT,
      lastAt: RECENT,
      prompt: "hello",
    });

    const content = await fs.readFile(live);

    await fs.mkdir(path.join(home.codexHome, "archived_sessions"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home.codexHome, "archived_sessions", "rollout-archived.jsonl"),
      content,
    );
    await fs.writeFile(
      `${live.slice(0, -".jsonl".length)}-z.jsonl.zst`,
      content,
    );
    await fs.writeFile(path.join(path.dirname(live), "notes.jsonl"), content);

    const result = await scan();

    expect(result.chats.map((chat) => chat.sourcePath)).toEqual([live]);
    expect(result.dropped).toEqual([]);
  });

  it("titles chats from the last session index entry, else from the first prompt", async () => {
    await writeSimpleCodexChat(home.codexHome, {
      id: "named",
      cwd: home.workDir,
      startAt: RECENT,
      lastAt: RECENT,
      prompt: "unused prompt",
    });
    await writeSimpleCodexChat(home.codexHome, {
      id: "unnamed",
      cwd: home.workDir,
      startAt: RECENT - HOUR_MS,
      lastAt: RECENT - HOUR_MS,
      prompt:
        "Investigate why the relay drops frames larger than eight mebibytes when the worker reconnects after sleep",
    });
    await writeJsonl(
      path.join(home.codexHome, "session_index.jsonl"),
      [
        { id: "named", thread_name: "First name", updated_at: "x" },
        { id: "other", thread_name: "Other", updated_at: "x" },
        { id: "named", thread_name: "Renamed relay notes", updated_at: "x" },
      ],
      RECENT,
    );

    const result = await scan();

    const titles = Object.fromEntries(
      result.chats.map((chat) => [chat.sourceProviderThreadId, chat.title]),
    );

    expect(titles.named).toBe("Renamed relay notes");
    expect(titles.unnamed?.length).toBeLessThanOrEqual(80);
    expect(titles.unnamed).toMatch(
      /^Investigate why the relay drops frames .*…$/,
    );
  });

  it("reads a large session_meta line and skips injected context before the first prompt", async () => {
    const id = "large-meta";

    await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, id),
      [
        codexMeta({
          id,
          cwd: home.workDir,
          at: RECENT,
          baseInstructions: "i".repeat(3 * 1024 * 1024),
        }),
        codexTaskStarted(RECENT, "t1"),
        {
          timestamp: new Date(RECENT).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
          },
        },
        codexUserMessage(RECENT + 1000, "u1", "  "),
        codexUserMessage(RECENT + 2000, "u2", "Real question"),
        codexTaskComplete(RECENT + 3000, "t1"),
      ],
      RECENT + 3000,
    );

    const [chat] = (await scan()).chats;

    expect(chat).toMatchObject({
      sourceProviderThreadId: id,
      firstPrompt: "Real question",
      title: "Real question",
      lastMessageAt: RECENT + 3000,
    });
  });

  it("accepts the legacy user_message prompt from older CLIs", async () => {
    const id = "legacy";

    await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, id),
      [
        codexMeta({
          id,
          cwd: home.workDir,
          at: RECENT,
          originator: "codex_cli_rs",
        }),
        codexEvent(RECENT + 1000, {
          type: "user_message",
          message: "Old style",
        }),
        codexEvent(RECENT + 2000, { type: "agent_message", message: "Reply" }),
      ],
      RECENT + 2000,
    );

    const result = await scan();

    expect(result.chats[0]).toMatchObject({
      firstPrompt: "Old style",
      lastMessageAt: RECENT + 2000,
    });

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath: result.chats[0]?.sourcePath ?? "",
      sourceProviderThreadId: id,
    });

    expect(read.turns).toEqual([
      {
        startedAt: RECENT + 1000,
        completedAt: RECENT + 2000,
        status: "interrupted",
        userText: "Old style",
        items: [{ type: "agentMessage", id: "imp-0-0", text: "Reply" }],
      },
    ]);
  });
  it("reports the session a forked rollout was copied from", async () => {
    const chat = (id: string, forkedFromId?: string) =>
      writeSimpleCodexChat(home.codexHome, {
        id,
        cwd: home.workDir,
        startAt: RECENT - HOUR_MS,
        lastAt: RECENT,
        prompt: `prompt for ${id}`,
        meta: forkedFromId === undefined ? {} : { forkedFromId },
      });

    const forkedPath = await chat("forked", "parent-thread");

    await chat("plain");
    await chat("empty-fork", "");

    const chats = new Map(
      (await scan()).chats.map((entry) => [
        entry.sourceProviderThreadId,
        entry.forkedFromProviderThreadId,
      ]),
    );

    expect(chats).toEqual(
      new Map([
        ["forked", "parent-thread"],
        ["plain", null],
        ["empty-fork", null],
      ]),
    );

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath: forkedPath,
      sourceProviderThreadId: "forked",
    });

    expect(read.summary.forkedFromProviderThreadId).toBe("parent-thread");
  });
});

describe("Codex readChat", () => {
  const id = "transcript";

  async function writeTranscript(): Promise<string> {
    const at = (offset: number) => RECENT + offset * 1000;

    return writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, id),
      [
        codexMeta({ id, cwd: home.workDir, at: at(0) }),
        codexTaskStarted(at(1), "t1"),
        codexUserMessage(at(2), "u1", "Fix the build"),
        codexItem(at(3), {
          type: "Reasoning",
          id: "r1",
          summary_text: ["thinking"],
          raw_content: [],
        }),
        codexItem(at(4), {
          type: "CommandExecution",
          id: "c1",
          command: ["/bin/zsh", "-lc", "pnpm build"],
          cwd: home.workDir,
          aggregated_output: "error TS2304",
          exit_code: 2,
          status: "failed",
          duration: { secs: 1, nanos: 500_000_000 },
        }),
        codexItem(at(5), {
          type: "FileChange",
          id: "f1",
          status: "completed",
          changes: {
            [path.join(home.workDir, "src", "new.ts")]: {
              type: "add",
              content: "export const a = 1;\n",
            },
            [path.join(home.workDir, "src", "old.ts")]: {
              type: "delete",
              content: "gone\n",
            },
            [path.join(home.workDir, "src", "main.ts")]: {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-a\n+b\n",
              move_path: null,
            },
          },
        }),
        codexItem(at(6), {
          type: "McpToolCall",
          id: "m1",
          server: "docs",
          tool: "search",
          arguments: { query: "tsc" },
          status: "completed",
          result: {
            content: [{ type: "text", text: "found" }],
            isError: false,
          },
        }),
        codexItem(at(7), {
          type: "McpToolCall",
          id: "m2",
          server: "docs",
          tool: "fetch",
          arguments: { url: "x" },
          status: "failed",
          result: {
            content: [{ type: "text", text: "denied" }],
            isError: true,
          },
        }),
        codexItem(at(8), {
          type: "SubAgentActivity",
          id: "s1",
          kind: "started",
          agent_thread_id: "child",
        }),
        codexAgentMessage(at(9), "a1", "Fixed it."),
        codexTaskComplete(at(10), "t1"),
        codexTaskStarted(at(11), "t2"),
        codexUserMessage(at(12), "u2", "Now run the tests"),
        codexAgentMessage(at(11), "a1", "Running."),
        codexUserMessage(at(14), "u3", "Actually stop"),
        codexTurnAborted(at(15), "t2"),
        codexTaskStarted(at(16), "t3"),
        codexAgentMessage(at(17), "a3", "Background result."),
        codexTaskComplete(at(18), "t3"),
      ],
      at(18),
    );
  }

  it("shapes turns, items and diffs from item_completed events", async () => {
    const sourcePath = await writeTranscript();

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: id,
    });

    expect(read.summary).toMatchObject({
      sourceProviderThreadId: id,
      sourcePath,
    });
    expect(read).toMatchObject({
      totalTurns: 3,
      omittedTurns: 0,
      skippedLines: 0,
    });
    expect(read.turns.map((turn) => [turn.userText, turn.status])).toEqual([
      ["Fix the build", "completed"],
      ["Now run the tests", "interrupted"],
      ["Actually stop", "interrupted"],
    ]);
    const [first, second, third] = read.turns;

    expect(first?.items).toEqual([
      {
        type: "commandExecution",
        id: "c1",
        command: "pnpm build",
        cwd: home.workDir,
        output: "error TS2304",
        exitCode: 2,
        durationMs: 1500,
      },
      {
        type: "fileChange",
        id: "f1",
        changes: [
          {
            path: path.join(home.workDir, "src", "new.ts"),
            kind: "add",
            diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export const a = 1;\n",
          },
          {
            path: path.join(home.workDir, "src", "old.ts"),
            kind: "delete",
            diff: "--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n",
          },
          {
            path: path.join(home.workDir, "src", "main.ts"),
            kind: "update",
            diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-a\n+b\n",
          },
        ],
      },
      {
        type: "toolCall",
        id: "m1",
        tool: "search",
        server: "docs",
        arguments: '{"query":"tsc"}',
        result: "found",
        error: null,
      },
      {
        type: "toolCall",
        id: "m2",
        tool: "fetch",
        server: "docs",
        arguments: '{"url":"x"}',
        result: null,
        error: "denied",
      },
      { type: "agentMessage", id: "a1", text: "Fixed it." },
    ]);
    expect(first).toMatchObject({
      startedAt: RECENT + 2000,
      completedAt: RECENT + 10_000,
    });
    expect(second?.items).toEqual([
      { type: "agentMessage", id: "imp-1-0", text: "Running." },
    ]);
    expect(second).toMatchObject({
      startedAt: RECENT + 12_000,
      completedAt: RECENT + 12_000,
    });
    expect(third?.items).toEqual([
      { type: "agentMessage", id: "a3", text: "Background result." },
    ]);
    expect(third?.completedAt).toBe(RECENT + 17_000);
  });

  it("refuses a mismatched id or a path outside the store and never changes the file", async () => {
    const sourcePath = await writeTranscript();
    const outside = path.join(home.homeDir, "rollout-copy.jsonl");

    await fs.copyFile(sourcePath, outside);
    const before = await fingerprintTree(home.homeDir);

    await expect(
      readNativeChat(home.environment(), {
        providerId: "codex",
        sourcePath,
        sourceProviderThreadId: "someone-else",
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      readNativeChat(home.environment(), {
        providerId: "codex",
        sourcePath: outside,
        sourceProviderThreadId: id,
      }),
    ).rejects.toThrow(/not inside/);
    await expect(
      readNativeChat(home.environment(), {
        providerId: "codex",
        sourcePath: path.join(
          home.codexHome,
          "sessions",
          "..",
          "..",
          "rollout-copy.jsonl",
        ),
        sourceProviderThreadId: id,
      }),
    ).rejects.toThrow(/not inside/);
    await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: id,
    });
    await scan();

    expect(await fingerprintTree(home.homeDir)).toEqual(before);
  });

  it("keeps the turns an older CLI recorded before the rollout was resumed on a newer one", async () => {
    const mixedId = "upgraded";
    const at = (offset: number) => RECENT + offset * 1000;

    const legacyUser = (offset: number, message: string) =>
      codexEvent(at(offset), { type: "user_message", message });

    const legacyAgent = (offset: number, message: string) =>
      codexEvent(at(offset), { type: "agent_message", message });

    const sourcePath = await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, mixedId),
      [
        codexMeta({ id: mixedId, cwd: home.workDir, at: at(0) }),
        codexTaskStarted(at(1), "t1"),
        legacyUser(2, "Old question one"),
        legacyAgent(3, "Old answer one"),
        codexTaskComplete(at(4), "t1"),
        codexTaskStarted(at(5), "t2"),
        legacyUser(6, "Old question two"),
        legacyAgent(7, "Old answer two"),
        codexTaskComplete(at(8), "t2"),
        codexTaskStarted(at(9), "t3"),
        legacyUser(10, "New question one"),
        codexUserMessage(at(10), "u3", "New question one"),
        legacyAgent(11, "New answer one"),
        codexAgentMessage(at(11), "a3", "New answer one"),
        codexTaskComplete(at(12), "t3"),
        codexTaskStarted(at(13), "t4"),
        codexUserMessage(at(14), "u4", "New question two"),
        legacyUser(14, "New question two"),
        codexAgentMessage(at(15), "a4", "New answer two"),
        legacyAgent(15, "New answer two"),
        codexTaskComplete(at(16), "t4"),
      ],
      at(16),
    );

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: mixedId,
    });

    expect(read.summary).toMatchObject({
      firstPrompt: "Old question one",
      title: "Old question one",
    });
    expect(read.totalTurns).toBe(4);
    expect(read.omittedTurns).toBe(0);
    expect(
      read.turns.map((turn) => [
        turn.userText,
        turn.status,
        turn.startedAt,
        turn.items.map((item) =>
          item.type === "agentMessage" ? item.text : item.type,
        ),
      ]),
    ).toEqual([
      ["Old question one", "completed", at(2), ["Old answer one"]],
      ["Old question two", "completed", at(6), ["Old answer two"]],
      ["New question one", "completed", at(10), ["New answer one"]],
      ["New question two", "completed", at(14), ["New answer two"]],
    ]);
  });

  it("imports a turn that ended with an error as interrupted with the error", async () => {
    const sourcePath = await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, "failed"),
      [
        codexMeta({ id: "failed", cwd: home.workDir, at: RECENT }),
        codexTaskStarted(RECENT, "t1"),
        codexUserMessage(RECENT + 1, "u1", "First"),
        codexAgentMessage(RECENT + 2, "a1", "Done."),
        codexTaskComplete(RECENT + 3, "t1"),
        codexTaskStarted(RECENT + 4, "t2"),
        codexUserMessage(RECENT + 5, "u2", "Second"),
        codexUserMessage(RECENT + 6, "u3", "Steer"),
        codexTaskComplete(RECENT + 7, "t2", {
          message: "You've hit your usage limit.",
          codex_error_info: "usage_limit_exceeded",
        }),
        codexTaskStarted(RECENT + 8, "t3"),
        codexTaskComplete(RECENT + 9, "t3", {
          message: "",
          codex_error_info: "unauthorized",
        }),
      ],
      RECENT + 9,
    );

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: "failed",
    });

    expect(
      read.turns.map((turn) => [turn.userText, turn.status, turn.items]),
    ).toEqual([
      [
        "First",
        "completed",
        [{ type: "agentMessage", id: "a1", text: "Done." }],
      ],
      ["Second", "interrupted", []],
      [
        "Steer",
        "interrupted",
        [
          {
            type: "toolCall",
            id: "imp-2-0",
            tool: "error",
            server: null,
            arguments: null,
            result: null,
            error: "You've hit your usage limit.",
          },
        ],
      ],
    ]);
  });

  it("counts an oversized line as skipped without failing the chat", async () => {
    const sourcePath = await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, "huge"),
      [
        codexMeta({ id: "huge", cwd: home.workDir, at: RECENT }),
        codexTaskStarted(RECENT, "t1"),
        codexUserMessage(RECENT + 1, "u1", "Summarize the log"),
        codexAgentMessage(RECENT + 2, "big", "x".repeat(17 * 1024 * 1024)),
        codexAgentMessage(RECENT + 3, "small", "Summary."),
        codexTaskComplete(RECENT + 4, "t1"),
      ],
      RECENT + 4,
    );

    const read = await readNativeChat(home.environment(), {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: "huge",
    });

    expect(read.skippedLines).toBe(1);
    expect(read.turns[0]?.items).toEqual([
      { type: "agentMessage", id: "small", text: "Summary." },
    ]);
  });
});
