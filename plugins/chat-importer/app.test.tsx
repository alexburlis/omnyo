// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type {
  ImportChatOutput,
  PreviewChat,
  PreviewOutput,
} from "./src/contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const NOW = Date.UTC(2026, 10, 12, 12);

function chat(overrides: Partial<PreviewChat> & { key: string }): PreviewChat {
  const [providerId, id] = overrides.key.split(":") as [
    PreviewChat["providerId"],
    string,
  ];

  const cwd = overrides.cwd ?? "/home/ada/code/app";

  return {
    providerId,
    sourceProviderThreadId: id,
    sourcePath: `/home/ada/.claude/projects/x/${id}.jsonl`,
    title: `Chat ${id}`,
    firstPrompt: "Hello",
    cwd,
    realCwd: cwd,
    projectRoot: { path: cwd, kind: "git", mainRepositoryPath: null },
    client: "cli",
    createdAt: NOW - 7_200_000,
    lastMessageAt: NOW - 3_600_000,
    sizeBytes: 100,
    status: "ready",
    reason: null,
    threadId: null,
    project: { kind: "existing", projectId: "p-app", name: "app" },
    ...overrides,
  };
}

function preview(days: number, chats: PreviewChat[]): PreviewOutput {
  const ready = chats.filter((entry) => entry.status === "ready");

  const byProvider = (providerId: PreviewChat["providerId"]) => ({
    found: chats.filter((entry) => entry.providerId === providerId).length,
    ready: ready.filter((entry) => entry.providerId === providerId).length,
  });

  const alreadyImported = chats.filter(
    (entry) => entry.status === "already-imported",
  ).length;

  return {
    hostId: "host-1",
    hosts: [{ id: "host-1", name: "Mac", connected: true }],
    days,
    nowMs: NOW,
    cutoffMs: NOW - days * 86_400_000,
    homeDir: "/home/ada",
    roots: { codex: "/home/ada/.codex", claude: "/home/ada/.claude" },
    projects: [{ id: "p-app", name: "app", paths: ["/home/ada/code/app"] }],
    counts: {
      found: chats.length,
      ready: ready.length,
      alreadyImported,
      unavailable: chats.length - ready.length - alreadyImported,
      byProvider: {
        codex: byProvider("codex"),
        "claude-code": byProvider("claude-code"),
      },
    },
    chats,
    dropped: [],
    newProjects: [{ name: "tool", path: "/home/ada/code/tool" }],
  };
}

const baseChats = [
  chat({ key: "claude-code:a" }),
  chat({
    key: "claude-code:b",
    cwd: "/home/ada/code/tool",
    project: { kind: "new", name: "tool", path: "/home/ada/code/tool" },
  }),
  chat({ key: "codex:c" }),
  chat({
    key: "claude-code:home",
    status: "not-a-project-folder",
    reason: "Not in a project folder.",
    project: null,
  }),
  chat({
    key: "claude-code:old",
    status: "already-imported",
    reason: "Already imported.",
    threadId: "thr-old",
    project: null,
  }),
];

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

function imported(threadId: string): ImportChatOutput {
  return {
    status: "imported",
    threadId,
    projectId: "p-app",
    createdProject: false,
    message: null,
    omittedTurns: 0,
    skippedLines: 0,
  };
}

const hostChoices = {
  primaryHostId: "host-1",
  hosts: [
    { id: "host-1", name: "Mac", connected: false },
    { id: "host-2", name: "Studio", connected: true },
  ],
};

function render(
  importChat?: (input: unknown) => unknown,
  chats: PreviewChat[] = baseChats,
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        hosts: () => hostChoices,
        preview: (input) => {
          const days = (input as { days: number }).days;

          return preview(
            days,
            days > 2 ? [...chats, chat({ key: "codex:d" })] : chats,
          );
        },
        importChat: importChat ?? (() => imported("thr-x")),
      },
    },
  );
}

