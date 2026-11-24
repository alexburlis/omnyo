// @vitest-environment jsdom

import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Thread, ThreadListEntry } from "@omnyo/domain";
import { makeThread as makeThreadFixture } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
} from "@/hooks/queries/query-keys";
import { getCachedSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { createQueryNotificationScheduler } from "@/test/queryNotificationScheduler";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import {
  AppCommandProvider,
  useAppCommandRunner,
  type AppCommandRunner,
} from "@/components/commands/AppCommandProvider";
import { ActionHistoryCommandHandlers } from "@/components/layout/ActionHistoryCommandHandlers";
import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import type { ThreadDeleteDialogTarget } from "@/components/dialogs/ThreadDeleteDialog";
import type { ThreadRenameDialogTarget } from "@/components/dialogs/ThreadRenameDialog";
import { ThreadActionsProvider } from "./ThreadActionsProvider";
import { useThreadActions } from "@/lib/thread-actions/thread-actions-context";

interface DeleteDialogProps {
  target: ThreadDeleteDialogTarget | null;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
}

interface RenameDialogProps {
  target: ThreadRenameDialogTarget | null;
  onRename: (threadId: string, payload: { title: string }) => void;
}

const mocks = vi.hoisted(() => ({
  confirmThreadArchive: true as boolean | undefined,
  closePanesForThreads: vi.fn(),
  deleteDialog: null as DeleteDialogProps | null,
  renameDialog: null as RenameDialogProps | null,
  mutation: vi.fn(),
  navigate: vi.fn(),
  pathname: "/",
  viewedThreadId: undefined as string | undefined,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();

  return {
    ...actual,
    useLocation: () => ({ hash: "", pathname: mocks.pathname, search: "" }),
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => mocks.navigate,
  useImmediateRouteNavigate: () => mocks.navigate,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();

  return {
    ...actual,
    useSetAtom: () => mocks.closePanesForThreads,
  };
});

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: (props: DeleteDialogProps) => {
    mocks.deleteDialog = props;

    return null;
  },
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: (props: RenameDialogProps) => {
    mocks.renameDialog = props;

    return null;
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/mutations/thread-state-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/mutations/thread-state-mutations")
    >();

  return {
    ...actual,
    useDeleteThread: () => ({ isPending: false, mutateAsync: mocks.mutation }),
    useMarkThreadRead: () => ({ mutate: mocks.mutation }),
    useMarkThreadUnread: () => ({ mutate: mocks.mutation }),
    usePinThread: () => ({ mutate: mocks.mutation }),
    useUnpinThread: () => ({ mutate: mocks.mutation }),
    useUpdateThread: () => ({
      isPending: false,
      mutate: mocks.mutation,
      mutateAsync: mocks.mutation,
    }),
  };
});

vi.mock("@/lib/sdk", () => ({
  sdk: {
    environments: { archiveThreads: vi.fn() },
    threads: {
      archiveAll: vi.fn(),
      childSummary: vi.fn(),
      shelve: vi.fn(),
      unarchive: vi.fn(),
      unshelve: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data:
      mocks.confirmThreadArchive === undefined
        ? undefined
        : {
            generalSettings: {
              confirmThreadArchive: mocks.confirmThreadArchive,
            },
          },
  }),
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: mocks.viewedThreadId }),
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id: "thr_parent",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate archive behavior",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

function ArchiveButton({ thread }: { thread: Thread }) {
  const { requestArchive } = useThreadActions();

  return (
    <button type="button" onClick={() => requestArchive(thread)}>
      Archive
    </button>
  );
}

const commandRunner: { current: AppCommandRunner | null } = { current: null };

function CommandRunnerProbe() {
  commandRunner.current = useAppCommandRunner();

  return null;
}

function dispatchCommand(command: "edit.undo" | "edit.redo"): boolean {
  let handled = false;
  act(() => {
    handled = commandRunner.current?.dispatch(command, null) ?? false;
  });

  return handled;
}

function ShelveButton({ thread }: { thread: Thread }) {
  const { requestShelve } = useThreadActions();

  return (
    <button type="button" onClick={() => requestShelve(thread)}>
      Shelve
    </button>
  );
}

function DeleteButton({ thread }: { thread: Thread }) {
  const { requestDelete } = useThreadActions();

  return (
    <button type="button" onClick={() => requestDelete(thread)}>
      Delete
    </button>
  );
}

function RenameButton({ thread }: { thread: Thread }) {
  const { requestRename } = useThreadActions();

  return (
    <button type="button" onClick={() => requestRename(thread)}>
      Rename
    </button>
  );
}

function seedSidebar(threads: readonly ThreadListEntry[]) {
  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({
          id: threads[0]?.projectId ?? "proj_test",
          threads: [...threads],
        }),
      ],
    }),
  );
}

