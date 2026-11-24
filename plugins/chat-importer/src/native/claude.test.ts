import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNativeChat, scanNativeChats } from "../host.js";
import {
  claudeAssistant,
  claudeSessionPath,
  claudeSlug,
  claudeToolResult,
  claudeUser,
  createFixtureHome,
  DAY_MS,
  fingerprintTree,
  HOUR_MS,
  NOW_MS,
  writeJsonl,
  type ClaudeLineBase,
  type FixtureHome,
  type JsonLine,
} from "./testing/fixture-store.js";

let home: FixtureHome;

beforeEach(async () => {
  home = await createFixtureHome();
});

afterEach(async () => {
  await home.cleanup();
});

const RECENT = NOW_MS - 3 * HOUR_MS;

function base(sessionId: string, entrypoint = "cli"): ClaudeLineBase {
  return { sessionId, cwd: home.workDir, entrypoint };
}

async function writeSession(
  sessionId: string,
  lines: readonly (JsonLine | string)[],
  options: { mtimeMs?: number; projectDirName?: string } = {},
): Promise<string> {
  return writeJsonl(
    claudeSessionPath(
      home.claudeDir,
      options.projectDirName ?? claudeSlug(home.workDir),
      sessionId,
    ),
    lines,
    options.mtimeMs ?? RECENT + 60_000,
  );
}

async function writeSimpleSession(
  sessionId: string,
  entrypoint = "cli",
  extra: readonly JsonLine[] = [],
): Promise<string> {
  const line = base(sessionId, entrypoint);

  return writeSession(sessionId, [
    claudeUser(line, RECENT - HOUR_MS, `Question in ${sessionId}`),
    claudeAssistant(line, RECENT, `msg-${sessionId}`, {
      type: "text",
      text: "Answer",
    }),
    ...extra,
  ]);
}

function scan(platform: NodeJS.Platform = "darwin", days = 2) {
  return scanNativeChats(home.environment(platform), {
    days,
    nowMs: NOW_MS,
    resolvePaths: [],
  });
}

