import type { OmnyoSdkAreas } from "@omnyo/sdk";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  makeEnvironment,
  makeThreadWithRuntime,
  makeThreadListEntry,
  makeHost,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  environmentQueryKey,
  hostsQueryKey,
  hostQueryKey,
  projectsQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
} from "@/hooks/queries/query-keys";
import {
  makeSidebarBootstrapResponse,
  makeProjectWithThreadsResponse,
} from "@/test/fixtures/projects";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
} from "@omnyo/server-contract";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import type { InboxEntry, InboxSnapshot } from "@omnyo/domain";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import { bindSdkToPlugin, getPluginBoundSdk } from "./plugin-bound-sdk";

function inboxEntry(threadId: string, sortAt = 1): InboxEntry {
  return {
    threadId,
    projectId: "proj_1",
    title: threadId,
    shelved: false,
    automationId: null,
    state: "finished",
    reason: { kind: "recap", text: "Done", threadId },
    recap: null,
    archiveReady: true,
    optionalQuestion: null,
    pendingResults: 0,
    view: "inbox",
    card: {
      kind: "result",
      causes: [],
      primary: { kind: "archive" },
      actions: ["archive"],
      questionIds: [],
      questionMode: null,
      questionFrom: null,
      snoozedQuestionUntil: null,
      stillOnYou: null,
      notAssessed: null,
      failure: null,
      since: 1,
    },
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt,
    latch: "inbox",
  };
}

function inboxSnapshot(entries: InboxEntry[]): InboxSnapshot {
  return {
    revision: "rev",
    generatedAt: 0,
    inbox: entries,
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      needsYou: 0,
      inbox: entries.length,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

function bindWithInbox() {
  const fake = makeSdk();
  const act = vi.fn();
  const undo = vi.fn();

  const sdk = {
    ...fake.sdk,
    experimental_inbox: { act, undo },
  } as unknown as OmnyoSdkAreas;

  fake.queryClient.setQueryData(
    INBOX_SNAPSHOT_QUERY_KEY,
    inboxSnapshot([inboxEntry("thr_root"), inboxEntry("thr_other", 2)]),
  );

  return {
    ...fake,
    act,
    bound: bindSdkToPlugin(sdk, "chat-topics", fake.queryClient),
    inboxIds: () =>
      readPredictedInboxSnapshot(fake.queryClient)?.inbox.map(
        (entry) => entry.threadId,
      ),
    undo,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, reject, resolve };
}

function makeSdk() {
  const threads = {
    send: vi.fn(async (args: unknown) => args),
    queuedMessages: { create: vi.fn(async (args: unknown) => args) },
    spawn: vi.fn(async (args: unknown) => args),
    fork: vi.fn(async (args: unknown) => args),
    getPluginMetadata: vi.fn(async (args: unknown) => args),
    updatePluginMetadata: vi.fn(async (args: unknown) => args),
    update: vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId }),
    ),
    pin: vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, pinnedAt: 1 }),
    ),
    unpin: vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, pinnedAt: null }),
    ),
    shelve: vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, shelvedAt: 1 }),
    ),
    unshelve: vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, shelvedAt: null }),
    ),
    reorderPinned: vi.fn(
      async (_args: {
        threadId: string;
        previousThreadId: string | null;
        nextThreadId: string | null;
      }) => [
        makeThreadListEntry({
          id: "thr_reorder",
          pinnedAt: 1,
          pinSortKey: "a",
        }),
      ],
    ),
    experimental_reorderShelved: vi.fn(
      async (_args: {
        threadId: string;
        previousThreadId: string | null;
        nextThreadId: string | null;
      }) => [
        makeThreadListEntry({
          id: "thr_shelved",
          shelvedAt: 1,
          shelfSortKey: "b",
        }),
      ],
    ),
    unarchive: vi.fn(async (_args: { threadId: string }) => ({
      ok: true as const,
    })),
  };

  const environments = {
    archiveThreads: vi.fn(async (_args: { environmentId: string }) => ({
      ok: true as const,
      archivedThreadIds: ["thr_1", "thr_2", "thr_child", "thr_grandchild"],
    })),
    update: vi.fn(async (args: { name?: string | null }) =>
      makeEnvironment({ id: "env_1", name: args.name ?? null }),
    ),
  };

  const threadSections = {
    create: vi.fn(async ({ name }: { name: string }) => ({
      id: "sec_created",
      name,
      createdAt: 0,
      updatedAt: 0,
    })),
    update: vi.fn(async ({ id, name }: { id: string; name: string }) => ({
      id,
      name,
      updatedThreadCount: 0,
    })),
    delete: vi.fn(async ({ id }: { id: string }) => ({
      id,
      name: "Section",
      updatedThreadCount: 1,
    })),
  };

  const projects = {
    update: vi.fn(
      async ({ projectId, name }: { projectId: string; name: string }) =>
        makeProjectWithThreadsResponse({ id: projectId, name }),
    ),
    delete: vi.fn(async (_args: { projectId: string }) => ({
      ok: true as const,
    })),
  };

  const hosts = {
    update: vi.fn(async ({ hostId, name }: { hostId: string; name: string }) =>
      makeHost({ id: hostId, name }),
    ),
  };

  return {
    sdk: {
      environments,
      threads,
      threadSections,
      projects,
      hosts,
    } as unknown as OmnyoSdkAreas,
    environments,
    projects,
    hosts,
    queryClient: new QueryClient(),
    threads,
    threadSections,
  };
}

