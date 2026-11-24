import fs from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_LIMITS, readChatOutputSchema } from "./host-contract.js";
import { createChatImporterHostEntry } from "./host.js";
import {
  claudeAssistant,
  claudeSessionPath,
  claudeSlug,
  claudeUser,
  codexAgentMessage,
  codexMeta,
  codexRolloutPath,
  codexTaskComplete,
  codexTaskStarted,
  codexUserMessage,
  createFixtureHome,
  fingerprintTree,
  HOUR_MS,
  NOW_MS,
  writeJsonl,
  writeSimpleCodexChat,
  type FixtureHome,
  type JsonLine,
} from "./native/testing/fixture-store.js";

let home: FixtureHome;

beforeEach(async () => {
  home = await createFixtureHome();
});

afterEach(async () => {
  await home.cleanup();
});

const RECENT = NOW_MS - 2 * HOUR_MS;

function harness(env: Readonly<Record<string, string>> = {}) {
  return experimental_createHostEntryHarness(
    createChatImporterHostEntry({
      homeDir: home.homeDir,
      env,
      platform: "darwin",
    }),
  );
}

async function makeWorktree(): Promise<{
  repository: string;
  worktree: string;
}> {
  const repository = path.join(home.homeDir, "projects", "app");
  const adminDir = path.join(repository, ".git", "worktrees", "feature");
  const worktree = path.join(home.homeDir, "worktrees", "app", "feature");

  await fs.mkdir(adminDir, { recursive: true });
  await fs.writeFile(path.join(adminDir, "commondir"), "../..\n");
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${adminDir}\n`);

  return { repository, worktree };
}

describe("chat importer host entry", () => {
  it("scans both stores through the host contract and leaves every native file unchanged", async () => {
    const { repository, worktree } = await makeWorktree();

    await writeSimpleCodexChat(home.codexHome, {
      id: "codex-chat",
      cwd: worktree,
      startAt: RECENT - HOUR_MS,
      lastAt: RECENT,
      prompt: "Ship the relay fix",
    });
    await writeJsonl(
      path.join(home.codexHome, "session_index.jsonl"),
      [{ id: "codex-chat", thread_name: "Relay fix", updated_at: "x" }],
      RECENT,
    );
    const claudeLine = { sessionId: "claude-chat", cwd: repository };

    await writeJsonl(
      claudeSessionPath(home.claudeDir, claudeSlug(repository), "claude-chat"),
      [
        claudeUser(claudeLine, RECENT - 30_000, "Review the sidebar"),
        claudeAssistant(claudeLine, RECENT - 10_000, "m1", {
          type: "text",
          text: "Reviewed.",
        }),
      ],
      RECENT,
    );
    await writeSimpleCodexChat(home.codexHome, {
      id: "omnyo-chat",
      cwd: repository,
      startAt: RECENT,
      lastAt: RECENT,
      prompt: "managed",
      meta: { originator: "omnyo", threadSource: null },
    });
    const before = await fingerprintTree(home.homeDir);
    const host = harness();

    const scan = await host.experimental_call("scan", {
      days: 2,
      nowMs: NOW_MS,
      resolvePaths: [],
    });

    expect(scan.homeDir).toBe(home.homeDir);
    expect(scan.roots).toEqual({
      codex: home.codexHome,
      claude: home.claudeDir,
    });
    expect(scan.chats.map((chat) => chat.sourceProviderThreadId)).toEqual([
      "codex-chat",
      "claude-chat",
    ]);
    expect(scan.chats[0]).toMatchObject({
      title: "Relay fix",
      firstPrompt: "Ship the relay fix",
      client: "cli",
      projectRoot: {
        path: worktree,
        kind: "git-worktree",
        mainRepositoryPath: repository,
      },
    });
    expect(scan.chats[1]).toMatchObject({
      projectRoot: { path: repository, kind: "git", mainRepositoryPath: null },
    });
    expect(scan.dropped).toEqual([
      { providerId: "codex", reason: "omnyo-session", count: 1 },
    ]);

    for (const chat of scan.chats) {
      const read = await host.experimental_call("readChat", {
        providerId: chat.providerId,
        sourcePath: chat.sourcePath,
        sourceProviderThreadId: chat.sourceProviderThreadId,
      });

      expect(read.summary).toEqual(chat);
      expect(read.turns).toHaveLength(1);
    }

    expect(await fingerprintTree(home.homeDir)).toEqual(before);
    await host.experimental_dispose();
  });

  it("resolves stores from CODEX_HOME and CLAUDE_CONFIG_DIR", async () => {
    const codexHome = path.join(home.homeDir, "alt", "codex");

    await writeSimpleCodexChat(codexHome, {
      id: "alt",
      cwd: home.workDir,
      startAt: RECENT,
      lastAt: RECENT,
      prompt: "hello",
    });
    await writeSimpleCodexChat(home.codexHome, {
      id: "default-home",
      cwd: home.workDir,
      startAt: RECENT,
      lastAt: RECENT,
      prompt: "hidden",
    });

    const host = harness({
      CODEX_HOME: "~/alt/codex",
      CLAUDE_CONFIG_DIR: "missing",
    });

    const scan = await host.experimental_call("scan", {
      days: 1,
      nowMs: NOW_MS,
      resolvePaths: [],
    });

    expect(scan.roots).toEqual({ codex: codexHome, claude: null });
    expect(scan.chats.map((chat) => chat.sourceProviderThreadId)).toEqual([
      "alt",
    ]);
    await host.experimental_dispose();
  });

  it("rejects a day window outside 1 to 365", async () => {
    const host = harness();

    await expect(
      host.experimental_call("scan", {
        days: 0,
        nowMs: NOW_MS,
        resolvePaths: [],
      }),
    ).rejects.toThrow();
    await expect(
      host.experimental_call("scan", {
        days: 366,
        nowMs: NOW_MS,
        resolvePaths: [],
      }),
    ).rejects.toThrow();
    await host.experimental_dispose();
  });

  it("resolves requested project paths in request order, with null for paths that do not resolve", async () => {
    const linked = path.join(home.homeDir, "linked-app");
    const missing = path.join(home.homeDir, "gone", "app");

    await fs.symlink(home.workDir, linked, "dir");
    const host = harness();

    const scan = await host.experimental_call("scan", {
      days: 1,
      nowMs: NOW_MS,
      resolvePaths: [linked, missing, home.workDir, "relative/app", linked],
    });

    expect(scan.resolvedPaths).toEqual([
      { path: linked, realPath: home.workDir },
      { path: missing, realPath: null },
      { path: home.workDir, realPath: home.workDir },
      { path: "relative/app", realPath: null },
      { path: linked, realPath: home.workDir },
    ]);
    await expect(
      host.experimental_call("scan", {
        days: 1,
        nowMs: NOW_MS,
        resolvePaths: Array.from({ length: 1001 }, () => home.workDir),
      }),
    ).rejects.toThrow();
    await host.experimental_dispose();
  });

  it("drops the oldest turns when the chat exceeds the serialized budget", async () => {
    const id = "long-chat";
    const turnCount = 90;

    const lines: JsonLine[] = [
      codexMeta({ id, cwd: home.workDir, at: RECENT }),
    ];

    for (let index = 0; index < turnCount; index += 1) {
      const at = RECENT + index * 1000;

      lines.push(
        codexTaskStarted(at, `t${index}`),
        codexUserMessage(at, `u${index}`, `Question ${index}`),
        codexAgentMessage(
          at + 1,
          `a${index}`,
          `${index} `.padEnd(HISTORY_LIMITS.agentTextChars + 500, "w"),
        ),
        codexTaskComplete(at + 2, `t${index}`),
      );
    }

    const sourcePath = await writeJsonl(
      codexRolloutPath(home.codexHome, RECENT, id),
      lines,
      RECENT + turnCount * 1000,
    );

    const host = harness();

    const read = await host.experimental_call("readChat", {
      providerId: "codex",
      sourcePath,
      sourceProviderThreadId: id,
    });

    expect(read.totalTurns).toBe(turnCount);
    expect(read.omittedTurns).toBeGreaterThan(0);
    expect(read.turns).toHaveLength(turnCount - read.omittedTurns);
    expect(read.turns.at(-1)?.userText).toBe(`Question ${turnCount - 1}`);
    expect(read.turns[0]?.userText).toBe(`Question ${read.omittedTurns}`);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(
      HISTORY_LIMITS.serializedChatBytes,
    );
    expect(read.turns[0]?.items[0]).toMatchObject({ type: "agentMessage" });
    const firstItem = read.turns[0]?.items[0];

    expect(
      firstItem?.type === "agentMessage" ? firstItem.text.length : 0,
    ).toBeLessThanOrEqual(HISTORY_LIMITS.agentTextChars);
    expect(readChatOutputSchema.safeParse(read).success).toBe(true);
    await host.experimental_dispose();
  });
});