describe("Chat import settings", () => {
  it("registers one Import chats settings section", () => {
    expect(
      app.settingsSections.map((section) => [section.id, section.title]),
    ).toEqual([["import", "Import chats"]]);
  });

  it("shows the count line, rows and a button for every ready chat", async () => {
    const slot = render();

    expect(
      await slot.findByText(
        "5 chats found · Claude Code 4 · Codex 1 · 1 already imported",
      ),
    ).toBeTruthy();
    expect(
      slot.getByText("New project · tool · Claude Code · 1 h ago"),
    ).toBeTruthy();
    expect(
      slot.getByText("Not in a project folder. · Claude Code · 1 h ago"),
    ).toBeTruthy();
    expect(
      slot
        .getByRole("checkbox", { name: "Chat home" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(slot.getByText("New projects: tool")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Import 3 chats" })).toBeTruthy();
  });

  it("rescans after the days field settles", async () => {
    const slot = render();
    await slot.findByRole("button", { name: "Import 3 chats" });

    fireEvent.change(slot.getByRole("spinbutton", { name: "Days" }), {
      target: { value: "7" },
    });

    await waitFor(
      () =>
        expect(
          slot.getByRole("button", { name: "Import 4 chats" }),
        ).toBeTruthy(),
      {
        timeout: 2_000,
      },
    );
    expect(
      slot.inspection.rpcCalls
        .filter((call) => call.method === "preview")
        .map((call) => call.input),
    ).toEqual([{ days: 2 }, { days: 7 }]);
  });

  it("lowers the import count and drops its new project when a chat is unticked", async () => {
    const slot = render();
    await slot.findByRole("button", { name: "Import 3 chats" });

    fireEvent.click(slot.getByRole("checkbox", { name: "Chat b" }));

    expect(slot.getByRole("button", { name: "Import 2 chats" })).toBeTruthy();
    expect(slot.queryByText(/^New projects:/u)).toBeNull();
  });

  it("keeps the machine picker when the primary machine is offline", async () => {
    Element.prototype.scrollIntoView = () => {};

    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });

    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          hosts: () => hostChoices,
          preview: (input) => {
            const { days, hostId } = input as { days: number; hostId?: string };

            if (hostId !== "host-2") {
              throw new Error(
                "Mac is offline. Connect it to look for its chats.",
              );
            }

            return { ...preview(days, baseChats), hostId: "host-2" };
          },
          importChat: () => imported("thr-x"),
        },
      },
    );

    expect(
      await slot.findByText(
        "Mac is offline. Connect it to look for its chats.",
      ),
    ).toBeTruthy();

    fireEvent.click(await slot.findByRole("combobox", { name: "Machine" }));
    fireEvent.click(await slot.findByRole("option", { name: "Studio" }));

    expect(
      await slot.findByRole("button", { name: "Import 3 chats" }),
    ).toBeTruthy();
    expect(
      slot.inspection.rpcCalls
        .filter((call) => call.method === "preview")
        .map((call) => call.input),
    ).toEqual([{ days: 2 }, { days: 2, hostId: "host-2" }]);
  });

  it("shows the history notice of an imported chat", async () => {
    const slot = render(() => ({
      ...imported("thr-a"),
      skippedLines: 2,
      message:
        "2 lines in the chat file couldn't be read and are left out of the history shown here.",
    }));

    fireEvent.click(await slot.findByRole("checkbox", { name: "Chat b" }));
    fireEvent.click(await slot.findByRole("checkbox", { name: "Chat c" }));
    fireEvent.click(slot.getByRole("button", { name: "Import 1 chat" }));

    expect(
      await slot.findByText(
        "2 lines in the chat file couldn't be read and are left out of the history shown here.",
      ),
    ).toBeTruthy();
  });

  it("keeps importing the selected chats after the panel closes", async () => {
    const pending: Array<ReturnType<typeof deferred<ImportChatOutput>>> = [];

    const slot = render(() => {
      const next = deferred<ImportChatOutput>();
      pending.push(next);

      return next.promise;
    });

    fireEvent.click(await slot.findByRole("checkbox", { name: "Chat c" }));
    fireEvent.click(slot.getByRole("button", { name: "Import 2 chats" }));
    expect(await slot.findByText("Importing 1 of 2")).toBeTruthy();

    slot.unmount();
    await act(async () => pending[0]!.resolve(imported("thr-a")));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!.resolve(imported("thr-b")));

    expect(
      slot.inspection.rpcCalls
        .filter((call) => call.method === "importChat")
        .map(
          (call) =>
            (call.input as { sourceProviderThreadId: string })
              .sourceProviderThreadId,
        ),
    ).toEqual(["a", "b"]);
  });

  it("imports one chat at a time, shows progress and opens an imported chat", async () => {
    const pending: Array<ReturnType<typeof deferred<ImportChatOutput>>> = [];

    const slot = render(() => {
      const next = deferred<ImportChatOutput>();
      pending.push(next);

      return next.promise;
    });

    fireEvent.click(await slot.findByRole("checkbox", { name: "Chat c" }));
    fireEvent.click(slot.getByRole("button", { name: "Import 2 chats" }));

    expect(await slot.findByText("Importing 1 of 2")).toBeTruthy();
    expect(pending).toHaveLength(1);

    await act(async () => pending[0]!.resolve(imported("thr-a")));
    expect(await slot.findByText("Importing 2 of 2")).toBeTruthy();
    expect(pending).toHaveLength(2);

    await act(async () =>
      pending[1]!.resolve({
        status: "failed",
        threadId: null,
        projectId: null,
        createdProject: false,
        message: "Couldn't import this chat: disk full",
        omittedTurns: 0,
        skippedLines: 0,
      }),
    );

    expect(
      await slot.findByText("Couldn't import this chat: disk full"),
    ).toBeTruthy();
    expect(
      slot.inspection.rpcCalls
        .filter((call) => call.method === "importChat")
        .map((call) => call.input),
    ).toEqual([
      {
        hostId: "host-1",
        providerId: "claude-code",
        sourceProviderThreadId: "a",
        sourcePath: "/home/ada/.claude/projects/x/a.jsonl",
        project: { kind: "existing", projectId: "p-app", name: "app" },
      },
      {
        hostId: "host-1",
        providerId: "claude-code",
        sourceProviderThreadId: "b",
        sourcePath: "/home/ada/.claude/projects/x/b.jsonl",
        project: { kind: "new", name: "tool", path: "/home/ada/code/tool" },
      },
    ]);
    expect(slot.getByRole("button", { name: "Import 1 chat" })).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toThread",
        threadId: "thr-a",
        options: { experimental_userInitiated: true },
      }),
    );
  });

  it("lists the chats again after a batch and plans the next batch against the projects it created", async () => {
    const folder = (path: string) => ({
      cwd: path,
      projectRoot: { path, kind: "folder" as const, mainRepositoryPath: null },
    });

    const parent = chat({
      key: "claude-code:parent",
      ...folder("/home/ada/x/proj"),
    });

    const nested = chat({
      key: "claude-code:nested",
      ...folder("/home/ada/x/proj/sub"),
    });

    const sibling = chat({
      key: "claude-code:sibling",
      ...folder("/home/ada/x/proj/sub"),
    });

    const listed = preview(2, [parent, nested, sibling]);
    const relisted = deferred<PreviewOutput>();
    let listings = 0;

    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          hosts: () => hostChoices,
          preview: () => (++listings === 1 ? listed : relisted.promise),
          importChat: () => ({
            ...imported("thr-nested"),
            projectId: "p-sub",
            createdProject: true,
          }),
        },
      },
    );

    await slot.findByRole("button", { name: "Import 3 chats" });
    fireEvent.click(slot.getByRole("checkbox", { name: "Chat parent" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Chat sibling" }));
    fireEvent.click(slot.getByRole("button", { name: "Import 1 chat" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls
          .filter((call) => call.method === "preview")
          .map((call) => call.input),
      ).toEqual([{ days: 2 }, { days: 2, hostId: "host-1" }]),
    );
    expect(slot.getByText("Imported")).toBeTruthy();
    expect(slot.queryByLabelText("Looking for chats")).toBeNull();
    expect(
      slot
        .getByRole("button", { name: "Import 0 chats" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await act(async () =>
      relisted.resolve({
        ...preview(2, [
          parent,
          {
            ...nested,
            status: "already-imported",
            reason: "Already imported.",
            threadId: "thr-nested",
            project: null,
          },
          sibling,
        ]),
        projects: [
          { id: "p-app", name: "app", paths: ["/home/ada/code/app"] },
          { id: "p-sub", name: "sub", paths: ["/home/ada/x/proj/sub"] },
        ],
      }),
    );

    expect(slot.getByText("Imported")).toBeTruthy();
    expect(slot.getByText("sub · Claude Code · 1 h ago")).toBeTruthy();

    fireEvent.click(slot.getByRole("checkbox", { name: "Chat parent" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Chat sibling" }));
    fireEvent.click(slot.getByRole("button", { name: "Import 2 chats" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls
          .filter((call) => call.method === "importChat")
          .map((call) => [
            (call.input as { sourceProviderThreadId: string })
              .sourceProviderThreadId,
            (call.input as { project: unknown }).project,
          ]),
      ).toEqual([
        ["nested", { kind: "new", name: "sub", path: "/home/ada/x/proj/sub" }],
        ["parent", { kind: "new", name: "proj", path: "/home/ada/x/proj" }],
        ["sibling", { kind: "existing", projectId: "p-sub", name: "sub" }],
      ]),
    );
  });

  it("labels and imports each chat with the project planned for the current selection", async () => {
    const folder = (path: string) => ({
      cwd: path,
      projectRoot: { path, kind: "folder" as const, mainRepositoryPath: null },
    });

    const slot = render(undefined, [
      chat({ key: "claude-code:parent", ...folder("/home/ada/x/proj") }),
      chat({ key: "claude-code:nested", ...folder("/home/ada/x/proj/sub") }),
      chat({ key: "claude-code:first-app", cwd: "/home/ada/a/app" }),
      chat({ key: "claude-code:second-app", cwd: "/home/ada/b/app" }),
    ]);

    await slot.findByRole("button", { name: "Import 4 chats" });
    expect(
      slot.getAllByText("New project · proj · Claude Code · 1 h ago"),
    ).toHaveLength(2);
    expect(
      slot.getByText("New project · app 2 · Claude Code · 1 h ago"),
    ).toBeTruthy();
    expect(slot.getByText("New projects: proj, app 2, app 3")).toBeTruthy();

    fireEvent.click(slot.getByRole("checkbox", { name: "Chat parent" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Chat first-app" }));

    expect(
      slot.getByText("New project · sub · Claude Code · 1 h ago"),
    ).toBeTruthy();
    expect(slot.getByText("New projects: sub, app 2")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Import 2 chats" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls
          .filter((call) => call.method === "importChat")
          .map((call) => (call.input as { project: unknown }).project),
      ).toEqual([
        { kind: "new", name: "sub", path: "/home/ada/x/proj/sub" },
        { kind: "new", name: "app 2", path: "/home/ada/b/app" },
      ]),
    );
  });
});