function seedArchiveFamily() {
  const parent = makeThreadListEntry(makeThread());

  const child = makeThreadListEntry(
    makeThread({ id: "thr_child", parentThreadId: parent.id }),
  );

  seedSidebar([parent, child]);

  return { parent, child };
}

const sidebarIds = () =>
  getCachedSidebarNavigationThreads(queryClient).map((thread) => thread.id);

async function flushSettledRequests() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ArchiveEnvironmentButton() {
  const { archiveEnvironmentThreads } = useThreadActions();

  return (
    <button onClick={() => void archiveEnvironmentThreads("env_test")}>
      Archive group
    </button>
  );
}

function providerTree(children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppCommandProvider>
        <ActionHistoryProvider>
          <ThreadActionsProvider>
            <ActionHistoryCommandHandlers />
            <CommandRunnerProbe />
            {children}
          </ThreadActionsProvider>
        </ActionHistoryProvider>
      </AppCommandProvider>
    </QueryClientProvider>
  );
}

function renderProvider(children: ReactNode) {
  return render(providerTree(children));
}

let queryClient: QueryClient;

const notificationScheduler = createQueryNotificationScheduler();

beforeEach(() => {
  notificationScheduler.install();
  mocks.confirmThreadArchive = true;
  mocks.pathname = "/";
  mocks.viewedThreadId = undefined;
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  vi.mocked(sdk.threads.archiveAll).mockResolvedValue({
    archivedThreadIds: ["thr_child", "thr_parent"],
    ok: true,
  });
  vi.mocked(sdk.threads.childSummary).mockResolvedValue({
    nonDeletedChildCount: 1,
    unarchivedDescendantCount: 1,
  });
  vi.mocked(sdk.threads.unarchive).mockResolvedValue({ ok: true });
  mocks.closePanesForThreads.mockReturnValue({
    focusedRoute: null,
    removedAny: false,
  });
});

afterEach(() => {
  cleanup();
  notificationScheduler.restore();
  vi.clearAllMocks();
});