describe("Claude Code scan", () => {
  it("keeps interactive entrypoints and drops SDK, sidechain-only and subagent logs", async () => {
    await writeSimpleSession("cli-chat", "cli");
    await writeSimpleSession("vscode-chat", "claude-vscode");
    await writeSimpleSession("desktop-chat", "claude-desktop");
    await writeSimpleSession("sdk-chat", "sdk-cli");
    await writeSimpleSession("py-chat", "sdk-py");
    await writeSession("side-chat", [
      claudeUser(base("side-chat"), RECENT, "worker task", {
        isSidechain: true,
      }),
    ]);
    await writeSession("meta-only", [
      {
        type: "permission-mode",
        permissionMode: "default",
        sessionId: "meta-only",
      },
    ]);
    await writeSession("hooks-only", [
      claudeUser(
        base("hooks-only"),
        RECENT,
        "<local-command-caveat>x</local-command-caveat>",
        {
          isMeta: true,
        },
      ),
      claudeUser(
        base("hooks-only"),
        RECENT,
        "<system-reminder>ctx</system-reminder>",
      ),
    ]);
    await writeJsonl(
      path.join(
        home.claudeDir,
        "projects",
        claudeSlug(home.workDir),
        "cli-chat",
        "subagents",
        "agent-1.jsonl",
      ),
      [
        claudeUser(base("cli-chat"), RECENT, "subagent prompt", {
          isSidechain: true,
        }),
      ],
      RECENT,
    );

    const result = await scan();

    expect(
      result.chats
        .map((chat) => [chat.sourceProviderThreadId, chat.client])
        .sort(),
    ).toEqual([
      ["cli-chat", "cli"],
      ["desktop-chat", "desktop"],
      ["vscode-chat", "ide"],
    ]);
    expect(result.dropped).toEqual([
      { providerId: "claude-code", reason: "no-user-message", count: 2 },
      { providerId: "claude-code", reason: "scripted-session", count: 2 },
      { providerId: "claude-code", reason: "subagent-session", count: 1 },
    ]);
    expect(result.roots).toEqual({ codex: null, claude: home.claudeDir });
    expect(
      result.chats.find((chat) => chat.sourceProviderThreadId === "cli-chat"),
    ).toMatchObject({
      providerId: "claude-code",
      cwd: home.workDir,
      cwdExists: true,
      cwdMatchesStore: true,
      firstPrompt: "Question in cli-chat",
      title: "Question in cli-chat",
      createdAt: RECENT - HOUR_MS,
      lastMessageAt: RECENT,
    });
  });

  it("finds the first real prompt behind meta lines, wrappers and tool results", async () => {
    const line = base("prompt-rules");

    await writeSession("prompt-rules", [
      { type: "file-history-snapshot", messageId: "m", snapshot: {} },
      claudeUser(
        line,
        RECENT - 10,
        "<local-command-caveat>Caveat</local-command-caveat>",
        {
          isMeta: true,
        },
      ),
      claudeUser(
        line,
        RECENT - 9,
        "<local-command-stdout>ok</local-command-stdout>",
      ),
      claudeUser(line, RECENT - 8, "<bash-input>ls</bash-input>"),
      claudeUser(
        line,
        RECENT - 7,
        "<task-notification>done</task-notification>",
        {
          origin: { kind: "task-notification" },
        },
      ),
      claudeUser(line, RECENT - 6, "Summary of the earlier chat", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      claudeToolResult(line, RECENT - 5, "toolu_1", "result"),
      claudeUser(line, RECENT - 4, [
        { type: "text", text: "[Request interrupted by user]" },
      ]),
      claudeUser(
        line,
        RECENT - 3,
        "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>",
      ),
    ]);

    const [chat] = (await scan()).chats;

    expect(chat).toMatchObject({
      firstPrompt: "/review PR 12",
      title: "/review PR 12",
    });
  });

  it("treats a system local_command line as the output of a preceding slash command", async () => {
    function clearLines(sessionId: string, at: number): JsonLine[] {
      const line = base(sessionId);

      return [
        claudeUser(
          line,
          at,
          "<local-command-caveat>Caveat</local-command-caveat>",
          { isMeta: true },
        ),
        claudeUser(
          line,
          at + 1,
          "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
        ),
        {
          type: "system",
          subtype: "local_command",
          content: "<local-command-stdout></local-command-stdout>",
          level: "info",
          isMeta: false,
          isSidechain: false,
          timestamp: new Date(at + 2).toISOString(),
          cwd: home.workDir,
          sessionId,
          entrypoint: "cli",
        },
      ];
    }

    await writeSession("cleared", [
      ...clearLines("cleared", RECENT - 10),
      claudeUser(base("cleared"), RECENT - 5, "Real first prompt"),
      claudeAssistant(base("cleared"), RECENT, "m1", {
        type: "text",
        text: "ok",
      }),
    ]);
    await writeSession("only-clear", clearLines("only-clear", RECENT));

    const result = await scan();

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]).toMatchObject({
      sourceProviderThreadId: "cleared",
      firstPrompt: "Real first prompt",
      title: "Real first prompt",
    });
    expect(result.dropped).toEqual([
      { providerId: "claude-code", reason: "no-user-message", count: 1 },
    ]);

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath: result.chats[0]?.sourcePath ?? "",
      sourceProviderThreadId: "cleared",
    });

    expect(read.turns.map((turn) => turn.userText)).toEqual([
      "Real first prompt",
    ]);
  });

  it("prefers the latest custom title over AI titles", async () => {
    await writeSimpleSession("titled", "cli", [
      { type: "ai-title", aiTitle: "Early AI title", sessionId: "titled" },
      { type: "custom-title", customTitle: "Old custom", sessionId: "titled" },
      {
        type: "custom-title",
        customTitle: "My renamed chat",
        sessionId: "titled",
      },
      { type: "ai-title", aiTitle: "Later AI title", sessionId: "titled" },
    ]);
    await writeSimpleSession("ai-titled", "cli", [
      { type: "ai-title", aiTitle: "First AI", sessionId: "ai-titled" },
      { type: "ai-title", aiTitle: "Fix sidebar drag", sessionId: "ai-titled" },
    ]);

    const titles = Object.fromEntries(
      (await scan()).chats.map((chat) => [
        chat.sourceProviderThreadId,
        chat.title,
      ]),
    );

    expect(titles).toEqual({
      titled: "My renamed chat",
      "ai-titled": "Fix sidebar drag",
    });
  });

  it("selects the cwd whose slug matches the project folder, case-insensitively on macOS", async () => {
    const other = path.join(home.homeDir, "elsewhere");
    const sessionId = "moved";

    const lines = [
      claudeUser(
        { ...base(sessionId), cwd: other },
        RECENT - 3,
        "Start elsewhere",
      ),
      claudeUser(base(sessionId), RECENT - 2, "Then here"),
      claudeAssistant(base(sessionId), RECENT, "m1", {
        type: "text",
        text: "ok",
      }),
    ];

    await writeSession(sessionId, lines, {
      projectDirName: claudeSlug(home.workDir).toUpperCase(),
    });

    const [mac] = (await scan("darwin")).chats;

    expect(mac).toMatchObject({
      cwd: home.workDir,
      cwdMatchesStore: true,
      firstPrompt: "Start elsewhere",
    });

    const [linux] = (await scan("linux")).chats;

    expect(linux).toMatchObject({
      cwd: other,
      cwdMatchesStore: false,
      cwdExists: false,
      projectRoot: null,
    });
  });

  it("uses the last message in the tail for the window and ignores trailing metadata time", async () => {
    await writeSession(
      "old",
      [
        claudeUser(base("old"), NOW_MS - 5 * DAY_MS, "Old question"),
        claudeAssistant(base("old"), NOW_MS - 5 * DAY_MS + 1000, "m", {
          type: "text",
          text: "Old answer",
        }),
        { type: "ai-title", aiTitle: "Old chat", sessionId: "old" },
        { type: "last-prompt", leafUuid: "x", sessionId: "old" },
      ],
      { mtimeMs: RECENT },
    );

    expect((await scan()).dropped).toEqual([
      { providerId: "claude-code", reason: "older-than-window", count: 1 },
    ]);
    expect((await scan("darwin", 7)).chats).toHaveLength(1);
  });

  it("drops a session whose lines carry a different session id", async () => {
    await writeSession("renamed-file", [
      claudeUser(base("original-id"), RECENT, "Question"),
    ]);

    expect((await scan()).dropped).toEqual([
      { providerId: "claude-code", reason: "unreadable", count: 1 },
    ]);
  });
  it("matches a project folder that Claude Code truncated and hashed for a long cwd", async () => {
    const cwd = path.join(home.workDir, "a".repeat(120), "b".repeat(120));
    const slug = claudeSlug(cwd);
    const sessionId = "long-cwd";

    expect(slug.length).toBeGreaterThan(200);
    await fs.mkdir(cwd, { recursive: true });
    await writeSession(
      sessionId,
      [
        claudeUser({ sessionId, cwd }, RECENT - 2, "Deep question"),
        claudeAssistant({ sessionId, cwd }, RECENT, "m1", {
          type: "text",
          text: "ok",
        }),
      ],
      { projectDirName: `${slug.slice(0, 200)}-1x2y3z` },
    );
    await writeSession(
      "wrong-prefix",
      [
        claudeUser(
          { sessionId: "wrong-prefix", cwd },
          RECENT - 2,
          "Other question",
        ),
      ],
      { projectDirName: `${slug.slice(0, 199)}X-1x2y3z` },
    );
    await writeSession(
      "no-hash",
      [claudeUser({ sessionId: "no-hash", cwd }, RECENT - 2, "Bare prefix")],
      { projectDirName: `${slug.slice(0, 200)}-` },
    );

    const chats = new Map(
      (await scan("linux")).chats.map((chat) => [
        chat.sourceProviderThreadId,
        chat,
      ]),
    );

    expect(chats.get(sessionId)).toMatchObject({
      cwd,
      cwdMatchesStore: true,
      cwdExists: true,
    });
    expect(chats.get("wrong-prefix")?.cwdMatchesStore).toBe(false);
    expect(chats.get("no-hash")?.cwdMatchesStore).toBe(false);
  });

  it("reports the session a forked chat was copied from", async () => {
    const forked = base("forked-chat");
    const forkedFrom = { sessionId: "parent-session", messageUuid: "m-1" };

    const sourcePath = await writeSession("forked-chat", [
      { type: "summary", summary: "x", leafUuid: "l" },
      claudeUser(forked, RECENT - 5, "side work", {
        isSidechain: true,
        forkedFrom: { sessionId: "sidechain-parent", messageUuid: "s" },
      }),
      claudeUser(forked, RECENT - 4, "Original question", { forkedFrom }),
      claudeAssistant(
        forked,
        RECENT - 3,
        "m1",
        { type: "text", text: "Original answer" },
        { forkedFrom },
      ),
      claudeUser(forked, RECENT - 2, "Follow-up in the fork"),
      claudeAssistant(forked, RECENT, "m2", { type: "text", text: "Done" }),
    ]);

    await writeSimpleSession("plain-chat");

    const chats = new Map(
      (await scan()).chats.map((chat) => [chat.sourceProviderThreadId, chat]),
    );

    expect(chats.get("forked-chat")?.forkedFromProviderThreadId).toBe(
      "parent-session",
    );
    expect(chats.get("plain-chat")?.forkedFromProviderThreadId).toBeNull();

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: "forked-chat",
    });

    expect(read.summary.forkedFromProviderThreadId).toBe("parent-session");
  });
});

