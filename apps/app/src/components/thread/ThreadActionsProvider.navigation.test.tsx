// @vitest-environment jsdom

import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import { memo, Suspense, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  makeThread,
  makeThreadListEntry,
} from "@omnyo/test-helpers/domain-fixtures";
import { threadListQueryKey } from "@/hooks/queries/query-keys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RouteNavigationProvider,
  useRouteNavigate,
} from "@/components/ui/app-route-anchor";
import { ThreadActionsProvider } from "./ThreadActionsProvider";
import {
  useThreadActions,
  type ThreadActionsContextValue,
} from "@/lib/thread-actions/thread-actions-context";

const archiveCallback = vi.hoisted(() => ({
  defer: false,
  run: null as (() => void) | null,
}));

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const mutationResult = {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(
      (request: {
        onOptimistic?: (archivedThreadIds: readonly string[]) => void;
      }) => {
        const leave = () => request.onOptimistic?.([]);

        if (archiveCallback.defer) archiveCallback.run = leave;
        else leave();

        return new Promise(() => {});
      },
    ),
  };

  const mutation = () => mutationResult;

  return {
    useArchiveThreadAndChildren: mutation,
    useDeleteThread: mutation,
    useMarkThreadRead: mutation,
    useMarkThreadUnread: mutation,
    usePinThread: mutation,
    useUnarchiveThread: mutation,
    useUnpinThread: mutation,
    useUpdateThread: mutation,
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { generalSettings: { confirmThreadArchive: false } },
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { archiveAll: vi.fn(), childSummary: vi.fn() } },
}));

afterEach(() => {
  cleanup();
  archiveCallback.defer = false;
  archiveCallback.run = null;
});

const consumerRenders: ThreadActionsContextValue[] = [];

const ActionsConsumer = memo(function ActionsConsumer() {
  consumerRenders.push(useThreadActions());

  return null;
});

const routeNavigateIdentities: ReturnType<typeof useRouteNavigate>[] = [];

const RouteNavigateConsumer = memo(function RouteNavigateConsumer() {
  routeNavigateIdentities.push(useRouteNavigate());

  return null;
});

function NavigationProbe() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <>
      <output data-testid="pathname">{location.pathname}</output>
      <button type="button" onClick={() => navigate("/projects/p1/threads/t2")}>
        go to t2
      </button>
    </>
  );
}

function navigateToT2(): void {
  fireEvent.click(screen.getByRole("button", { name: "go to t2" }));
}

function renderTree(children: ReactNode) {
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        useTransitions={false}
        initialEntries={["/projects/p1/threads/t1"]}
      >
        <RouteNavigationProvider>
          <NavigationProbe />
          {children}
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ThreadActionsProvider across navigations", () => {
  it("keeps the context value and memoized consumers stable when the route changes", () => {
    consumerRenders.length = 0;
    renderTree(
      <ActionHistoryProvider>
        <ThreadActionsProvider>
          <ActionsConsumer />
        </ThreadActionsProvider>
      </ActionHistoryProvider>,
    );
    expect(consumerRenders).toHaveLength(1);

    navigateToT2();
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t2",
    );
    expect(consumerRenders).toHaveLength(1);
  });
});

describe("useRouteNavigate", () => {
  it("does not re-render its caller on navigation and navigates with options", () => {
    routeNavigateIdentities.length = 0;
    renderTree(<RouteNavigateConsumer />);
    expect(routeNavigateIdentities).toHaveLength(1);

    navigateToT2();
    expect(routeNavigateIdentities).toHaveLength(1);

    const navigate = routeNavigateIdentities[0];
    act(() => {
      navigate?.("/projects/p1/threads/t3", {
        replace: true,
        state: { focusPrompt: true },
      });
    });
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/projects/p1/threads/t3",
    );
  });
});

