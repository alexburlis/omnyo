import {
  createFakePluginHost,
  makeHostResponse,
  type ExperimentalFakeHostRpcCall,
} from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runImport } from "./cli.js";
import type { ChatImporter, PreviewOutput, TargetProject } from "./contract.js";
import type {
  NativeChatSummary,
  ReadChatOutput,
  ScanInput,
  ScanOutput,
} from "./host-contract.js";
import plugin from "./server.js";
import { chatKey, selectionPlan } from "./service.js";

const HOME = "/Users/ada";

const NOW = Date.now();

function summary(
  overrides: Partial<NativeChatSummary> = {},
): NativeChatSummary {
  const cwd = overrides.cwd ?? `${HOME}/code/app`;

  return {
    providerId: "claude-code",
    sourceProviderThreadId: "s-1",
    sourcePath: `${HOME}/.claude/projects/x/s-1.jsonl`,
    cwd,
    realCwd: cwd,
    cwdExists: true,
    cwdMatchesStore: true,
    projectRoot: { path: cwd, kind: "git", mainRepositoryPath: null },
    title: "Fix the build",
    firstPrompt: "Fix the build",
    createdAt: NOW - 3_600_000,
    lastMessageAt: NOW - 60_000,
    client: "cli",
    sizeBytes: 1024,
    forkedFromProviderThreadId: null,
    ...overrides,
  };
}

function scanOutput(
  chats: NativeChatSummary[],
  resolvePaths: readonly string[] = [],
  realPaths: Readonly<Record<string, string>> = {},
): ScanOutput {
  return {
    roots: { codex: `${HOME}/.codex`, claude: `${HOME}/.claude` },
    homeDir: HOME,
    chats,
    dropped: [],
    resolvedPaths: resolvePaths.map((path) => ({
      path,
      realPath: realPaths[path] ?? path,
    })),
  };
}

const EXISTING_APP: TargetProject = {
  kind: "existing",
  projectId: "p-app",
  name: "app",
};

const turns: ReadChatOutput["turns"] = [
  {
    startedAt: NOW - 3_600_000,
    completedAt: NOW - 3_590_000,
    status: "completed",
    userText: "Fix the build",
    items: [{ type: "agentMessage", id: "a-1", text: "Done." }],
  },
];

interface ProjectStub {
  id: string;
  name: string;
  sources: Array<{ type: "local_path"; hostId: string; path: string }>;
}

type ClaimStub = {
  sourceProviderThreadId: string;
  threadId: string;
  via: "import" | "identity";
};

function setup(options: {
  chats: NativeChatSummary[];
  projects?: ProjectStub[];
  claims?: Partial<Record<"codex" | "claude-code", ClaimStub[]>>;
  hostRpc?: (call: ExperimentalFakeHostRpcCall) => unknown;
  skippedLines?: number;
  realPaths?: Record<string, string>;
}) {
  const projects = [...(options.projects ?? [])];

  const chatsByPath = new Map(
    options.chats.map((chat) => [chat.sourcePath, chat]),
  );

  const host = createFakePluginHost({
    pluginId: "omnyo--chat-importer",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host-1", name: "Mac" }),
          makeHostResponse({
            id: "host-2",
            name: "Studio",
            status: "disconnected",
          }),
        ],
      },
      projects: {
        list: async () => projects.map((project) => ({ ...project })),
        create: async (args) => {
          const created: ProjectStub = {
            id: `p-new-${projects.length + 1}`,
            name: args.name,
            sources: [
              {
                type: "local_path",
                hostId: args.source.hostId,
                path: args.source.path,
              },
            ],
          };

          projects.push(created);

          return created;
        },
      },
    },
    experimental_callHostRpc: (call) => {
      if (options.hostRpc !== undefined) return options.hostRpc(call);

      if (call.method === "scan") {
        return scanOutput(
          options.chats,
          (call.input as ScanInput).resolvePaths,
          options.realPaths,
        );
      }

      const input = call.input as { sourcePath: string };
      const chat = chatsByPath.get(input.sourcePath);

      if (chat === undefined) throw new Error("no such chat file");

      return {
        summary: chat,
        turns,
        totalTurns: 1,
        omittedTurns: 0,
        skippedLines: options.skippedLines ?? 0,
      } satisfies ReadChatOutput;
    },
  });

  let threadCount = 0;
  host.harness.inspection.sdk.stub(
    "threads.experimental_nativeSessionClaims",
    (args: { providerId: "codex" | "claude-code" }) => ({
      claimed: options.claims?.[args.providerId] ?? [],
    }),
  );
  host.harness.inspection.sdk.stub("threads.experimental_importNative", () => ({
    kind: "imported",
    threadId: `thr-${++threadCount}`,
  }));

  return { host, projects };
}