describe("bindSdkToPlugin", () => {
  it("attributes plugin sends and queued callbacks even when a user source is supplied", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "resources", queryClient);

    const input = [
      { type: "text" as const, text: "Result ready", mentions: [] },
    ];

    await bound.threads.send({
      threadId: "thr_target",
      input,
      mode: "auto",
      messageSource: { kind: "user" },
    });
    await bound.threads.queuedMessages.create({
      threadId: "thr_target",
      input,
    });
    expect(threads.send).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSource: { kind: "plugin", pluginId: "resources" },
      }),
    );
    expect(threads.queuedMessages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSource: { kind: "plugin", pluginId: "resources" },
      }),
    );
  });

  it("shows a plugin send in the target chat before the server answers and rolls it back when the send fails", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "chat-topics", queryClient);
    const response = deferred<never>();
    threads.send.mockImplementationOnce(() => response.promise);

    queryClient.setQueryData(
      threadQueryKey("thr_target"),
      makeThreadResponse({ id: "thr_target", status: "idle" }),
    );

    const sending = bound.threads.send({
      threadId: "thr_target",
      input: [{ type: "text", text: "Over here", mentions: [] }],
      mode: "auto",
    });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<ThreadResponse>(threadQueryKey("thr_target"))
          ?.status,
      ).toBe("active"),
    );
    expect(threads.send).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_target",
        requestId: expect.any(String),
        messageSource: { kind: "plugin", pluginId: "chat-topics" },
      }),
    );

    response.reject(new Error("offline"));
    await expect(sending).rejects.toThrow("offline");
    expect(
      queryClient.getQueryData<ThreadResponse>(threadQueryKey("thr_target"))
        ?.status,
    ).toBe("idle");
  });

  it("lists a plugin-queued message at once and removes it when the server refuses it", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "side-chat", queryClient);
    const response = deferred<never>();
    threads.queuedMessages.create.mockImplementationOnce(
      () => response.promise,
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thr_target"), []);

    const queuedIds = () =>
      queryClient
        .getQueryData<{ id: string }[]>(
          threadQueuedMessagesQueryKey("thr_target"),
        )
        ?.map((message) => message.id);

    const queuing = bound.threads.queuedMessages.create({
      threadId: "thr_target",
      input: [{ type: "text", text: "From the side", mentions: [] }],
    });

    await vi.waitFor(() =>
      expect(queuedIds()).toEqual([
        expect.stringMatching(/^optimistic-queued-/),
      ]),
    );

    response.reject(new Error("offline"));
    await expect(queuing).rejects.toThrow("offline");
    expect(queuedIds()).toEqual([]);
  });

  it("stamps the plugin as the origin of spawned and forked threads", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads.spawn({ projectId: "proj_1", prompt: "hi" } as never);
    expect(threads.spawn).toHaveBeenCalledWith({
      projectId: "proj_1",
      prompt: "hi",
      origin: "plugin",
      originPluginId: "thread-list",
    });
    await bound.threads.fork({ sourceThreadId: "thr_1" } as never);
    expect(threads.fork).toHaveBeenCalledWith({
      sourceThreadId: "thr_1",
      origin: "plugin",
      originPluginId: "thread-list",
    });
  });

  it("keeps an explicit non-plugin origin and an explicit plugin id", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads.spawn({ prompt: "hi", origin: "user" } as never);
    expect(threads.spawn).toHaveBeenLastCalledWith({
      prompt: "hi",
      origin: "user",
    });
    await bound.threads.spawn({
      prompt: "hi",
      origin: "plugin",
      originPluginId: "other",
    } as never);
    expect(threads.spawn).toHaveBeenLastCalledWith({
      prompt: "hi",
      origin: "plugin",
      originPluginId: "other",
    });
    await bound.threads.spawn({
      prompt: "hi",
      origin: "user",
      pluginMetadata: { note: 1 },
    } as never);
    expect(threads.spawn).toHaveBeenLastCalledWith({
      prompt: "hi",
      origin: "plugin",
      originPluginId: "thread-list",
      pluginMetadata: { note: 1 },
    });
  });

  it("defaults the plugin id on metadata calls without hiding an explicit one", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads.getPluginMetadata({ threadId: "thr_1" });
    expect(threads.getPluginMetadata).toHaveBeenCalledWith({
      threadId: "thr_1",
      pluginId: "thread-list",
    });
    await bound.threads.updatePluginMetadata({
      threadId: "thr_1",
      pluginId: "other",
      set: { a: 1 },
    });
    expect(threads.updatePluginMetadata).toHaveBeenCalledWith({
      threadId: "thr_1",
      pluginId: "other",
      set: { a: 1 },
    });
  });

  it("preserves SDK arguments while applying cache updates", async () => {
    const { sdk, queryClient, threads, threadSections } = makeSdk();
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads.pin({ threadId: "thr_1" });
    await bound.threadSections.create({ name: "Later" });
    expect(threads.pin).toHaveBeenCalledWith({ threadId: "thr_1" });
    expect(threadSections.create).toHaveBeenCalledWith({ name: "Later" });
  });

  it("batches synchronous plugin thread metadata updates into one optimistic transaction", async () => {
    const { sdk, queryClient, threads } = makeSdk();

    const pending = new Map<
      string,
      ReturnType<typeof deferred<ReturnType<typeof makeThreadResponse>>>
    >();

    threads.update.mockImplementation(({ threadId }: { threadId: string }) => {
      const request = deferred<ReturnType<typeof makeThreadResponse>>();
      pending.set(threadId, request);

      return request.promise;
    });

    for (const id of ["thr_1", "thr_2"]) {
      queryClient.setQueryData(
        threadQueryKey(id),
        makeThreadWithRuntime({ id, parentThreadId: null }),
      );
    }

    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    const updates = ["thr_1", "thr_2"].map((threadId) =>
      bound.threads.update({ threadId, parentThreadId: "thr_parent" }),
    );

    await vi.waitFor(() => {
      expect(
        ["thr_1", "thr_2"].map(
          (id) =>
            queryClient.getQueryData<ReturnType<typeof makeThreadWithRuntime>>(
              threadQueryKey(id),
            )?.parentThreadId,
        ),
      ).toEqual(["thr_parent", "thr_parent"]);
    });
    expect(cancelQueries).toHaveBeenCalledTimes(4);

    for (const id of ["thr_1", "thr_2"]) {
      pending
        .get(id)
        ?.resolve(makeThreadResponse({ id, parentThreadId: "thr_parent" }));
    }

    await expect(Promise.all(updates)).resolves.toHaveLength(2);
  });

  it("rolls back a plugin thread metadata batch when one update fails", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    threads.update.mockImplementation(({ threadId }: { threadId: string }) =>
      threadId === "thr_1"
        ? Promise.resolve(makeThreadResponse({ id: threadId }))
        : Promise.reject(new Error("update failed")),
    );

    for (const id of ["thr_1", "thr_2"]) {
      queryClient.setQueryData(
        threadQueryKey(id),
        makeThreadWithRuntime({ id, sectionId: "section-a" }),
      );
    }

    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    const results = await Promise.allSettled(
      ["thr_1", "thr_2"].map((threadId) =>
        bound.threads.update({ threadId, sectionId: "section-b" }),
      ),
    );

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      ["thr_1", "thr_2"].map(
        (id) =>
          queryClient.getQueryData<ReturnType<typeof makeThreadWithRuntime>>(
            threadQueryKey(id),
          )?.sectionId,
      ),
    ).toEqual(["section-a", "section-a"]);
  });

  it("keeps an in-flight move over refetched sidebar data until the write settles", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const request = deferred<ReturnType<typeof makeThreadResponse>>();
    threads.update.mockImplementation(() => request.promise);
    const sidebarKey = sidebarNavigationQueryKey();

    const serverNavigation = (sectionId: string) =>
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            threads: [
              makeThreadListEntry({ id: "thr_moved", sectionId }),
              makeThreadListEntry({
                id: "thr_child",
                parentThreadId: "thr_moved",
              }),
            ],
          }),
        ],
      });

    const sidebarSectionId = () =>
      queryClient
        .getQueryData<SidebarBootstrapResponse>(sidebarKey)
        ?.projects[0]?.threads.find((thread) => thread.id === "thr_moved")
        ?.sectionId;

    const refetchSidebar = (sectionId: string) =>
      queryClient.fetchQuery({
        queryKey: sidebarKey,
        queryFn: async () => serverNavigation(sectionId),
        staleTime: 0,
      });

    queryClient.setQueryData(sidebarKey, serverNavigation("section-a"));
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    const update = bound.threads.update({
      threadId: "thr_moved",
      sectionId: "section-b",
    });

    await vi.waitFor(() => expect(sidebarSectionId()).toBe("section-b"));

    await refetchSidebar("section-a");
    expect(sidebarSectionId()).toBe("section-b");
    expect(
      queryClient
        .getQueryData<SidebarBootstrapResponse>(sidebarKey)
        ?.projects[0]?.threads.map((thread) => thread.id),
    ).toContain("thr_child");

    request.resolve(
      makeThreadResponse({ id: "thr_moved", sectionId: "section-b" }),
    );
    await update;
    await refetchSidebar("section-a");
    expect(sidebarSectionId()).toBe("section-a");
    queryClient.clear();
  });

  it("keeps a shelved family out of refetched sidebar data until the write settles", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    const request = deferred<ReturnType<typeof makeThreadResponse>>();
    threads.shelve.mockImplementation(() => request.promise);
    const sidebarKey = sidebarNavigationQueryKey();

    const serverNavigation = () =>
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            threads: [
              makeThreadListEntry({ id: "thr_root", shelvedAt: null }),
              makeThreadListEntry({
                id: "thr_child",
                parentThreadId: "thr_root",
                shelvedAt: null,
              }),
              makeThreadListEntry({ id: "thr_other", shelvedAt: null }),
            ],
          }),
        ],
      });

    const shelvedIds = () =>
      queryClient
        .getQueryData<SidebarBootstrapResponse>(sidebarKey)
        ?.projects[0]?.threads.filter((thread) => thread.shelvedAt !== null)
        .map((thread) => thread.id);

    const refetchSidebar = () =>
      queryClient.fetchQuery({
        queryKey: sidebarKey,
        queryFn: async () => serverNavigation(),
        staleTime: 0,
      });

    queryClient.setQueryData(sidebarKey, serverNavigation());
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    const shelve = bound.threads.shelve({ threadId: "thr_root" });

    await vi.waitFor(() =>
      expect(shelvedIds()).toEqual(["thr_root", "thr_child"]),
    );
    await refetchSidebar();
    expect(shelvedIds()).toEqual(["thr_root", "thr_child"]);
    expect(threads.shelve).toHaveBeenCalledWith({ threadId: "thr_root" });

    request.resolve(makeThreadResponse({ id: "thr_root", shelvedAt: 1 }));
    await shelve;
    await refetchSidebar();
    expect(shelvedIds()).toEqual([]);
    queryClient.clear();
  });

  it("returns a family to the list when shelving fails", async () => {
    const { sdk, queryClient, threads } = makeSdk();
    threads.shelve.mockRejectedValue(new Error("shelve failed"));
    const sidebarKey = sidebarNavigationQueryKey();

    queryClient.setQueryData(
      sidebarKey,
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            threads: [
              makeThreadListEntry({ id: "thr_root", shelvedAt: null }),
              makeThreadListEntry({
                id: "thr_child",
                parentThreadId: "thr_root",
                shelvedAt: null,
              }),
            ],
          }),
        ],
      }),
    );

    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    await expect(
      bound.threads.shelve({ threadId: "thr_root" }),
    ).rejects.toThrow("shelve failed");
    expect(
      queryClient
        .getQueryData<SidebarBootstrapResponse>(sidebarKey)
        ?.projects[0]?.threads.map((thread) => thread.shelvedAt),
    ).toEqual([null, null]);
  });

  it("applies the server's pinned order before the caller clears its drag preview", async () => {
    const { sdk, queryClient } = makeSdk();

    const entry = makeThreadListEntry({
      id: "thr_reorder",
      pinnedAt: 1,
      pinSortKey: "z",
    });

    const sidebarKey = sidebarNavigationQueryKey();
    queryClient.setQueryData(
      sidebarKey,
      makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ threads: [entry] })],
      }),
    );
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads
      .reorderPinned({
        threadId: entry.id,
        previousThreadId: null,
        nextThreadId: null,
      })
      .then(() => {
        expect(
          queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
            ?.projects[0]?.threads[0]?.pinSortKey,
        ).toBe("a");
      });
    queryClient.clear();
  });

  it("applies the server's Shelf order to the shelved list before the caller clears its drag preview", async () => {
    const { sdk, queryClient } = makeSdk();

    const entry = makeThreadListEntry({
      id: "thr_shelved",
      shelvedAt: 1,
      shelfSortKey: "z",
    });

    const shelfKey = shelvedThreadsListQueryKey();
    queryClient.setQueryData(shelfKey, { pages: [[entry]], pageParams: [0] });
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
    await bound.threads
      .experimental_reorderShelved({
        threadId: entry.id,
        previousThreadId: null,
        nextThreadId: null,
      })
      .then(() => {
        expect(
          queryClient.getQueryData<{
            pages: { shelfSortKey: string | null }[][];
          }>(shelfKey)?.pages[0]?.[0]?.shelfSortKey,
        ).toBe("b");
      });
    queryClient.clear();
  });
  it.each(["success", "failure"])(
    "restores an archived sidebar thread optimistically on %s",
    async (outcome) => {
      const { sdk, queryClient, threads } = makeSdk();

      const entry = makeThreadListEntry({
        id: "thr_restore",
        projectId: "proj_1",
        archivedAt: 1,
      });

      const listKey = threadListQueryKey({
        projectId: "proj_1",
        archived: true,
      });

      const sidebarKey = sidebarNavigationQueryKey();
      queryClient.setQueryData(listKey, [entry]);
      queryClient.setQueryData(
        sidebarKey,
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({ id: "proj_1", threads: [] }),
          ],
        }),
      );
      const pending = deferred<{ ok: true }>();
      threads.unarchive.mockReturnValueOnce(pending.promise);
      const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
      const restore = bound.threads.unarchive({ threadId: entry.id });
      await vi.waitFor(() => {
        expect(queryClient.getQueryData<(typeof entry)[]>(listKey)).toEqual([]);
        expect(
          queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
            ?.projects[0]?.threads,
        ).toMatchObject([{ id: entry.id, archivedAt: null }]);
      });

      if (outcome === "failure") {
        pending.reject(new Error("restore failed"));
        await expect(restore).rejects.toThrow("restore failed");
        expect(queryClient.getQueryData<(typeof entry)[]>(listKey)).toEqual([
          entry,
        ]);
        expect(
          queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
            ?.projects[0]?.threads,
        ).toEqual([]);
      } else {
        pending.resolve({ ok: true });
        await restore;
      }

      expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
      queryClient.clear();
    },
  );

  it.each(["success", "failure"])(
    "moves a pinned thread immediately and reconciles %s",
    async (outcome) => {
      const { sdk, queryClient, threads } = makeSdk();

      const entry = makeThreadListEntry({
        id: "thr_move",
        pinnedAt: 1,
        sectionId: "old",
      });

      const sidebarKey = sidebarNavigationQueryKey();
      queryClient.setQueryData(
        sidebarKey,
        makeSidebarBootstrapResponse({
          projects: [makeProjectWithThreadsResponse({ threads: [entry] })],
        }),
      );
      const pending = deferred<ReturnType<typeof makeThreadResponse>>();
      threads.unpin.mockReturnValueOnce(pending.promise);
      threads.update.mockResolvedValueOnce(
        makeThreadResponse({ id: entry.id, pinnedAt: null, sectionId: "new" }),
      );
      const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

      const moved = Promise.all([
        bound.threads.unpin({ threadId: entry.id }),
        bound.threads.update({ threadId: entry.id, sectionId: "new" }),
      ]);

      const current = () =>
        queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
          ?.projects[0]?.threads[0];

      await vi.waitFor(() =>
        expect(current()).toMatchObject({ pinnedAt: null, sectionId: "new" }),
      );
      expect(threads.update).not.toHaveBeenCalled();

      if (outcome === "failure") {
        pending.reject(new Error("unpin failed"));
        await expect(moved).rejects.toThrow("unpin failed");
        expect(current()).toMatchObject({ pinnedAt: 1, sectionId: "old" });
        expect(threads.update).not.toHaveBeenCalled();
      } else {
        pending.resolve(
          makeThreadResponse({
            id: entry.id,
            pinnedAt: null,
            sectionId: "old",
          }),
        );
        await moved;
        expect(current()).toMatchObject({ pinnedAt: null, sectionId: "new" });
      }

      queryClient.clear();
    },
  );

  it.each(["project", "host", "section"])(
    "renames a %s in shared sidebar caches before the server responds and rolls back failure",
    async (kind) => {
      const { sdk, queryClient, projects, hosts, threadSections } = makeSdk();

      const project = makeProjectWithThreadsResponse({
        id: "proj_1",
        name: "Project",
      });

      const host = makeHost({ id: "host_1", name: "Machine" });

      const section = {
        id: "sec_1",
        name: "Section",
        createdAt: 0,
        updatedAt: 0,
      };

      const sidebarKey = sidebarNavigationQueryKey();
      queryClient.setQueryData(
        sidebarKey,
        makeSidebarBootstrapResponse({
          projects: [project],
          sections: [section],
        }),
      );
      queryClient.setQueryData(projectsQueryKey(), [project]);
      queryClient.setQueryData(hostsQueryKey(), [host]);
      queryClient.setQueryData(hostQueryKey(host.id), host);
      const pending = deferred<never>();
      const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

      const current = () =>
        kind === "host"
          ? queryClient.getQueryData<(typeof host)[]>(hostsQueryKey())?.[0]
              ?.name
          : kind === "project"
            ? queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
                ?.projects[0]?.name
            : queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
                ?.sections[0]?.name;

      let rename;

      if (kind === "host") {
        hosts.update.mockReturnValueOnce(pending.promise);
        rename = bound.hosts.update({ hostId: host.id, name: "New name" });
      } else if (kind === "project") {
        projects.update.mockReturnValueOnce(pending.promise);
        rename = bound.projects.update({
          projectId: project.id,
          name: "New name",
        });
      } else {
        threadSections.update.mockReturnValueOnce(pending.promise);
        rename = bound.threadSections.update({
          id: section.id,
          name: "New name",
        });
      }

      await vi.waitFor(() => expect(current()).toBe("New name"));
      pending.reject(new Error("rename failed"));
      await expect(rename).rejects.toThrow("rename failed");
      expect(current()).toBe(
        kind === "host"
          ? "Machine"
          : kind === "project"
            ? "Project"
            : "Section",
      );
      queryClient.clear();
    },
  );

  it.each(["project", "section"])(
    "removes a %s immediately and restores it on failure without losing unrelated changes",
    async (kind) => {
      const { sdk, queryClient, projects, threadSections } = makeSdk();

      const entry = makeThreadListEntry({
        id: "thr_section",
        sectionId: "sec_1",
      });

      const project = makeProjectWithThreadsResponse({
        id: "proj_1",
        threads: [entry],
      });

      const unrelated = makeProjectWithThreadsResponse({
        id: "proj_other",
        name: "Unrelated",
      });

      const section = {
        id: "sec_1",
        name: "Section",
        createdAt: 0,
        updatedAt: 0,
      };

      const sidebarKey = sidebarNavigationQueryKey();
      queryClient.setQueryData(
        sidebarKey,
        makeSidebarBootstrapResponse({
          projects: [project, unrelated],
          sections: [section],
        }),
      );
      const pending = deferred<never>();
      const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);
      let removal;

      if (kind === "project") {
        projects.delete.mockReturnValueOnce(pending.promise);
        removal = bound.projects.delete({ projectId: project.id });
      } else {
        threadSections.delete.mockReturnValueOnce(pending.promise);
        removal = bound.threadSections.delete({ id: section.id });
      }

      await vi.waitFor(() => {
        const sidebar =
          queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey);

        if (kind === "project")
          expect(sidebar?.projects.map((p) => p.id)).toEqual([unrelated.id]);
        else {
          expect(sidebar?.sections).toEqual([]);
          expect(sidebar?.projects[0]?.threads[0]?.sectionId).toBeNull();
        }
      });
      queryClient.setQueryData<SidebarBootstrapResponse>(
        sidebarKey,
        (current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((p) =>
                  p.id === unrelated.id
                    ? { ...p, name: "Concurrent rename" }
                    : p,
                ),
              }
            : current,
      );
      pending.reject(new Error("remove failed"));
      await expect(removal).rejects.toThrow("remove failed");

      const sidebar =
        queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey);

      expect(sidebar?.projects.map((p) => p.id)).toEqual([
        project.id,
        unrelated.id,
      ]);
      expect(sidebar?.projects[0]?.threads[0]?.sectionId).toBe("sec_1");
      expect(sidebar?.sections).toEqual([section]);
      expect(sidebar?.projects[1]?.name).toBe("Concurrent rename");
      queryClient.clear();
    },
  );

  it.each(["success", "failure"])(
    "optimistically archives a worktree group and reconciles %s",
    async (outcome) => {
      const { sdk, environments, queryClient } = makeSdk();

      const pending =
        deferred<Awaited<ReturnType<typeof sdk.environments.archiveThreads>>>();

      environments.archiveThreads.mockReturnValueOnce(pending.promise);

      const entries = [
        makeThreadListEntry({ id: "thr_1", environmentId: "env_1" }),
        makeThreadListEntry({ id: "thr_2", environmentId: "env_1" }),
        makeThreadListEntry({
          id: "thr_child",
          environmentId: "env_2",
          parentThreadId: "thr_1",
        }),
        makeThreadListEntry({
          id: "thr_grandchild",
          environmentId: "env_2",
          parentThreadId: "thr_child",
        }),
        makeThreadListEntry({ id: "thr_other", environmentId: "env_2" }),
        makeThreadListEntry({
          id: "thr_archived",
          environmentId: "env_1",
          archivedAt: 1,
        }),
      ];

      const sidebarKey = sidebarNavigationQueryKey();

      const listKey = threadListQueryKey({
        projectId: "proj_1",
        archived: false,
      });

      queryClient.setQueryData(
        sidebarKey,
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({
              id: "proj_1",
              threads: entries.slice(0, 3),
            }),
          ],
        }),
      );
      queryClient.setQueryData(listKey, entries);
      queryClient.setQueryData(
        threadQueryKey("thr_1"),
        makeThreadWithRuntime({
          id: "thr_1",
          environmentId: "env_1",
          archivedAt: null,
        }),
      );
      const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

      const archive = bound.environments.archiveThreads({
        environmentId: "env_1",
      });

      const sidebarIds = () =>
        queryClient
          .getQueryData<SidebarBootstrapResponse>(sidebarKey)
          ?.projects[0]?.threads.map((thread) => thread.id);

      const listIds = () =>
        queryClient
          .getQueryData<typeof entries>(listKey)
          ?.map((thread) => thread.id);

      await vi.waitFor(() => {
        expect(sidebarIds()).toEqual([]);
        expect(listIds()).toEqual(["thr_other", "thr_archived"]);
      });
      expect(environments.archiveThreads).toHaveBeenCalledWith({
        environmentId: "env_1",
      });
      expect(
        queryClient.getQueryData<ReturnType<typeof makeThreadWithRuntime>>(
          threadQueryKey("thr_1"),
        )?.archivedAt,
      ).toEqual(expect.any(Number));
      queryClient.setQueryData<typeof entries>(listKey, (list) =>
        list?.map((thread) =>
          thread.id === "thr_other"
            ? { ...thread, title: "Concurrent rename" }
            : thread,
        ),
      );

      if (outcome === "failure") {
        pending.reject(new Error("archive failed"));
        await expect(archive).rejects.toThrow("archive failed");
        expect(sidebarIds()).toEqual(["thr_1", "thr_2", "thr_child"]);
        expect(listIds()).toEqual(entries.map((thread) => thread.id));
        expect(
          queryClient.getQueryData<ReturnType<typeof makeThreadWithRuntime>>(
            threadQueryKey("thr_1"),
          )?.archivedAt,
        ).toBeNull();
      } else {
        pending.resolve({
          ok: true,
          archivedThreadIds: ["thr_1", "thr_2", "thr_child", "thr_grandchild"],
        });
        await expect(archive).resolves.toMatchObject({ ok: true });
        expect(sidebarIds()).toEqual([]);
        expect(listIds()).toEqual(["thr_other", "thr_archived"]);
      }

      expect(
        queryClient
          .getQueryData<typeof entries>(listKey)
          ?.find((thread) => thread.id === "thr_other")?.title,
      ).toBe("Concurrent rename");
      expect(queryClient.getQueryState(sidebarKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
      queryClient.clear();
    },
  );

  it.each([
    { label: "rename", name: "Renamed environment" },
    { label: "clear", name: null },
  ])("optimistically applies a plugin environment $label", async ({ name }) => {
    const { sdk, environments, queryClient } = makeSdk();
    const pending = deferred<ReturnType<typeof makeEnvironment>>();
    environments.update.mockReturnValueOnce(pending.promise);
    queryClient.setQueryData(
      environmentQueryKey("env_1"),
      makeEnvironment({ id: "env_1", name: "Original environment" }),
    );
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    const update = bound.environments.update({
      environmentId: "env_1",
      name,
    });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<ReturnType<typeof makeEnvironment>>(
          environmentQueryKey("env_1"),
        )?.name,
      ).toBe(name),
    );
    expect(environments.update).toHaveBeenCalledWith({
      environmentId: "env_1",
      name,
    });

    pending.resolve(makeEnvironment({ id: "env_1", name }));
    await expect(update).resolves.toMatchObject({ name });
  });

  it("rolls back a failed plugin environment rename", async () => {
    const { sdk, environments, queryClient } = makeSdk();
    const pending = deferred<ReturnType<typeof makeEnvironment>>();
    environments.update.mockReturnValueOnce(pending.promise);
    queryClient.setQueryData(
      environmentQueryKey("env_1"),
      makeEnvironment({ id: "env_1", name: "Original environment" }),
    );
    const bound = bindSdkToPlugin(sdk, "thread-list", queryClient);

    const update = bound.environments.update({
      environmentId: "env_1",
      name: "Optimistic environment",
    });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<ReturnType<typeof makeEnvironment>>(
          environmentQueryKey("env_1"),
        )?.name,
      ).toBe("Optimistic environment"),
    );
    pending.reject(new Error("update failed"));

    await expect(update).rejects.toThrow("update failed");
    expect(
      queryClient.getQueryData<ReturnType<typeof makeEnvironment>>(
        environmentQueryKey("env_1"),
      )?.name,
    ).toBe("Original environment");
  });
});