describe("ThreadActionsProvider archive confirmation", () => {
  it("archives parent and children immediately when confirmation is disabled", async () => {
    mocks.confirmThreadArchive = false;
    renderProvider(<ArchiveButton thread={makeThread()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await vi.waitFor(() => expect(appToast.success).toHaveBeenCalledTimes(1));
    expect(sdk.threads.archiveAll).toHaveBeenCalledWith({
      threadId: "thr_parent",
    });
    expect(sdk.threads.childSummary).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const undo = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undo === undefined) throw new Error("Expected archive Undo");
    render(<button onClick={undo}>Undo archive</button>);
    fireEvent.click(screen.getByRole("button", { name: "Undo archive" }));
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(2),
    );
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(1, {
      threadId: "thr_parent",
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(2, {
      threadId: "thr_child",
    });
  });

  it("keeps confirmation enabled before settings are available", async () => {
    mocks.confirmThreadArchive = undefined;
    renderProvider(<ArchiveButton thread={makeThread()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("button", { name: "Cancel" });
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
  });

  it.each(["archive", "confirmation", "error", "archive-error"] as const)(
    "optimistically removes the sidebar row during the child check and handles %s",
    async (outcome) => {
      let resolveSummary!: (summary: {
        nonDeletedChildCount: number;
        unarchivedDescendantCount: number;
      }) => void;

      let rejectSummary!: (error: Error) => void;
      vi.mocked(sdk.threads.childSummary).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveSummary = resolve;
            rejectSummary = reject;
          }),
      );

      if (outcome === "archive-error") {
        vi.mocked(sdk.threads.archiveAll).mockRejectedValueOnce(
          new Error("Archive failed"),
        );
      }

      const thread = makeThreadListEntry(makeThread());
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({
              id: thread.projectId,
              threads: [thread],
            }),
          ],
        }),
      );
      renderProvider(<ArchiveButton thread={thread} />);
      fireEvent.click(screen.getByRole("button", { name: "Archive" }));
      await vi.waitFor(() => {
        expect(sdk.threads.childSummary).toHaveBeenCalled();
        expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([]);
      });
      expect(sdk.threads.archiveAll).not.toHaveBeenCalled();

      if (outcome === "error") {
        rejectSummary(new Error("Could not check children"));
      } else {
        resolveSummary({
          nonDeletedChildCount: outcome === "confirmation" ? 1 : 0,
          unarchivedDescendantCount: outcome === "confirmation" ? 1 : 0,
        });
      }

      if (outcome === "archive") {
        await vi.waitFor(() =>
          expect(sdk.threads.archiveAll).toHaveBeenCalled(),
        );
        expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([]);
      } else {
        await vi.waitFor(() =>
          expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([
            thread,
          ]),
        );

        if (outcome === "archive-error") {
          expect(sdk.threads.archiveAll).toHaveBeenCalled();
        } else {
          expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
        }

        if (outcome === "confirmation") {
          fireEvent.click(
            await screen.findByRole("button", { name: "Cancel" }),
          );
          expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([
            thread,
          ]);
        } else {
          await vi.waitFor(() => expect(appToast.error).toHaveBeenCalled());
        }
      }
    },
  );

  it("does not restore another archived row when a delayed child check requires confirmation", async () => {
    let resolveSummary!: (summary: {
      nonDeletedChildCount: number;
      unarchivedDescendantCount: number;
    }) => void;

    vi.mocked(sdk.threads.childSummary)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSummary = resolve;
          }),
      )
      .mockResolvedValueOnce({
        nonDeletedChildCount: 0,
        unarchivedDescendantCount: 0,
      });
    const first = makeThreadListEntry(makeThread());
    const second = makeThreadListEntry(makeThread({ id: "thr_second" }));
    const untouched = makeThreadListEntry(makeThread({ id: "thr_untouched" }));
    const listKey = threadListQueryKey({ archived: false });
    queryClient.setQueryData(listKey, [first, second, untouched]);
    vi.mocked(sdk.threads.archiveAll).mockResolvedValueOnce({
      ok: true,
      archivedThreadIds: [second.id],
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            id: first.projectId,
            threads: [first, second, untouched],
          }),
        ],
      }),
    );
    renderProvider(
      <>
        <ArchiveButton thread={first} />
        <ArchiveButton thread={second} />
      </>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]!);
    await vi.waitFor(() =>
      expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([
        second,
        untouched,
      ]),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[1]!);
    await vi.waitFor(() =>
      expect(sdk.threads.archiveAll).toHaveBeenCalledWith({
        threadId: second.id,
      }),
    );
    resolveSummary({ nonDeletedChildCount: 1, unarchivedDescendantCount: 1 });
    await screen.findByRole("button", { name: "Cancel" });
    expect(getCachedSidebarNavigationThreads(queryClient)).toEqual([
      first,
      untouched,
    ]);
    expect(queryClient.getQueryData(listKey)).toEqual([first, untouched]);
  });

  it("archives without confirmation when its only child is already archived", async () => {
    vi.mocked(sdk.threads.childSummary).mockResolvedValue({
      nonDeletedChildCount: 1,
      unarchivedDescendantCount: 0,
    });
    vi.mocked(sdk.threads.archiveAll).mockResolvedValue({
      archivedThreadIds: ["thr_parent"],
      ok: true,
    });
    renderProvider(<ArchiveButton thread={makeThread()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await vi.waitFor(() => {
      expect(sdk.threads.archiveAll).toHaveBeenCalledWith({
        threadId: "thr_parent",
      });
    });
    expect(
      screen.queryByRole("heading", { name: /Archive \d+ threads\?/ }),
    ).toBeNull();
  });

  it("reports child threads and archives nothing before confirmation", async () => {
    vi.mocked(sdk.threads.childSummary).mockResolvedValue({
      nonDeletedChildCount: 6,
      unarchivedDescendantCount: 4,
    });
    renderProvider(<ArchiveButton thread={makeThread()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Its 4 child threads will be archived too.",
    );
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
  });

  it("leaves a thread unchanged when confirmation is cancelled", async () => {
    renderProvider(<ArchiveButton thread={makeThread()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("heading", { name: /Archive \d+ threads\?/ }),
    ).toBeNull();
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
  });
});

describe("ThreadActionsProvider archive feedback", () => {
  it("offers the shared Undo toast for a group and restores its parent before descendants", async () => {
    vi.mocked(sdk.environments.archiveThreads).mockResolvedValue({
      ok: true,
      archivedThreadIds: ["thr_grandchild", "thr_child", "thr_parent"],
    });
    renderProvider(<ArchiveEnvironmentButton />);
    fireEvent.click(screen.getByRole("button", { name: "Archive group" }));
    await vi.waitFor(() => expect(appToast.success).toHaveBeenCalledTimes(1));
    const call = vi.mocked(appToast.success).mock.calls[0];

    if (!call) throw new Error("Expected archive toast");
    const [title, options] = call;
    expect(title).toBe("Threads archived");
    expect(options).toMatchObject({
      undo: expect.any(Function),
      duration: 10_000,
    });
    const undo = options?.undo;

    if (!undo) throw new Error("Expected archive Undo");
    let releaseParent: () => void = () => {};

    vi.mocked(sdk.threads.unarchive).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseParent = () => resolve({ ok: true });
        }),
    );
    render(<button onClick={undo}>Undo group</button>);
    fireEvent.click(screen.getByRole("button", { name: "Undo group" }));
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(1),
    );
    expect(sdk.threads.unarchive).toHaveBeenLastCalledWith({
      threadId: "thr_parent",
    });
    releaseParent();
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(3),
    );
    expect(
      vi
        .mocked(sdk.threads.unarchive)
        .mock.calls.map(([args]) => args.threadId),
    ).toEqual(["thr_parent", "thr_child", "thr_grandchild"]);
  });

  it("shows one archive toast whose Undo restores the parent and children", async () => {
    const { parent } = seedArchiveFamily();
    renderProvider(<ArchiveButton thread={parent} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );

    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
    expect(appToast.message).not.toHaveBeenCalled();
    expect(vi.mocked(appToast.success).mock.calls[0]?.[0]).toBe(
      "Thread archived",
    );
    const toastOptions = vi.mocked(appToast.success).mock.calls[0]?.[1];
    expect(toastOptions).toMatchObject({
      undo: expect.any(Function),
      duration: 10_000,
      id: "thread-archived-thr_parent",
    });
    expect(toastOptions?.description).toBeDefined();
    expect(toastOptions?.action).toBeUndefined();

    const undoAction = toastOptions?.undo;

    if (undoAction === undefined) {
      throw new Error("Expected archive toast to provide Undo");
    }

    render(<button onClick={undoAction}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    await vi.waitFor(() => {
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(2);
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(1, {
      threadId: "thr_parent",
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(2, {
      threadId: "thr_child",
    });
  });

  it("returns to the thread when Undo reverses archive navigation", async () => {
    const thread = seedArchiveFamily().parent;
    mocks.pathname = `/projects/${thread.projectId}/threads/${thread.id}`;
    mocks.viewedThreadId = thread.id;
    const view = renderProvider(<ArchiveButton thread={thread} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );

    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/");
    await flushSettledRequests();
    mocks.navigate.mockClear();
    mocks.pathname = "/";
    mocks.viewedThreadId = undefined;
    view.rerender(providerTree(<ArchiveButton thread={thread} />));

    const undoAction = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undoAction === undefined) {
      throw new Error("Expected archive toast to provide Undo");
    }

    render(<button onClick={undoAction}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    expect(mocks.navigate).toHaveBeenLastCalledWith(
      `/projects/${thread.projectId}/threads/${thread.id}`,
    );
  });

  it("does not return to the thread when the user navigated after archiving", async () => {
    const thread = seedArchiveFamily().parent;
    mocks.pathname = `/projects/${thread.projectId}/threads/${thread.id}`;
    mocks.viewedThreadId = thread.id;
    const view = renderProvider(<ArchiveButton thread={thread} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );

    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
    await flushSettledRequests();
    mocks.navigate.mockClear();
    mocks.pathname = "/settings";
    mocks.viewedThreadId = undefined;
    view.rerender(providerTree(<ArchiveButton thread={thread} />));

    const undoAction = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undoAction === undefined) {
      throw new Error("Expected archive toast to provide Undo");
    }

    render(<button onClick={undoAction}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe("ThreadActionsProvider instant archive feedback", () => {
  it("opens the confirmation from the cached family without touching the chat", () => {
    const { parent, child } = seedArchiveFamily();
    mocks.pathname = `/projects/${parent.projectId}/threads/${parent.id}`;
    mocks.viewedThreadId = parent.id;
    renderProvider(<ArchiveButton thread={parent} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "Its 1 child thread will be archived too.",
    );
    expect(sdk.threads.childSummary).not.toHaveBeenCalled();
    expect(sdk.threads.archiveAll).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(sidebarIds()).toEqual([parent.id, child.id]);
  });

  it("restores the archived chat immediately while Undo waits to send its request", async () => {
    mocks.confirmThreadArchive = false;
    const thread = makeThreadListEntry(makeThread());
    seedSidebar([thread]);
    let resolveArchive!: () => void;
    vi.mocked(sdk.threads.archiveAll).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = () =>
            resolve({ ok: true, archivedThreadIds: [thread.id] });
        }),
    );
    renderProvider(<ArchiveButton thread={thread} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Archive" })),
    );
    await vi.waitFor(() => expect(sdk.threads.archiveAll).toHaveBeenCalled());
    expect(appToast.success).toHaveBeenCalledWith(
      "Thread archived",
      expect.objectContaining({ id: `thread-archived-${thread.id}` }),
    );
    expect(dispatchCommand("edit.undo")).toBe(true);
    await flushSettledRequests();
    expect(sdk.threads.unarchive).not.toHaveBeenCalled();
    expect(sidebarIds()).toEqual([thread.id]);

    await act(async () => resolveArchive());
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledWith({
        threadId: thread.id,
      }),
    );
    expect(sidebarIds()).toEqual([thread.id]);
  });

  it("withdraws the toast and history entry when the archive fails", async () => {
    mocks.confirmThreadArchive = false;
    const thread = makeThreadListEntry(makeThread());
    seedSidebar([thread]);
    vi.mocked(sdk.threads.archiveAll).mockRejectedValueOnce(
      new Error("Archive failed"),
    );
    renderProvider(<ArchiveButton thread={thread} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Archive" })),
    );
    await vi.waitFor(() => expect(appToast.error).toHaveBeenCalled());

    expect(appToast.success).toHaveBeenCalledTimes(1);
    expect(appToast.dismiss).toHaveBeenCalledWith(
      `thread-archived-${thread.id}`,
    );
    expect(dispatchCommand("edit.undo")).toBe(false);
    expect(sidebarIds()).toEqual([thread.id]);
  });

  it("restores the whole family before the first unarchive request returns", async () => {
    mocks.confirmThreadArchive = false;
    const { parent, child } = seedArchiveFamily();
    vi.mocked(sdk.threads.archiveAll).mockResolvedValueOnce({
      ok: true,
      archivedThreadIds: [child.id, parent.id],
    });
    renderProvider(<ArchiveButton thread={parent} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Archive" })),
    );
    await flushSettledRequests();
    expect(sidebarIds()).toEqual([]);
    let releaseParent!: () => void;
    vi.mocked(sdk.threads.unarchive).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseParent = () => resolve({ ok: true });
        }),
    );

    expect(dispatchCommand("edit.undo")).toBe(true);
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(1),
    );
    expect(sdk.threads.unarchive).toHaveBeenCalledWith({
      threadId: parent.id,
    });
    expect(sidebarIds()).toEqual([parent.id, child.id]);

    await act(async () => releaseParent());
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenLastCalledWith({
        threadId: child.id,
      }),
    );
  });

  it("leaves the environment's open chat and offers Undo before the server answers", async () => {
    const { parent, child } = seedArchiveFamily();
    const originalRoute = `/projects/${parent.projectId}/threads/${parent.id}`;
    mocks.pathname = originalRoute;
    mocks.viewedThreadId = parent.id;
    let resolveArchive!: () => void;
    vi.mocked(sdk.environments.archiveThreads).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = () =>
            resolve({ ok: true, archivedThreadIds: [child.id, parent.id] });
        }),
    );
    const view = renderProvider(<ArchiveEnvironmentButton />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Archive group" })),
    );
    expect(mocks.closePanesForThreads).toHaveBeenCalledWith([
      parent.id,
      child.id,
    ]);
    expect(mocks.navigate).toHaveBeenCalledWith("/");
    expect(appToast.success).toHaveBeenCalledWith(
      "Threads archived",
      expect.objectContaining({ id: "environment-archived-env_test" }),
    );
    expect(sidebarIds()).toEqual([]);

    await act(async () => resolveArchive());
    await flushSettledRequests();
    mocks.pathname = "/";
    mocks.viewedThreadId = undefined;
    view.rerender(providerTree(<ArchiveEnvironmentButton />));
    let releaseParent!: () => void;
    vi.mocked(sdk.threads.unarchive).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseParent = () => resolve({ ok: true });
        }),
    );
    const undo = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undo === undefined) throw new Error("Expected environment Undo");
    act(() => undo());

    expect(mocks.navigate).toHaveBeenLastCalledWith(originalRoute);
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(1),
    );
    expect(sidebarIds()).toEqual([parent.id, child.id]);
    await act(async () => releaseParent());
    await vi.waitFor(() =>
      expect(sdk.threads.unarchive).toHaveBeenLastCalledWith({
        threadId: child.id,
      }),
    );
  });
});