let dispose: (() => Promise<void>) | null = null;

afterEach(async () => {
  await dispose?.();
  dispose = null;
});

async function start(options: Parameters<typeof setup>[0]) {
  const context = setup(options);
  await plugin(context.host.api);
  dispose = () => context.host.harness.dispose();

  return context;
}

type Host = Awaited<ReturnType<typeof start>>["host"];

async function previewOf(host: Host): Promise<PreviewOutput> {
  return (await host.harness.callRpc("preview", {})) as PreviewOutput;
}

function importInput(chat: NativeChatSummary, project: TargetProject) {
  return {
    hostId: "host-1",
    providerId: chat.providerId,
    sourceProviderThreadId: chat.sourceProviderThreadId,
    sourcePath: chat.sourcePath,
    project,
  };
}

async function importSelection(
  host: Host,
  chats: readonly NativeChatSummary[],
): Promise<unknown[]> {
  const preview = await previewOf(host);

  const keys = new Set(
    chats.map((chat) => chatKey(chat.providerId, chat.sourceProviderThreadId)),
  );

  const plan = selectionPlan(preview, (chat) => keys.has(chat.key));

  const results = [];

  for (const chat of chats) {
    const project = plan.targets.get(
      chatKey(chat.providerId, chat.sourceProviderThreadId),
    );

    if (project === undefined) throw new Error("chat is not ready");
    results.push(
      await host.harness.callRpc("importChat", importInput(chat, project)),
    );
  }

  return results;
}

