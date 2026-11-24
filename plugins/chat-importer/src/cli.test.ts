import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@omnyo/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  formatRun,
  formatScan,
  runImport,
  runJson,
  selectedPreview,
  type ChatImportRunResult,
} from "./cli.js";
import type {
  ChatImporter,
  ImportChatInput,
  PreviewChat,
  PreviewOutput,
} from "./contract.js";

function result(
  index: number,
  status: ChatImportRunResult["status"],
): ChatImportRunResult {
  return {
    key: `claude-code:${String(index).padStart(36, "0")}`,
    title: `Chat ${index} `.repeat(10),
    status,
    threadId: status === "failed" ? null : `thr_${index}`,
    projectId: status === "failed" ? null : "prj_1",
    createdProject: false,
    message:
      status === "failed"
        ? `Couldn't import chat ${index}.`
        : "The oldest turn was too large to show. ".repeat(4),
    omittedTurns: 0,
    skippedLines: 0,
  };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("chat-import run output", () => {
  it("prints every result in full while it fits", () => {
    const results = [result(1, "imported"), result(2, "failed")];

    expect(JSON.parse(runJson(results))).toEqual({
      results,
      counts: { imported: 1, alreadyImported: 0, failed: 1 },
    });
  });

  it("stays under the CLI output limit and keeps failures and counts for a huge run", () => {
    const results = Array.from({ length: 9000 }, (_, index) =>
      result(index, index % 1000 === 0 ? "failed" : "imported"),
    );

    const json = runJson(results);

    const parsed = JSON.parse(json) as {
      results: ChatImportRunResult[];
      counts: Record<string, number>;
      omittedResults: number;
    };

    expect(bytes(json)).toBeLessThanOrEqual(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    expect(parsed.counts).toEqual({
      imported: 8991,
      alreadyImported: 0,
      failed: 9,
    });
    expect(parsed.results.filter((entry) => entry.status === "failed")).toEqual(
      results
        .filter((entry) => entry.status === "failed")
        .map((entry) => ({ ...entry, title: null })),
    );
    expect(parsed.results.length + parsed.omittedResults).toBe(9000);

    const text = formatRun(results);

    expect(bytes(text)).toBeLessThanOrEqual(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "8991 imported · 0 already imported · 9 failed",
    );
  });
});

describe("chat-import run", () => {
  function previewChat(
    id: string,
    cwd: string,
    overrides: Partial<PreviewChat> = {},
  ): PreviewChat {
    return {
      key: `claude-code:${id}`,
      providerId: "claude-code",
      sourceProviderThreadId: id,
      sourcePath: `/home/ada/.claude/projects/x/${id}.jsonl`,
      title: `Chat ${id}`,
      firstPrompt: "Hello",
      cwd,
      realCwd: cwd,
      projectRoot: { path: cwd, kind: "folder", mainRepositoryPath: null },
      client: "cli",
      createdAt: 0,
      lastMessageAt: 0,
      sizeBytes: 1,
      status: "ready",
      reason: null,
      threadId: null,
      project: null,
      ...overrides,
    };
  }

  const preview: PreviewOutput = {
    hostId: "host-1",
    hosts: [],
    days: 2,
    nowMs: 0,
    cutoffMs: 0,
    homeDir: "/home/ada",
    roots: { codex: null, claude: null },
    projects: [],
    counts: {
      found: 3,
      ready: 2,
      alreadyImported: 0,
      unavailable: 1,
      byProvider: {
        codex: { found: 0, ready: 0 },
        "claude-code": { found: 3, ready: 2 },
      },
    },
    chats: [
      previewChat("parent", "/home/ada/proj"),
      previewChat("nested", "/home/ada/proj/sub"),
      previewChat("copy", "/home/ada/proj", {
        status: "omnyo-chat",
        reason: "This chat is a copy of a chat in Omnyo.",
        threadId: "thr-omnyo",
      }),
    ],
    dropped: [],
    newProjects: [],
  };

  function importer(calls: ImportChatInput[]): ChatImporter {
    return {
      hosts: async () => ({ primaryHostId: "host-1", hosts: [] }),
      preview: async () => preview,
      importChat: async (input) => {
        calls.push(input);

        return {
          status: "imported",
          threadId: `thr-${input.sourceProviderThreadId}`,
          projectId: "p-1",
          createdProject: true,
          message: null,
          omittedTurns: 0,
          skippedLines: 0,
        };
      },
    };
  }

  it("imports a named chat into the project planned for the named chats only", async () => {
    const calls: ImportChatInput[] = [];

    await runImport(importer(calls), {
      days: 2,
      hostId: undefined,
      chats: ["claude-code:nested"],
    });

    expect(calls.map((call) => call.project)).toEqual([
      { kind: "new", name: "sub", path: "/home/ada/proj/sub" },
    ]);
  });

  it("previews the named chats exactly where run files them", async () => {
    const calls: ImportChatInput[] = [];
    const scoped = selectedPreview(preview, ["claude-code:nested"]);

    await runImport(importer(calls), {
      days: 2,
      hostId: undefined,
      chats: ["claude-code:nested"],
    });

    expect(scoped.chats.map((chat) => [chat.key, chat.project])).toEqual([
      ["claude-code:nested", calls[0]?.project],
    ]);
    expect(scoped.newProjects).toEqual([
      { name: "sub", path: "/home/ada/proj/sub" },
    ]);
    expect(scoped.counts.found).toBe(1);
    expect(formatScan(scoped)).toContain(
      "New projects: sub (/home/ada/proj/sub)",
    );
    expect(selectedPreview(preview, [])).toBe(preview);
  });

  it("reports a named chat that is not ready without importing it", async () => {
    const calls: ImportChatInput[] = [];

    const results = await runImport(importer(calls), {
      days: 2,
      hostId: undefined,
      chats: ["claude-code:copy"],
    });

    expect(calls).toEqual([]);
    expect(results).toEqual([
      {
        key: "claude-code:copy",
        title: "Chat copy",
        status: "already-imported",
        threadId: "thr-omnyo",
        projectId: null,
        createdProject: false,
        message: "This chat is a copy of a chat in Omnyo.",
        omittedTurns: 0,
        skippedLines: 0,
      },
    ]);
  });
});