describe("ThreadActionsProvider delete and rename dialogs", () => {
  it("opens the delete dialog from the cache, refines it and leaves the chat on confirm", async () => {
    const { parent } = seedArchiveFamily();
    const originalRoute = `/projects/${parent.projectId}/threads/${parent.id}`;
    mocks.pathname = originalRoute;
    mocks.viewedThreadId = parent.id;
    let resolveSummary!: () => void;
    vi.mocked(sdk.threads.childSummary).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSummary = () =>
            resolve({ nonDeletedChildCount: 3, unarchivedDescendantCount: 3 });
        }),
    );
    renderProvider(<DeleteButton thread={parent} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.deleteDialog?.target).toEqual({
      thread: parent,
      childThreadCount: 1,
      childSummaryLoaded: false,
    });

    await act(async () => resolveSummary());
    const target = mocks.deleteDialog?.target;
    expect(target).toEqual({
      thread: parent,
      childThreadCount: 3,
      childSummaryLoaded: true,
    });

    if (!target) throw new Error("Expected a delete target");
    let rejectDelete!: () => void;
    mocks.mutation.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelete = () => reject(new Error("Delete failed"));
        }),
    );
    act(() => mocks.deleteDialog?.onDelete(target));
    expect(mocks.deleteDialog?.target).toBeNull();
    const [request] = mocks.mutation.mock.calls.at(-1) ?? [];
    expect(request).toMatchObject({
      id: parent.id,
      childThreadsConfirmed: true,
    });
    expect(mocks.navigate).not.toHaveBeenCalled();

    act(() => request.onOptimistic());
    expect(mocks.navigate).toHaveBeenCalledWith("/");

    await act(async () => rejectDelete());
    expect(mocks.navigate).toHaveBeenLastCalledWith(originalRoute);
  });

  it("closes the rename dialog as soon as the rename is sent", async () => {
    const thread = makeThreadListEntry(makeThread());
    seedSidebar([thread]);
    let rejectRename!: () => void;
    mocks.mutation.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRename = () => reject(new Error("Rename failed"));
        }),
    );
    renderProvider(<RenameButton thread={thread} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(mocks.renameDialog?.target?.id).toBe(thread.id);

    act(() => mocks.renameDialog?.onRename(thread.id, { title: "Renamed" }));
    expect(mocks.renameDialog?.target).toBeNull();
    expect(mocks.mutation).toHaveBeenCalledWith({
      id: thread.id,
      title: "Renamed",
    });

    await act(async () => rejectRename());
    expect(dispatchCommand("edit.undo")).toBe(false);
  });
});