describe("bound Inbox moves", () => {
  it("keeps an unarchived sidebar row when Inbox Undo finishes before a stale refresh", async () => {
    const { act, bound, queryClient, undo } = bindWithInbox();
    const root = makeThreadListEntry({ id: "thr_root", projectId: "proj_1" });
    const key = sidebarNavigationQueryKey();

    const navigation = (threads: (typeof root)[]) =>
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({ id: root.projectId, threads }),
        ],
      });

    queryClient.setQueryData(key, navigation([root]));
    act.mockResolvedValue({ moveId: "mov_1", entry: null });
    await bound.experimental_inbox.act({
      request: {
        action: "archive",
        threadId: root.id,
        displayedReceiptIds: [],
        stopRunning: false,
      },
    });
    const response = deferred<unknown>();
    undo.mockImplementation(() => response.promise);
    const undoing = bound.experimental_inbox.undo({ moveId: "mov_1" });

    const sidebarIds = () =>
      queryClient
        .getQueryData<SidebarBootstrapResponse>(key)
        ?.projects[0]?.threads.map(({ id }) => id);

    await vi.waitFor(() => expect(sidebarIds()).toEqual([root.id]));
    const refresh = deferred<ReturnType<typeof navigation>>();

    const reading = queryClient
      .fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: () => refresh.promise,
      })
      .catch(() => undefined);

    response.resolve({ moveId: "mov_2", entry: inboxEntry(root.id) });
    await undoing;
    refresh.resolve(navigation([]));
    await reading;
    expect(sidebarIds()).toEqual([root.id]);
    queryClient.clear();
  });

  it("removes an archived chat from the shared Inbox at once and restores it when the server refuses", async () => {
    const { act, bound, inboxIds, queryClient } = bindWithInbox();
    const response = deferred<unknown>();
    act.mockImplementation(() => response.promise);

    const move = bound.experimental_inbox.act({
      request: {
        action: "archive",
        threadId: "thr_root",
        displayedReceiptIds: [],
        stopRunning: false,
      },
    });

    await vi.waitFor(() => expect(inboxIds()).toEqual(["thr_other"]));
    response.reject(new Error("refused"));
    await expect(move).rejects.toThrow("refused");
    expect(inboxIds()).toEqual(["thr_root", "thr_other"]);
    queryClient.clear();
  });

  it("restores the archived rows at once when the move is undone", async () => {
    const { act, bound, inboxIds, queryClient, undo } = bindWithInbox();
    act.mockResolvedValue({ moveId: "mov_1", entry: null });

    await bound.experimental_inbox.act({
      request: {
        action: "archive",
        threadId: "thr_root",
        displayedReceiptIds: [],
        stopRunning: false,
      },
    });

    expect(inboxIds()).toEqual(["thr_other"]);
    const response = deferred<unknown>();
    undo.mockImplementation(() => response.promise);
    const undoing = bound.experimental_inbox.undo({ moveId: "mov_1" });

    await vi.waitFor(() =>
      expect(inboxIds()).toEqual(["thr_root", "thr_other"]),
    );
    response.resolve({ moveId: "mov_2", entry: inboxEntry("thr_root") });
    await undoing;
    expect(inboxIds()).toEqual(["thr_root", "thr_other"]);
    queryClient.clear();
  });
});

describe("getPluginBoundSdk", () => {
  it("returns one stable client per plugin per underlying sdk", () => {
    const { sdk, queryClient } = makeSdk();
    const other = makeSdk().sdk;
    expect(getPluginBoundSdk(sdk, "a", queryClient)).toBe(
      getPluginBoundSdk(sdk, "a", queryClient),
    );
    expect(getPluginBoundSdk(sdk, "a", queryClient)).not.toBe(
      getPluginBoundSdk(sdk, "b", queryClient),
    );
    expect(getPluginBoundSdk(sdk, "a", queryClient)).not.toBe(
      getPluginBoundSdk(other, "a", queryClient),
    );
  });
});