describe("Claude Code readChat", () => {
  const sessionId = "transcript";

  async function writeTranscript(): Promise<string> {
    const line = base(sessionId);
    const at = (offset: number) => RECENT + offset * 1000;
    const file = (name: string) => path.join(home.workDir, name);

    return writeSession(sessionId, [
      claudeUser(line, at(0), "Please fix the parser"),
      claudeAssistant(line, at(1), "msg1", {
        type: "thinking",
        thinking: "hmm",
        signature: "s",
      }),
      claudeAssistant(line, at(1), "msg1", { type: "text", text: "Looking." }),
      claudeAssistant(line, at(1), "msg1", { type: "text", text: "Found it." }),
      claudeAssistant(line, at(2), "msg1", {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: "pnpm test", description: "Run tests" },
      }),
      claudeToolResult(line, at(3), "toolu_bash", "combined", {
        isError: true,
        toolUseResult: {
          stdout: "1 failed",
          stderr: "trace",
          interrupted: false,
        },
      }),
      claudeAssistant(line, at(4), "msg2", {
        type: "tool_use",
        id: "toolu_edit",
        name: "Edit",
        input: {
          file_path: file("src/parse.ts"),
          old_string: "a\nb",
          new_string: "c",
        },
      }),
      claudeToolResult(line, at(5), "toolu_edit", "updated", {
        toolUseResult: {
          filePath: file("src/parse.ts"),
          structuredPatch: [
            {
              oldStart: 4,
              oldLines: 3,
              newStart: 4,
              newLines: 2,
              lines: [" x", "-a", "-b", "+c"],
            },
          ],
        },
      }),
      claudeAssistant(line, at(6), "msg3", {
        type: "tool_use",
        id: "toolu_multi",
        name: "MultiEdit",
        input: {
          file_path: file("src/b.ts"),
          edits: [
            { old_string: "one", new_string: "1" },
            { old_string: "two", new_string: "2" },
          ],
        },
      }),
      claudeToolResult(line, at(6), "toolu_multi", "ok"),
      claudeAssistant(line, at(7), "msg4", {
        type: "tool_use",
        id: "toolu_write",
        name: "Write",
        input: { file_path: file("README.md"), content: "# Title\n" },
      }),
      claudeToolResult(line, at(7), "toolu_write", "created", {
        toolUseResult: {
          type: "create",
          filePath: file("README.md"),
          structuredPatch: [],
        },
      }),
      claudeAssistant(line, at(8), "msg5", {
        type: "tool_use",
        id: "toolu_failed_edit",
        name: "Edit",
        input: {
          file_path: file("src/c.ts"),
          old_string: "zz",
          new_string: "yy",
        },
      }),
      claudeToolResult(line, at(8), "toolu_failed_edit", "String not found", {
        isError: true,
        toolUseResult: "Error: String not found",
      }),
      claudeAssistant(line, at(9), "msg6", {
        type: "tool_use",
        id: "toolu_read",
        name: "Read",
        input: { file_path: file("src/parse.ts") },
      }),
      claudeToolResult(line, at(9), "toolu_read", [
        { type: "text", text: "file body" },
      ]),
      claudeUser(line, at(10), "subagent prompt", { isSidechain: true }),
      claudeAssistant(
        line,
        at(10),
        "side",
        { type: "text", text: "sidechain" },
        { isSidechain: true },
      ),
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: new Date(at(11)).toISOString(),
      },
      claudeUser(line, at(11), "Compacted summary", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      claudeAssistant(line, at(12), "msg7", { type: "text", text: "Done." }),
      "{broken json",
      claudeUser(line, at(13), "Next step"),
      claudeAssistant(line, at(14), "msg8", { type: "text", text: "Working" }),
      claudeUser(line, at(15), [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ]),
    ]);
  }

  it("merges assistant lines, pairs tool results and builds diffs", async () => {
    const sourcePath = await writeTranscript();

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: sessionId,
    });

    expect(read).toMatchObject({
      totalTurns: 2,
      omittedTurns: 0,
      skippedLines: 1,
    });
    const [first, second] = read.turns;

    expect(first).toMatchObject({
      userText: "Please fix the parser",
      status: "completed",
      startedAt: RECENT,
      completedAt: RECENT + 12_000,
    });
    expect(first?.items).toEqual([
      { type: "agentMessage", id: "msg1", text: "Looking.\n\nFound it." },
      {
        type: "commandExecution",
        id: "toolu_bash",
        command: "pnpm test",
        cwd: home.workDir,
        output: "1 failed\ntrace",
        exitCode: 1,
        durationMs: null,
      },
      {
        type: "fileChange",
        id: "toolu_edit",
        changes: [
          {
            path: path.join(home.workDir, "src/parse.ts"),
            kind: "update",
            diff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -4,3 +4,2 @@\n x\n-a\n-b\n+c\n",
          },
        ],
      },
      {
        type: "fileChange",
        id: "toolu_multi",
        changes: [
          {
            path: path.join(home.workDir, "src/b.ts"),
            kind: "update",
            diff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-one\n+1\n@@ -1,1 +1,1 @@\n-two\n+2\n",
          },
        ],
      },
      {
        type: "fileChange",
        id: "toolu_write",
        changes: [
          {
            path: path.join(home.workDir, "README.md"),
            kind: "add",
            diff: "--- /dev/null\n+++ b/README.md\n@@ -0,0 +1,1 @@\n+# Title\n",
          },
        ],
      },
      {
        type: "toolCall",
        id: "toolu_failed_edit",
        tool: "Edit",
        server: null,
        arguments: JSON.stringify({
          file_path: path.join(home.workDir, "src/c.ts"),
          old_string: "zz",
          new_string: "yy",
        }),
        result: null,
        error: "String not found",
      },
      {
        type: "toolCall",
        id: "toolu_read",
        tool: "Read",
        server: null,
        arguments: JSON.stringify({
          file_path: path.join(home.workDir, "src/parse.ts"),
        }),
        result: "file body",
        error: null,
      },
      { type: "agentMessage", id: "msg7", text: "Done." },
    ]);
    expect(second).toMatchObject({
      userText: "Next step",
      status: "interrupted",
      items: [{ type: "agentMessage", id: "msg8", text: "Working" }],
    });
  });

  it("uses tool_result text for Bash output when no structured result exists", async () => {
    const line = base("bash-plain");

    const sourcePath = await writeSession("bash-plain", [
      claudeUser(line, RECENT, "List files"),
      claudeAssistant(line, RECENT + 1, "m1", {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
      }),
      claudeToolResult(line, RECENT + 2, "t1", "a.txt", { isError: false }),
    ]);

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: "bash-plain",
    });

    expect(read.turns[0]?.items).toEqual([
      {
        type: "commandExecution",
        id: "t1",
        command: "ls",
        cwd: home.workDir,
        output: "a.txt",
        exitCode: 0,
        durationMs: null,
      },
    ]);
  });

  it("uses tool_result text for Bash output when stdout and stderr are empty", async () => {
    const line = base("bash-background");

    const sourcePath = await writeSession("bash-background", [
      claudeUser(line, RECENT, "Start the server"),
      claudeAssistant(line, RECENT + 1, "m1", {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "pnpm dev", run_in_background: true },
      }),
      claudeToolResult(
        line,
        RECENT + 2,
        "t1",
        "Command running in background with ID: bg1",
        {
          toolUseResult: {
            stdout: "",
            stderr: "",
            interrupted: false,
            backgroundTaskId: "bg1",
          },
        },
      ),
    ]);

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: "bash-background",
    });

    expect(read.turns[0]?.items).toMatchObject([
      {
        type: "commandExecution",
        output: "Command running in background with ID: bg1",
        exitCode: 0,
      },
    ]);
  });

  it("starts a turn for a human prompt queued into a running turn", async () => {
    const sessionId = "queued";
    const line = base(sessionId);
    const at = (offset: number) => RECENT + offset * 1000;

    function queuedAttachment(
      offset: number,
      prompt: unknown,
      extra: JsonLine = {},
    ): JsonLine {
      return {
        type: "attachment",
        isSidechain: false,
        timestamp: new Date(at(offset)).toISOString(),
        sessionId,
        cwd: home.workDir,
        entrypoint: "cli",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "human" },
          humanTurn: true,
          prompt,
          ...extra,
        },
      };
    }

    const sourcePath = await writeSession(sessionId, [
      claudeUser(line, at(0), "Run the tests"),
      claudeAssistant(line, at(1), "m1", {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "pnpm test" },
      }),
      claudeAssistant(line, at(1), "m1", {
        type: "tool_use",
        id: "t2",
        name: "Read",
        input: { file_path: "a.ts" },
      }),
      claudeToolResult(line, at(2), "t1", "passed"),
      queuedAttachment(3, "Also check lint"),
      queuedAttachment(3, "<task-notification>done</task-notification>", {
        commandMode: "task-notification",
        origin: undefined,
      }),
      queuedAttachment(3, "peer note", { origin: { kind: "peer" } }),
      claudeToolResult(line, at(4), "t2", "file body"),
      claudeAssistant(line, at(5), "m2", {
        type: "text",
        text: "Lint is clean.",
      }),
      queuedAttachment(6, [{ type: "text", text: "Then commit" }]),
      claudeUser(line, at(6), "Then commit"),
      claudeAssistant(line, at(7), "m3", { type: "text", text: "Committed." }),
    ]);

    const read = await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: sessionId,
    });

    expect(
      read.turns.map((turn) => [
        turn.userText,
        turn.items.map((item) =>
          item.type === "agentMessage"
            ? item.text
            : item.type === "commandExecution"
              ? item.output
              : item.type === "toolCall"
                ? item.result
                : item.type,
        ),
      ]),
    ).toEqual([
      ["Run the tests", ["passed", "file body"]],
      ["Also check lint", ["Lint is clean."]],
      ["Then commit", ["Committed."]],
    ]);
  });

  it("refuses a different session id or a file outside the projects folder and leaves files unchanged", async () => {
    const sourcePath = await writeTranscript();
    const stray = path.join(home.claudeDir, `${sessionId}.jsonl`);

    await fs.copyFile(sourcePath, stray);
    const before = await fingerprintTree(home.homeDir);

    await expect(
      readNativeChat(home.environment(), {
        providerId: "claude-code",
        sourcePath,
        sourceProviderThreadId: "other-session",
      }),
    ).rejects.toThrow(/not a chat transcript/);
    await expect(
      readNativeChat(home.environment(), {
        providerId: "claude-code",
        sourcePath: stray,
        sourceProviderThreadId: sessionId,
      }),
    ).rejects.toThrow(/not inside/);
    await readNativeChat(home.environment(), {
      providerId: "claude-code",
      sourcePath,
      sourceProviderThreadId: sessionId,
    });
    await scan();

    expect(await fingerprintTree(home.homeDir)).toEqual(before);
  });
});