it("leaves the archived chat immediately when the destination suspends", () => {
  const thread = makeThread({ id: "t1", projectId: "p1" });
  const next = makeThreadListEntry(makeThread({ id: "t2", projectId: "p1" }));
  const client = new QueryClient();
  client.setQueryData(threadListQueryKey({ archived: false }), [next]);
  const pending = new Promise(() => {});

  function Destination() {
    const location = useLocation();

    if (location.pathname.endsWith("t2")) throw pending;

    return <output>Archived chat content</output>;
  }

  function Archive() {
    const actions = useThreadActions();

    return (
      <button onClick={() => actions.requestArchive(thread)}>
        Archive current chat
      </button>
    );
  }

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        useTransitions={false}
        initialEntries={["/projects/p1/threads/t1"]}
      >
        <RouteNavigationProvider>
          <ActionHistoryProvider>
            <ThreadActionsProvider>
              <Archive />
              <Suspense fallback={<output>Loading next chat</output>}>
                <Destination />
              </Suspense>
            </ThreadActionsProvider>
          </ActionHistoryProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Archive current chat" }));
  expect(
    getComputedStyle(screen.getByText("Archived chat content")).display,
  ).toBe("none");
  expect(screen.getByText("Loading next chat")).toBeDefined();
});

it("commits the destination within the asynchronous optimistic callback", async () => {
  archiveCallback.defer = true;
  const thread = makeThread({ id: "t1", projectId: "p1" });
  const client = new QueryClient();
  client.setQueryData(threadListQueryKey({ archived: false }), [
    makeThreadListEntry(makeThread({ id: "t2", projectId: "p1" })),
  ]);

  function Content() {
    const location = useLocation();
    const actions = useThreadActions();

    return (
      <>
        <output>
          {location.pathname.endsWith("t2")
            ? "Next chat content"
            : "Old chat content"}
        </output>
        <button onClick={() => actions.requestArchive(thread)}>
          Archive asynchronously
        </button>
      </>
    );
  }

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        useTransitions={false}
        initialEntries={["/projects/p1/threads/t1"]}
      >
        <RouteNavigationProvider>
          <ActionHistoryProvider>
            <ThreadActionsProvider>
              <Content />
            </ThreadActionsProvider>
          </ActionHistoryProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Archive asynchronously" }),
  );
  expect(archiveCallback.run).not.toBeNull();
  await act(async () => {
    await Promise.resolve();
    archiveCallback.run?.();
    expect(screen.queryByText("Old chat content")).toBeNull();
    expect(screen.getByText("Next chat content")).toBeDefined();
  });
});

it("archives the current Inbox chat and opens the next visible row across projects", () => {
  consumerRenders.length = 0;
  const current = makeThread({ id: "t1", projectId: "p1" });
  const next = makeThread({ id: "cross-project", projectId: "p2" });
  const sameProject = makeThread({ id: "same-project", projectId: "p1" });
  const client = new QueryClient();
  client.setQueryData(
    threadListQueryKey({ archived: false }),
    [current, sameProject, next].map((thread) => makeThreadListEntry(thread)),
  );

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        useTransitions={false}
        initialEntries={["/projects/p1/threads/t1"]}
      >
        <RouteNavigationProvider>
          <ActionHistoryProvider>
            <ThreadActionsProvider>
              <NavigationProbe />
              <ActionsConsumer />
              <div
                data-inbox=""
                ref={(element) => {
                  if (element) element.checkVisibility = () => true;
                }}
              >
                {[current, next, sameProject].map((thread) => (
                  <a
                    key={thread.id}
                    href={`/projects/${thread.projectId}/threads/${thread.id}`}
                    data-sidebar-thread-id={thread.id}
                    data-sidebar-thread-shortcut-target=""
                    ref={(element) => {
                      if (element) element.checkVisibility = () => true;
                    }}
                  />
                ))}
              </div>
            </ThreadActionsProvider>
          </ActionHistoryProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  act(() => consumerRenders[0]?.requestArchive(current));
  expect(screen.getByTestId("pathname").textContent).toBe(
    "/projects/p2/threads/cross-project",
  );
});