describe("ThreadActionsProvider instant archive navigation", () => {
  it.each(["success", "failure", "navigated"] as const)(
    "leaves the current chat before the server responds and handles %s",
    async (outcome) => {
      mocks.confirmThreadArchive = false;
      const thread = makeThreadListEntry(makeThread());
      const next = makeThreadListEntry(makeThread({ id: "thr_next" }));

      const other = makeThreadListEntry(
        makeThread({ id: "thr_other", projectId: "other" }),
      );

      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({
              id: thread.projectId,
              threads: [thread, next],
            }),
            makeProjectWithThreadsResponse({
              id: other.projectId,
              threads: [other],
            }),
          ],
        }),
      );
      const originalRoute = `/projects/${thread.projectId}/threads/${thread.id}`;
      const destination = `/projects/${next.projectId}/threads/${next.id}`;
      mocks.pathname = originalRoute;
      mocks.viewedThreadId = thread.id;
      let resolveArchive!: () => void;
      let rejectArchive!: () => void;
      vi.mocked(sdk.threads.archiveAll).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveArchive = () =>
              resolve({ ok: true, archivedThreadIds: [thread.id] });
            rejectArchive = () => reject(new Error("Archive failed"));
          }),
      );
      const view = renderProvider(<ArchiveButton thread={thread} />);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Archive" })),
      );
      expect(mocks.navigate).toHaveBeenCalledWith(destination);
      await vi.waitFor(() => expect(sdk.threads.archiveAll).toHaveBeenCalled());
      expect(
        getCachedSidebarNavigationThreads(queryClient).map((t) => t.id),
      ).toEqual([next.id, other.id]);
      mocks.pathname = outcome === "navigated" ? "/settings" : destination;
      mocks.viewedThreadId = outcome === "navigated" ? undefined : next.id;
      view.rerender(providerTree(<ArchiveButton thread={thread} />));
      await act(async () => {
        if (outcome === "success") resolveArchive();
        else rejectArchive();
      });

      if (outcome === "failure") {
        expect(mocks.navigate).toHaveBeenLastCalledWith(originalRoute);
        expect(
          getCachedSidebarNavigationThreads(queryClient).map((t) => t.id),
        ).toContain(thread.id);
      } else expect(mocks.navigate).toHaveBeenCalledTimes(1);
    },
  );
});