describe("chat importer server", () => {
  it("previews the primary host's chats with Omnyo's claims applied", async () => {
    const { host } = await start({
      chats: [
        summary({ sourceProviderThreadId: "ready" }),
        summary({ sourceProviderThreadId: "omnyo" }),
        summary({
          providerId: "codex",
          sourceProviderThreadId: "imported",
          sourcePath: `${HOME}/.codex/sessions/a.jsonl`,
        }),
      ],
      claims: {
        "claude-code": [
          {
            sourceProviderThreadId: "omnyo",
            threadId: "thr-o",
            via: "identity",
          },
        ],
        codex: [
          {
            sourceProviderThreadId: "imported",
            threadId: "thr-i",
            via: "import",
          },
        ],
      },
      projects: [
        {
          id: "p-app",
          name: "app",
          sources: [
            { type: "local_path", hostId: "host-1", path: `${HOME}/code/app` },
          ],
        },
      ],
    });

    const preview = (await host.harness.callRpc("preview", {})) as {
      hostId: string;
      days: number;
      hosts: unknown[];
      counts: { found: number; ready: number; alreadyImported: number };
      chats: Array<{ key: string; status: string; threadId: string | null }>;
    };

    expect(preview.hostId).toBe("host-1");
    expect(preview.days).toBe(2);
    expect(preview.hosts).toEqual([
      { id: "host-1", name: "Mac", connected: true },
      { id: "host-2", name: "Studio", connected: false },
    ]);
    expect(
      preview.chats.map((chat) => [chat.key, chat.status, chat.threadId]),
    ).toEqual(
      expect.arrayContaining([
        ["claude-code:ready", "ready", null],
        ["claude-code:omnyo", "omnyo-chat", "thr-o"],
        ["codex:imported", "already-imported", "thr-i"],
      ]),
    );
    expect(preview.counts).toMatchObject({
      found: 3,
      ready: 1,
      alreadyImported: 1,
    });
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "scan", hostId: "host-1", input: { days: 2 } },
    ]);
    expect(
      host.harness.inspection.sdk.callsTo(
        "threads.experimental_nativeSessionClaims",
      ),
    ).toEqual([
      [{ hostId: "host-1", providerId: "codex" }],
      [{ hostId: "host-1", providerId: "claude-code" }],
    ]);
  });

  it("lists the machines and the primary one separately from a preview", async () => {
    const { host } = await start({ chats: [] });

    await expect(host.harness.callRpc("hosts", {})).resolves.toEqual({
      primaryHostId: "host-1",
      hosts: [
        { id: "host-1", name: "Mac", connected: true },
        { id: "host-2", name: "Studio", connected: false },
      ],
    });
  });

  it("matches a chat in a symlinked folder to the project at the real folder", async () => {
    const chat = summary({
      cwd: `${HOME}/code/link`,
      realCwd: `${HOME}/code/real`,
      projectRoot: {
        path: `${HOME}/code/real`,
        kind: "git",
        mainRepositoryPath: null,
      },
    });

    const { host } = await start({
      chats: [chat],
      projects: [
        {
          id: "p-real",
          name: "real",
          sources: [
            { type: "local_path", hostId: "host-1", path: `${HOME}/code/real` },
          ],
        },
      ],
    });

    const preview = (await host.harness.callRpc("preview", {})) as {
      chats: Array<{ project: unknown }>;
      newProjects: unknown[];
    };

    expect(preview.chats.map((entry) => entry.project)).toEqual([
      { kind: "existing", projectId: "p-real", name: "real" },
    ]);
    expect(preview.newProjects).toEqual([]);

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "existing",
          projectId: "p-real",
          name: "real",
        }),
      ),
    ).resolves.toMatchObject({
      status: "imported",
      projectId: "p-real",
      createdProject: false,
    });
    expect(host.harness.inspection.sdk.callsTo("projects.create")).toEqual([]);
    expect(
      host.harness.inspection.sdk.callsTo("threads.experimental_importNative"),
    ).toMatchObject([[{ cwd: `${HOME}/code/link` }]]);
  });

  it("treats a copy of an Omnyo chat as that Omnyo chat in the preview and the import", async () => {
    const copy = summary({
      sourceProviderThreadId: "rewind-copy",
      sourcePath: `${HOME}/.claude/projects/x/rewind-copy.jsonl`,
      forkedFromProviderThreadId: "omnyo-session",
    });

    const { host, projects } = await start({
      chats: [copy],
      claims: {
        "claude-code": [
          {
            sourceProviderThreadId: "omnyo-session",
            threadId: "thr-omnyo",
            via: "identity",
          },
        ],
      },
    });

    const preview = await previewOf(host);

    expect(preview.chats).toMatchObject([
      {
        key: "claude-code:rewind-copy",
        status: "omnyo-chat",
        threadId: "thr-omnyo",
        reason: "This chat is a copy of a chat in Omnyo.",
        project: null,
      },
    ]);
    expect(preview.counts.ready).toBe(0);

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(copy, {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "already-imported",
      threadId: "thr-omnyo",
      message: "This chat is a copy of a chat in Omnyo.",
    });
    expect(
      host.harness.inspection.sdk.callsTo("threads.experimental_importNative"),
    ).toEqual([]);
    expect(projects).toEqual([]);
  });

  it("files a chat in the real folder under a project added through a symlink", async () => {
    const chat = summary({
      cwd: `${HOME}/projects/omnyo/apps/web`,
      projectRoot: {
        path: `${HOME}/projects/omnyo`,
        kind: "git",
        mainRepositoryPath: null,
      },
    });

    const { host, projects } = await start({
      chats: [chat],
      projects: [
        {
          id: "p-omnyo",
          name: "omnyo",
          sources: [
            {
              type: "local_path",
              hostId: "host-1",
              path: `${HOME}/projects/omnyo-link`,
            },
          ],
        },
      ],
      realPaths: { [`${HOME}/projects/omnyo-link`]: `${HOME}/projects/omnyo` },
    });

    const preview = await previewOf(host);

    expect(preview.chats.map((entry) => entry.project)).toEqual([
      { kind: "existing", projectId: "p-omnyo", name: "omnyo" },
    ]);
    expect(preview.newProjects).toEqual([]);
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "scan",
        input: { resolvePaths: [`${HOME}/projects/omnyo-link`] },
      },
    ]);

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "new",
          name: "omnyo 2",
          path: `${HOME}/projects/omnyo`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "imported",
      projectId: "p-omnyo",
      createdProject: false,
    });
    expect(host.harness.inspection.sdk.callsTo("projects.create")).toEqual([]);
    expect(projects.map((project) => project.id)).toEqual(["p-omnyo"]);
  });

  it("resolves symlinked project folders for an import without an earlier preview", async () => {
    const chat = summary({ cwd: `${HOME}/projects/omnyo` });

    const { host } = await start({
      chats: [chat],
      projects: [
        {
          id: "p-omnyo",
          name: "omnyo",
          sources: [
            {
              type: "local_path",
              hostId: "host-1",
              path: `${HOME}/projects/omnyo-link`,
            },
          ],
        },
      ],
      realPaths: { [`${HOME}/projects/omnyo-link`]: `${HOME}/projects/omnyo` },
    });

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "existing",
          projectId: "p-omnyo",
          name: "omnyo",
        }),
      ),
    ).resolves.toMatchObject({ status: "imported", projectId: "p-omnyo" });
    expect(
      host.harness.experimental_hostRpcCalls.find(
        (call) => call.method === "scan",
      ),
    ).toMatchObject({
      input: { days: 1, resolvePaths: [`${HOME}/projects/omnyo-link`] },
    });
  });

  describe("files each chat under the project the preview showed for the same selection", () => {
    const parent = summary({
      sourceProviderThreadId: "a",
      sourcePath: `${HOME}/.claude/projects/x/a.jsonl`,
      cwd: `${HOME}/x/proj`,
      projectRoot: {
        path: `${HOME}/x/proj`,
        kind: "folder",
        mainRepositoryPath: null,
      },
      lastMessageAt: NOW - 60_000,
    });

    const nested = summary({
      sourceProviderThreadId: "b",
      sourcePath: `${HOME}/.claude/projects/x/b.jsonl`,
      cwd: `${HOME}/x/proj/sub`,
      projectRoot: {
        path: `${HOME}/x/proj/sub`,
        kind: "folder",
        mainRepositoryPath: null,
      },
      lastMessageAt: NOW - 120_000,
    });

    const firstApp = summary({
      sourceProviderThreadId: "c",
      sourcePath: `${HOME}/.claude/projects/x/c.jsonl`,
      cwd: `${HOME}/a/app`,
      lastMessageAt: NOW - 180_000,
    });

    const secondApp = summary({
      sourceProviderThreadId: "d",
      sourcePath: `${HOME}/.claude/projects/x/d.jsonl`,
      cwd: `${HOME}/b/app`,
      lastMessageAt: NOW - 240_000,
    });

    const chats = [parent, nested, firstApp, secondApp];

    it("files the nested chat in the parent's new project only when both are selected", async () => {
      const { host, projects } = await start({ chats });

      const preview = await previewOf(host);

      expect(preview.chats.map((entry) => [entry.key, entry.project])).toEqual([
        [
          "claude-code:a",
          { kind: "new", name: "proj", path: `${HOME}/x/proj` },
        ],
        [
          "claude-code:b",
          { kind: "new", name: "proj", path: `${HOME}/x/proj` },
        ],
        ["claude-code:c", { kind: "new", name: "app", path: `${HOME}/a/app` }],
        [
          "claude-code:d",
          { kind: "new", name: "app 2", path: `${HOME}/b/app` },
        ],
      ]);

      await expect(importSelection(host, [nested])).resolves.toMatchObject([
        { status: "imported", projectId: "p-new-1", createdProject: true },
      ]);
      expect(projects).toMatchObject([
        { name: "sub", sources: [{ path: `${HOME}/x/proj/sub` }] },
      ]);
    });

    it("keeps the parent and nested chats together when both are selected", async () => {
      const { host, projects } = await start({ chats });

      await expect(
        importSelection(host, [parent, nested]),
      ).resolves.toMatchObject([
        { status: "imported", projectId: "p-new-1", createdProject: true },
        { status: "imported", projectId: "p-new-1", createdProject: false },
      ]);
      expect(projects.map((project) => project.name)).toEqual(["proj"]);
    });

    it("names a new project as the preview did", async () => {
      const alone = await start({ chats });

      await importSelection(alone.host, [secondApp]);

      expect(alone.projects.map((project) => project.name)).toEqual(["app"]);

      await dispose?.();

      const both = await start({ chats });

      await importSelection(both.host, [firstApp, secondApp]);

      expect(
        both.projects.map((project) => [
          project.name,
          project.sources[0]?.path,
        ]),
      ).toEqual([
        ["app", `${HOME}/a/app`],
        ["app 2", `${HOME}/b/app`],
      ]);
    });

    it("plans the CLI run over the chats named with --chat", async () => {
      const { host, projects } = await start({ chats });

      const result = await host.harness.runCli([
        "run",
        "--chat",
        "claude-code:b",
        "--chat",
        "claude-code:d",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(
        projects.map((project) => [project.name, project.sources[0]?.path]),
      ).toEqual([
        ["sub", `${HOME}/x/proj/sub`],
        ["app", `${HOME}/b/app`],
      ]);
    });

    it("refuses a plan made before an earlier batch created projects", async () => {
      const sibling = summary({
        sourceProviderThreadId: "e",
        sourcePath: `${HOME}/.claude/projects/x/e.jsonl`,
        cwd: `${HOME}/x/proj/sub`,
        projectRoot: {
          path: `${HOME}/x/proj/sub`,
          kind: "folder",
          mainRepositoryPath: null,
        },
        lastMessageAt: NOW - 150_000,
      });

      const { host, projects } = await start({ chats: [...chats, sibling] });

      const stale = await previewOf(host);

      const keyOf = (chat: NativeChatSummary) =>
        chatKey(chat.providerId, chat.sourceProviderThreadId);

      const staleTarget = (
        selected: readonly NativeChatSummary[],
        chat: NativeChatSummary,
      ) => {
        const keys = new Set(selected.map(keyOf));

        const target = selectionPlan(stale, (entry) =>
          keys.has(entry.key),
        ).targets.get(keyOf(chat));

        if (target === undefined) throw new Error("chat is not ready");

        return target;
      };

      await host.harness.callRpc(
        "importChat",
        importInput(nested, staleTarget([nested], nested)),
      );
      await host.harness.callRpc(
        "importChat",
        importInput(secondApp, staleTarget([secondApp], secondApp)),
      );

      expect(staleTarget([parent, nested, sibling], sibling)).toEqual({
        kind: "new",
        name: "proj",
        path: `${HOME}/x/proj`,
      });
      expect(staleTarget([firstApp, secondApp], firstApp)).toEqual({
        kind: "new",
        name: "app",
        path: `${HOME}/a/app`,
      });

      for (const chat of [sibling, firstApp]) {
        await expect(
          host.harness.callRpc(
            "importChat",
            importInput(
              chat,
              staleTarget([parent, nested, sibling, firstApp, secondApp], chat),
            ),
          ),
        ).resolves.toMatchObject({
          status: "failed",
          createdProject: false,
          message:
            "Your projects changed since the chats were listed. List them again and retry.",
        });
      }

      expect(
        projects.map((project) => [project.name, project.sources[0]?.path]),
      ).toEqual([
        ["sub", `${HOME}/x/proj/sub`],
        ["app", `${HOME}/b/app`],
      ]);

      const fresh = await importSelection(host, [parent, sibling, firstApp]);

      expect(fresh).toMatchObject([
        { status: "imported", projectId: "p-new-3", createdProject: true },
        { status: "imported", projectId: "p-new-1", createdProject: false },
        { status: "imported", projectId: "p-new-4", createdProject: true },
      ]);
      expect(
        projects.map((project) => [project.name, project.sources[0]?.path]),
      ).toEqual([
        ["sub", `${HOME}/x/proj/sub`],
        ["app", `${HOME}/b/app`],
        ["proj", `${HOME}/x/proj`],
        ["app 2", `${HOME}/a/app`],
      ]);
    });

    it("plans each CLI run against the projects earlier runs created", async () => {
      const sibling = summary({
        sourceProviderThreadId: "e",
        sourcePath: `${HOME}/.claude/projects/x/e.jsonl`,
        cwd: `${HOME}/x/proj/sub`,
        projectRoot: {
          path: `${HOME}/x/proj/sub`,
          kind: "folder",
          mainRepositoryPath: null,
        },
        lastMessageAt: NOW - 150_000,
      });

      const { host, projects } = await start({ chats: [...chats, sibling] });

      const run = async (...keys: string[]) => {
        const result = await host.harness.runCli([
          "run",
          ...keys.flatMap((key) => ["--chat", key]),
          "--json",
        ]);

        expect(result.exitCode).toBe(0);

        return (
          JSON.parse(result.stdout) as {
            results: Array<{ key: string; status: string; projectId: string }>;
          }
        ).results.map((entry) => [entry.key, entry.status, entry.projectId]);
      };

      expect(await run("claude-code:b", "claude-code:d")).toEqual([
        ["claude-code:b", "imported", "p-new-1"],
        ["claude-code:d", "imported", "p-new-2"],
      ]);
      expect(
        await run("claude-code:a", "claude-code:e", "claude-code:c"),
      ).toEqual([
        ["claude-code:a", "imported", "p-new-3"],
        ["claude-code:e", "imported", "p-new-1"],
        ["claude-code:c", "imported", "p-new-4"],
      ]);
      expect(
        projects.map((project) => [project.name, project.sources[0]?.path]),
      ).toEqual([
        ["sub", `${HOME}/x/proj/sub`],
        ["app", `${HOME}/b/app`],
        ["proj", `${HOME}/x/proj`],
        ["app 2", `${HOME}/a/app`],
      ]);
    });

    it("refuses a project the chat does not belong in without creating anything", async () => {
      const { host, projects } = await start({ chats });

      await expect(
        host.harness.callRpc(
          "importChat",
          importInput(nested, {
            kind: "new",
            name: "app",
            path: `${HOME}/a/app`,
          }),
        ),
      ).resolves.toMatchObject({
        status: "failed",
        message:
          "Your projects changed since the chats were listed. List them again and retry.",
      });
      expect(projects).toEqual([]);
      expect(
        host.harness.inspection.sdk.callsTo(
          "threads.experimental_importNative",
        ),
      ).toEqual([]);
    });
  });

  it("keeps a child repository in its own project when its parent folder becomes a project first", async () => {
    const parent = summary({
      sourceProviderThreadId: "parent",
      sourcePath: `${HOME}/.claude/projects/x/parent.jsonl`,
      cwd: `${HOME}/projects`,
      projectRoot: {
        path: `${HOME}/projects`,
        kind: "folder",
        mainRepositoryPath: null,
      },
      lastMessageAt: NOW - 60_000,
    });

    const child = summary({
      sourceProviderThreadId: "child",
      sourcePath: `${HOME}/.claude/projects/x/child.jsonl`,
      cwd: `${HOME}/projects/foo`,
      lastMessageAt: NOW - 120_000,
    });

    const { host, projects } = await start({ chats: [parent, child] });

    const preview = (await host.harness.callRpc("preview", {})) as {
      chats: Array<{ key: string; project: unknown }>;
      newProjects: unknown[];
    };

    expect(preview.chats.map((entry) => [entry.key, entry.project])).toEqual([
      [
        "claude-code:parent",
        { kind: "new", name: "projects", path: `${HOME}/projects` },
      ],
      [
        "claude-code:child",
        { kind: "new", name: "foo", path: `${HOME}/projects/foo` },
      ],
    ]);
    expect(preview.newProjects).toEqual([
      { name: "projects", path: `${HOME}/projects` },
      { name: "foo", path: `${HOME}/projects/foo` },
    ]);

    const results = await importSelection(host, [parent, child]);

    expect(results).toMatchObject([
      { status: "imported", projectId: "p-new-1", createdProject: true },
      { status: "imported", projectId: "p-new-2", createdProject: true },
    ]);
    expect(projects.map((project) => project.name)).toEqual([
      "projects",
      "foo",
    ]);
  });

  it("reports the project it created when the import fails afterwards", async () => {
    const chat = summary();
    const { host, projects } = await start({ chats: [chat] });
    host.harness.inspection.sdk.stub(
      "threads.experimental_importNative",
      () => {
        throw new Error("request timed out");
      },
    );

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toEqual({
      status: "failed",
      threadId: null,
      projectId: "p-new-1",
      createdProject: true,
      message: expect.stringContaining("request timed out"),
      omittedTurns: 0,
      skippedLines: 0,
    });
    expect(projects.map((project) => project.id)).toEqual(["p-new-1"]);
  });

  it("reports transcript lines the host skipped on an imported chat", async () => {
    const chat = summary();
    const { host } = await start({ chats: [chat], skippedLines: 3 });

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "imported",
      skippedLines: 3,
      message:
        "3 lines in the chat file couldn't be read and are left out of the history shown here.",
    });
  });

  it("refuses an offline machine with a plain message", async () => {
    const { host } = await start({ chats: [] });

    await expect(
      host.harness.callRpc("preview", { days: 2, hostId: "host-2" }),
    ).rejects.toThrow("Studio is offline");
  });

  it("imports one chat with its fresh summary and history into the matched project", async () => {
    const chat = summary();

    const { host } = await start({
      chats: [chat],
      projects: [
        {
          id: "p-app",
          name: "app",
          sources: [
            { type: "local_path", hostId: "host-1", path: `${HOME}/code/app` },
          ],
        },
      ],
    });

    await host.harness.callRpc("preview", {});

    await expect(
      host.harness.callRpc("importChat", importInput(chat, EXISTING_APP)),
    ).resolves.toEqual({
      status: "imported",
      threadId: "thr-1",
      projectId: "p-app",
      createdProject: false,
      message: null,
      omittedTurns: 0,
      skippedLines: 0,
    });
    expect(
      host.harness.inspection.sdk.callsTo("threads.experimental_importNative"),
    ).toEqual([
      [
        {
          projectId: "p-app",
          hostId: "host-1",
          providerId: "claude-code",
          sourceProviderThreadId: "s-1",
          sourcePath: chat.sourcePath,
          cwd: chat.cwd,
          title: chat.title,
          createdAt: chat.createdAt,
          lastMessageAt: chat.lastMessageAt,
          turns,
        },
      ],
    ]);
    expect(host.harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "readChat",
      hostId: "host-1",
      input: {
        providerId: "claude-code",
        sourcePath: chat.sourcePath,
        sourceProviderThreadId: "s-1",
      },
    });
  });

  it("creates a new project once and reuses it for later chats in the batch", async () => {
    const first = summary({
      sourceProviderThreadId: "a",
      sourcePath: `${HOME}/.claude/projects/x/a.jsonl`,
      cwd: `${HOME}/code/tool/src`,
      projectRoot: {
        path: `${HOME}/code/tool`,
        kind: "git",
        mainRepositoryPath: null,
      },
    });

    const second = summary({
      sourceProviderThreadId: "b",
      sourcePath: `${HOME}/.claude/projects/x/b.jsonl`,
      cwd: `${HOME}/code/tool`,
    });

    const { host, projects } = await start({ chats: [first, second] });

    const results = await importSelection(host, [first, second]);

    expect(results).toMatchObject([
      { status: "imported", projectId: "p-new-1", createdProject: true },
      { status: "imported", projectId: "p-new-1", createdProject: false },
    ]);
    expect(projects).toEqual([
      {
        id: "p-new-1",
        name: "tool",
        sources: [
          { type: "local_path", hostId: "host-1", path: `${HOME}/code/tool` },
        ],
      },
    ]);
    expect(host.harness.inspection.sdk.callsTo("projects.create")).toHaveLength(
      1,
    );
  });

  it("files a worktree chat and a chat in its main repository's real folder under one project, as the preview showed", async () => {
    const worktree = summary({
      sourceProviderThreadId: "wt",
      sourcePath: `${HOME}/.claude/projects/x/wt.jsonl`,
      cwd: `${HOME}/wt/tool-feature`,
      projectRoot: {
        path: `${HOME}/wt/tool-feature`,
        kind: "git-worktree",
        mainRepositoryPath: `${HOME}/links/tool`,
      },
      lastMessageAt: NOW - 60_000,
    });

    const main = summary({
      sourceProviderThreadId: "main",
      sourcePath: `${HOME}/.claude/projects/x/main.jsonl`,
      cwd: `${HOME}/code/tool`,
      lastMessageAt: NOW - 120_000,
    });

    const { host, projects } = await start({
      chats: [worktree, main],
      realPaths: { [`${HOME}/links/tool`]: `${HOME}/code/tool` },
    });

    const tool = { kind: "new", name: "tool", path: `${HOME}/code/tool` };
    const preview = await previewOf(host);

    expect(preview.chats.map((chat) => chat.project)).toEqual([tool, tool]);
    expect(preview.newProjects).toEqual([
      { name: "tool", path: `${HOME}/code/tool` },
    ]);
    expect([...selectionPlan(preview, () => true).targets.values()]).toEqual([
      tool,
      tool,
    ]);

    const results = await importSelection(host, [worktree, main]);

    expect(results).toMatchObject([
      { status: "imported", projectId: "p-new-1", createdProject: true },
      { status: "imported", projectId: "p-new-1", createdProject: false },
    ]);
    expect(
      projects.map((project) => [project.name, project.sources[0]?.path]),
    ).toEqual([["tool", `${HOME}/code/tool`]]);
  });

  it("imports named chats where the preview filed them whatever order they are named in", async () => {
    const parent = summary({
      sourceProviderThreadId: "a",
      sourcePath: `${HOME}/.claude/projects/x/a.jsonl`,
      cwd: `${HOME}/x/proj`,
      projectRoot: {
        path: `${HOME}/x/proj`,
        kind: "folder",
        mainRepositoryPath: null,
      },
      lastMessageAt: NOW - 120_000,
    });

    const nested = summary({
      sourceProviderThreadId: "b",
      sourcePath: `${HOME}/.claude/projects/x/b.jsonl`,
      cwd: `${HOME}/x/proj/sub`,
      projectRoot: {
        path: `${HOME}/x/proj/sub`,
        kind: "folder",
        mainRepositoryPath: null,
      },
      lastMessageAt: NOW - 60_000,
    });

    const { host, projects } = await start({ chats: [nested, parent] });

    const results = await runImport(
      {
        hosts: () => host.harness.callRpc("hosts", {}),
        preview: (input) => host.harness.callRpc("preview", input),
        importChat: (input) => host.harness.callRpc("importChat", input),
      } as ChatImporter,
      {
        days: 2,
        hostId: undefined,
        chats: ["claude-code:a", "claude-code:b"],
      },
    );

    expect(
      results.map((result) => [result.key, result.status, result.projectId]),
    ).toEqual([
      ["claude-code:b", "imported", "p-new-1"],
      ["claude-code:a", "imported", "p-new-2"],
    ]);
    expect(
      projects.map((project) => [project.name, project.sources[0]?.path]),
    ).toEqual([
      ["sub", `${HOME}/x/proj/sub`],
      ["proj", `${HOME}/x/proj`],
    ]);
  });

  it("reports a chat claimed in the meantime as already imported", async () => {
    const chat = summary();
    const { host } = await start({ chats: [chat] });
    host.harness.inspection.sdk.stub(
      "threads.experimental_importNative",
      () => ({
        kind: "already-claimed",
        threadId: "thr-earlier",
        via: "import",
      }),
    );

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "already-imported",
      threadId: "thr-earlier",
    });
  });

  it("returns failed with a plain message when the host cannot read the chat", async () => {
    const { host } = await start({
      chats: [],
      hostRpc: (call) => {
        if (call.method === "scan") return scanOutput([]);
        throw new Error("the chat file changed while it was read");
      },
    });

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(summary(), {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toEqual({
      status: "failed",
      threadId: null,
      projectId: null,
      createdProject: false,
      message: expect.stringContaining(
        "the chat file changed while it was read",
      ),
      omittedTurns: 0,
      skippedLines: 0,
    });
    expect(
      host.harness.inspection.sdk.callsTo("threads.experimental_importNative"),
    ).toEqual([]);
  });

  it("refuses a chat whose folder is not a project folder without creating anything", async () => {
    const chat = summary({ cwd: HOME, projectRoot: null });
    const { host } = await start({ chats: [chat] });

    await expect(
      host.harness.callRpc(
        "importChat",
        importInput(chat, {
          kind: "new",
          name: "app",
          path: `${HOME}/code/app`,
        }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      message: "Not in a project folder.",
    });
    expect(host.harness.inspection.sdk.callsTo("projects.create")).toEqual([]);
  });

  it("imports every ready chat from the CLI and prints JSON results", async () => {
    const ready = summary({
      sourceProviderThreadId: "a",
      sourcePath: `${HOME}/.claude/projects/x/a.jsonl`,
    });

    const home = summary({
      sourceProviderThreadId: "b",
      sourcePath: `${HOME}/.claude/projects/x/b.jsonl`,
      cwd: HOME,
      projectRoot: null,
    });

    const { host } = await start({
      chats: [ready, home],
      projects: [
        {
          id: "p-app",
          name: "app",
          sources: [
            { type: "local_path", hostId: "host-1", path: `${HOME}/code/app` },
          ],
        },
      ],
    });

    const result = await host.harness.runCli(["run", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      results: [
        {
          key: "claude-code:a",
          title: ready.title,
          status: "imported",
          threadId: "thr-1",
          projectId: "p-app",
          createdProject: false,
          message: null,
          omittedTurns: 0,
          skippedLines: 0,
        },
      ],
      counts: { imported: 1, alreadyImported: 0, failed: 0 },
    });

    const scan = await host.harness.runCli(["scan", "--days", "7"]);

    expect(scan.exitCode).toBe(0);
    expect(scan.stdout).toContain(
      "2 chats with messages in the last 7 days on Mac",
    );
    expect(scan.stdout).toContain("claude-code:b");
  });
});