describe("ThreadActionsProvider archive destination", () => {
  it.each(["next", "previous", "empty", "descendant"] as const)(
    "uses the project list order for %s",
    async (scenario) => {
      mocks.confirmThreadArchive = false;
      const thread = makeThreadListEntry(makeThread());
      const previous = makeThreadListEntry(makeThread({ id: "previous" }));
      const next = makeThreadListEntry(makeThread({ id: "next" }));

      const child = makeThreadListEntry(
        makeThread({ id: "child", parentThreadId: thread.id }),
      );

      const other = makeThreadListEntry(
        makeThread({ id: "other", projectId: "other-project" }),
      );

      const sameProject =
        scenario === "empty"
          ? [thread, child]
          : [next, previous, thread, child];

      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({
              id: other.projectId,
              threads: [other],
            }),
            makeProjectWithThreadsResponse({
              id: thread.projectId,
              threads: sameProject,
            }),
          ],
        }),
      );
      mocks.viewedThreadId = scenario === "descendant" ? child.id : thread.id;
      mocks.pathname = `/projects/${thread.projectId}/threads/${mocks.viewedThreadId}`;

      const displayed =
        scenario === "previous"
          ? [previous, thread, child, other]
          : [previous, thread, child, other, next];

      const view = renderProvider(
        <>
          <nav>
            {displayed.map((t) => (
              <a
                key={t.id}
                ref={(element) => {
                  if (element) element.checkVisibility = () => true;
                }}
                data-sidebar-thread-shortcut-target=""
                data-sidebar-thread-id={t.id}
                href={`/projects/${t.projectId}/threads/${t.id}`}
              >
                {t.id}
              </a>
            ))}
          </nav>
          <ArchiveButton thread={thread} />
        </>,
      );

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Archive" })),
      );
      expect(mocks.navigate).toHaveBeenCalledWith(
        scenario === "empty"
          ? "/"
          : `/projects/${thread.projectId}/threads/${scenario === "previous" ? previous.id : next.id}`,
      );
      await vi.waitFor(() => expect(appToast.success).toHaveBeenCalled());
      view.unmount();
    },
  );
});

describe("ThreadActionsProvider shelve", () => {
  function seedFamily() {
    const thread = makeThreadListEntry(makeThread());

    const child = makeThreadListEntry(
      makeThread({ id: "thr_child", parentThreadId: thread.id }),
    );

    const next = makeThreadListEntry(makeThread({ id: "thr_next" }));
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            id: thread.projectId,
            threads: [thread, child, next],
          }),
        ],
      }),
    );
    mocks.pathname = `/projects/${thread.projectId}/threads/${thread.id}`;
    mocks.viewedThreadId = thread.id;

    return {
      thread,
      child,
      originalRoute: mocks.pathname,
      destination: `/projects/${next.projectId}/threads/${next.id}`,
      nextId: next.id,
    };
  }

  const shelvedIds = () =>
    getCachedSidebarNavigationThreads(queryClient)
      .filter((thread) => thread.shelvedAt !== null)
      .map((thread) => thread.id);

  it.each(["success", "failure"] as const)(
    "leaves the open chat before the server answers and handles %s",
    async (outcome) => {
      const { thread, child, originalRoute, destination } = seedFamily();
      let settle!: () => void;
      vi.mocked(sdk.threads.shelve).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === "success"
                ? resolve({ ...makeThreadResponse(thread), shelvedAt: 5 })
                : reject(new Error("Shelve failed"));
          }),
      );
      renderProvider(<ShelveButton thread={thread} />);

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Shelve" })),
      );
      expect(mocks.navigate).toHaveBeenCalledWith(destination);
      expect(shelvedIds()).toEqual([thread.id, child.id]);
      expect(sdk.threads.shelve).toHaveBeenCalledWith({ threadId: thread.id });
      expect(appToast.success).toHaveBeenCalledWith(
        "Shelved",
        expect.objectContaining({
          undo: expect.any(Function),
          id: `thread-shelved-${thread.id}`,
        }),
      );

      await act(async () => settle());

      if (outcome === "success") {
        expect(mocks.navigate).toHaveBeenCalledTimes(1);
        expect(appToast.dismiss).not.toHaveBeenCalled();
      } else {
        expect(mocks.navigate).toHaveBeenLastCalledWith(originalRoute);
        expect(shelvedIds()).toEqual([]);
        expect(appToast.dismiss).toHaveBeenCalledWith(
          `thread-shelved-${thread.id}`,
        );
        expect(appToast.error).toHaveBeenCalled();
        expect(dispatchCommand("edit.undo")).toBe(false);
      }
    },
  );

  it("unshelves immediately while Undo waits to send its request", async () => {
    const { thread } = seedFamily();
    let resolveShelve!: () => void;
    vi.mocked(sdk.threads.shelve).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveShelve = () =>
            resolve({ ...makeThreadResponse(thread), shelvedAt: 5 });
        }),
    );
    vi.mocked(sdk.threads.unshelve).mockResolvedValue(
      makeThreadResponse(thread),
    );
    renderProvider(<ShelveButton thread={thread} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Shelve" })),
    );
    expect(dispatchCommand("edit.undo")).toBe(true);
    await flushSettledRequests();
    expect(sdk.threads.unshelve).not.toHaveBeenCalled();
    expect(sidebarIds()).toContain(thread.id);

    await act(async () => resolveShelve());
    await vi.waitFor(() =>
      expect(sdk.threads.unshelve).toHaveBeenCalledWith({
        threadId: thread.id,
      }),
    );
  });

  it("unshelves the family and returns to the previous route on Undo", async () => {
    const { thread, originalRoute, destination, nextId } = seedFamily();
    vi.mocked(sdk.threads.shelve).mockResolvedValue({
      ...makeThreadResponse(thread),
      shelvedAt: 5,
    });
    vi.mocked(sdk.threads.unshelve).mockResolvedValue(
      makeThreadResponse(thread),
    );
    const view = renderProvider(<ShelveButton thread={thread} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Shelve" })),
    );
    await vi.waitFor(() => expect(appToast.success).toHaveBeenCalledTimes(1));
    await flushSettledRequests();
    mocks.pathname = destination;
    mocks.viewedThreadId = nextId;
    view.rerender(providerTree(<ShelveButton thread={thread} />));

    const undo = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undo === undefined) throw new Error("Expected shelve toast Undo");
    render(<button onClick={undo}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    expect(mocks.navigate).toHaveBeenLastCalledWith(originalRoute);
    await vi.waitFor(() =>
      expect(sdk.threads.unshelve).toHaveBeenCalledWith({
        threadId: thread.id,
      }),
    );
  });

  function mockShelveRoundTrip(thread: Thread) {
    vi.mocked(sdk.threads.shelve).mockResolvedValue({
      ...makeThreadResponse(thread),
      shelvedAt: 5,
    });
    vi.mocked(sdk.threads.unshelve).mockResolvedValue(
      makeThreadResponse(thread),
    );
  }

  it("undoes and redoes a shelve with the edit commands", async () => {
    const { thread } = seedFamily();
    mockShelveRoundTrip(thread);
    renderProvider(<ShelveButton thread={thread} />);

    expect(dispatchCommand("edit.undo")).toBe(false);
    expect(dispatchCommand("edit.redo")).toBe(false);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Shelve" })),
    );
    await vi.waitFor(() => expect(appToast.success).toHaveBeenCalledTimes(1));

    expect(dispatchCommand("edit.undo")).toBe(true);
    await vi.waitFor(() =>
      expect(appToast.success).toHaveBeenLastCalledWith(
        "Undid: Shelve “Investigate archive behavior”",
        expect.anything(),
      ),
    );
    expect(sdk.threads.unshelve).toHaveBeenCalledWith({ threadId: thread.id });
    expect(dispatchCommand("edit.undo")).toBe(false);

    expect(dispatchCommand("edit.redo")).toBe(true);
    await vi.waitFor(() =>
      expect(appToast.success).toHaveBeenLastCalledWith(
        "Redid: Shelve “Investigate archive behavior”",
        expect.anything(),
      ),
    );
    expect(sdk.threads.shelve).toHaveBeenCalledTimes(2);
    expect(sdk.threads.shelve).toHaveBeenLastCalledWith({
      threadId: thread.id,
    });
    expect(dispatchCommand("edit.redo")).toBe(false);
    expect(dispatchCommand("edit.undo")).toBe(true);
    await vi.waitFor(() =>
      expect(sdk.threads.unshelve).toHaveBeenCalledTimes(2),
    );
  });

  it("lets the edit redo command repeat a shelve undone from its toast", async () => {
    const { thread } = seedFamily();
    mockShelveRoundTrip(thread);
    renderProvider(<ShelveButton thread={thread} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Shelve" })),
    );
    await vi.waitFor(() => expect(appToast.success).toHaveBeenCalledTimes(1));
    const undo = vi.mocked(appToast.success).mock.calls[0]?.[1]?.undo;

    if (undo === undefined) throw new Error("Expected shelve toast Undo");
    render(<button onClick={undo}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));
    await vi.waitFor(() =>
      expect(sdk.threads.unshelve).toHaveBeenCalledWith({
        threadId: thread.id,
      }),
    );

    await vi.waitFor(() => expect(dispatchCommand("edit.undo")).toBe(false));
    expect(dispatchCommand("edit.redo")).toBe(true);
    await vi.waitFor(() => expect(sdk.threads.shelve).toHaveBeenCalledTimes(2));
  });
});
