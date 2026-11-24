// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { useLayoutEffect } from "react";
import {
  act,
  cleanup,
  render,
  renderHook as renderHookBase,
} from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import {
  PERSONAL_PROJECT_ID,
  type Host,
  type ThreadListEntry,
} from "@omnyo/domain";
import type { PluginSidebarThreadsState } from "@omnyo/plugin-sdk";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeHost,
  makeThreadListEntry,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  useSidebarThreadActions,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  useSidebarThreads,
  useSidebarThreadEntry,
} from "./plugin-sidebar-hooks";
import {
  clearPluginThreadRowStatuses,
  setPluginThreadRowStatus,
} from "./plugin-thread-row-status";
import {
  clearPluginThreadRowSubtitles,
  setPluginThreadRowSubtitle,
} from "./plugin-thread-row-subtitle";
import { useEnvironmentProviders } from "./plugin-sdk-hooks";
import { SidebarThreadShortcutKeysContext } from "@/components/sidebar/sidebarThreadShortcuts";
import {
  ThreadTitleMentionResourcesProvider,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { SidebarThreadEntriesTestProvider } from "@/test/sidebarThreadEntriesTestProvider";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createPendingChat } from "./pending-chat-creations";

const renderHook: typeof renderHookBase = (callback, options) =>
  renderHookBase(callback, {
    wrapper: SidebarThreadEntriesTestProvider,
    ...options,
  });

const actions = vi.hoisted(() => ({
  navigate: vi.fn(),
  setRootComposeProjectId: vi.fn(),
}));

const mutations = vi.hoisted(() => ({
  pinThreadAsync: vi.fn(),
  unpinThreadAsync: vi.fn(),
  updateThreadAsync: vi.fn(),
}));

type SidebarSection = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        sections: SidebarSection[];
        projects: { id: string; name: string; threads: ThreadListEntry[] }[];
        personalProject: {
          id: string;
          name: string;
          threads: ThreadListEntry[];
        };
      }
    | undefined,
}));

const archiveQuery = vi.hoisted(() => ({
  data: undefined as { pages: ThreadListEntry[][] } | undefined,
  isLoadingError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: vi.fn(async () => undefined),
}));

const archiveEnabled = vi.hoisted(() => vi.fn());

const shelfQuery = vi.hoisted(() => ({
  data: undefined as { pages: ThreadListEntry[][] } | undefined,
  isLoadingError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: vi.fn(async () => undefined),
}));

const shelfEnabled = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: (_filters: object, options: { enabled: boolean }) => {
    archiveEnabled(options.enabled);

    return archiveQuery;
  },
  useShelvedThreads: (options: { enabled: boolean }) => {
    shelfEnabled(options.enabled);

    return shelfQuery;
  },
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useImmediateSidebarNavigation: () => ({ data: state.data, isError: false }),
  useSidebarNavigation: () => ({ data: state.data, isError: false }),
}));

const hostQuery = vi.hoisted(() => {
  const data: Host[] = [];

  return { data };
});

vi.mock("@/hooks/queries/host-queries", () => {
  return { useHosts: () => hostQuery };
});

vi.mock("@/lib/thread-actions/thread-actions-context", () => ({
  useThreadActions: () => ({
    requestArchive: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  usePinThread: () => ({ mutateAsync: mutations.pinThreadAsync }),
  useUnpinThread: () => ({ mutateAsync: mutations.unpinThreadAsync }),
  useUpdateThread: () => ({ mutateAsync: mutations.updateThreadAsync }),
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => actions.navigate,
}));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("./root-compose-selection", () => ({
  useSetRootComposeProjectId: () => actions.setRootComposeProjectId,
}));

const environmentProviders = vi.hoisted(() => ({
  providers: undefined as readonly Record<string, unknown>[] | undefined,
}));

vi.mock("@/hooks/queries/environment-provider-queries", () => ({
  useSystemEnvironmentProviders: () => ({
    providers: environmentProviders.providers,
  }),
}));

const drafts = vi.hoisted(() => ({
  threadIds: new Set<string>(),
  listeners: new Set<() => void>(),
  notify() {
    for (const listener of drafts.listeners) listener();
  },
}));

vi.mock("@/hooks/usePromptDraftStorage", async () => {
  const { useSyncExternalStore } = await import("react");

  const subscribe = (listener: () => void) => {
    drafts.listeners.add(listener);

    return () => drafts.listeners.delete(listener);
  };

  return {
    usePromptDraftHasInput: (scope: { threadId: string }) =>
      useSyncExternalStore(subscribe, () =>
        drafts.threadIds.has(scope.threadId),
      ),
    usePromptDraftInputThreadIds: (threads: readonly { id: string }[]) => {
      const snapshot = useSyncExternalStore(subscribe, () =>
        threads
          .map((thread) => (drafts.threadIds.has(thread.id) ? "1" : "0"))
          .join(""),
      );

      return new Set(
        threads.filter((_, index) => snapshot[index] === "1").map((t) => t.id),
      );
    },
  };
});

function payload(threads: ThreadListEntry[], sections: SidebarSection[] = []) {
  return {
    sections,
    projects: [{ id: "proj_app", name: "App", threads }],
    personalProject: { id: PERSONAL_PROJECT_ID, name: "Personal", threads: [] },
  };
}

function SidebarMeasurementConsumer({
  index,
  onState,
}: {
  index: number;
  onState(index: number, sidebar: PluginSidebarThreadsState): void;
}) {
  const sidebar = useSidebarThreads();
  useLayoutEffect(() => {
    onState(index, sidebar);
  }, [index, onState, sidebar]);

  return (
    <div data-sidebar-measurement={index}>
      <span>{sidebar.threads.length}</span>
      <span>{sidebar.threads[0]?.displayTitle}</span>
      <span>{sidebar.threads.at(-1)?.displayTitle}</span>
      {sidebar.projects.map((project) => (
        <a key={project.id} href={project.href}>
          {project.name}
        </a>
      ))}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.data = undefined;
  archiveQuery.data = undefined;
  archiveQuery.isLoadingError = false;
  archiveQuery.hasNextPage = false;
  archiveQuery.isFetchingNextPage = false;
  archiveQuery.isFetchNextPageError = false;
  archiveQuery.fetchNextPage = vi.fn(async () => undefined);
  shelfQuery.data = undefined;
  shelfQuery.isLoadingError = false;
  shelfQuery.hasNextPage = false;
  shelfQuery.isFetchingNextPage = false;
  shelfQuery.isFetchNextPageError = false;
  shelfQuery.fetchNextPage = vi.fn(async () => undefined);
  hostQuery.data = [];
  drafts.threadIds.clear();
  clearPluginThreadRowStatuses("plugin-a");
  clearPluginThreadRowSubtitles("glance");
  environmentProviders.providers = undefined;
});

describe("useSidebarThreads", () => {
  it("reactively projects subtitles while preserving unchanged thread identities", () => {
    state.data = payload([
      makeThreadListEntry({ id: "thr_one" }),
      makeThreadListEntry({ id: "thr_two" }),
    ]);
    const { result } = renderHook(() => useSidebarThreads());
    const before = result.current.threads;
    expect(before[0]?.experimental_subtitle).toBeNull();
    act(() =>
      setPluginThreadRowSubtitle("thr_one", "glance", { text: "Working" }),
    );
    expect(result.current.threads[0]?.experimental_subtitle).toBe("Working");
    expect(result.current.threads[1]).toBe(before[1]);
    act(() => clearPluginThreadRowSubtitles("glance"));
    expect(result.current.threads[0]?.experimental_subtitle).toBeNull();
  });

  it("keeps DTO identity for entries that did not change across a sidebar update", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    const changing = makeThreadListEntry({ id: "thr_changing", title: "One" });
    state.data = payload([stable, changing]);
    const { result, rerender } = renderHook(() => useSidebarThreads());
    const before = result.current.threads;
    expect(before.map((thread) => thread.id)).toEqual([
      "thr_stable",
      "thr_changing",
    ]);

    state.data = payload([
      stable,
      makeThreadListEntry({ id: "thr_changing", title: "Two" }),
    ]);
    rerender();
    const after = result.current.threads;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.title).toBe("Two");
  });

  it("shares readonly projections between consumers with separate state wrappers", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    state.data = payload([stable]);
    const first = renderHook(() => useSidebarThreads());
    const second = renderHook(() => useSidebarThreads());
    expect(second.result.current).not.toBe(first.result.current);
    expect(second.result.current.threads).toBe(first.result.current.threads);
    expect(second.result.current.projects).toBe(first.result.current.projects);
    expect(second.result.current.sections).toBe(first.result.current.sections);
    expect(second.result.current.threads[0]).toBe(
      first.result.current.threads[0],
    );
    const before = first.result.current.threads[0];
    first.rerender();
    second.rerender();
    expect(first.result.current.threads[0]).toBe(before);
    expect(second.result.current.threads[0]).toBe(before);
  });

  it("refreshes shared display content when host names or title resources change", () => {
    state.data = payload([
      makeThreadListEntry({
        id: "thr_mentions",
        title: "Review @section:sec_later in @project:proj_app",
        environmentHostId: "host_1",
      }),
    ]);
    hostQuery.data = [makeHost({ id: "host_1", name: "Old host" })];

    let resources: ThreadTitleMentionResources = {
      sectionNamesById: new Map([["sec_later", "Later"]]),
      projectNamesById: new Map([["proj_app", "App"]]),
      threadById: new Map(),
    };

    const { result, rerender } = renderHook(
      () => ({ first: useSidebarThreads(), second: useSidebarThreads() }),
      {
        wrapper: ({ children }) => (
          <ThreadTitleMentionResourcesProvider {...resources}>
            {children}
          </ThreadTitleMentionResourcesProvider>
        ),
      },
    );

    const initial = result.current.first.threads[0];
    expect(initial?.host?.name).toBe("Old host");
    expect(initial?.displayTitle).toBe("Review Later in App");

    hostQuery.data = [makeHost({ id: "host_1", name: "New host" })];
    rerender();
    const renamed = result.current.first.threads[0];
    expect(renamed).not.toBe(initial);
    expect(renamed?.host?.name).toBe("New host");
    expect(result.current.second.threads).toBe(result.current.first.threads);

    resources = {
      ...resources,
      sectionNamesById: new Map([["sec_later", "Next"]]),
      projectNamesById: new Map([["proj_app", "Renamed app"]]),
    };
    rerender();
    expect(result.current.first.threads[0]).not.toBe(renamed);
    expect(result.current.first.threads[0]?.displayTitle).toBe(
      "Review Next in Renamed app",
    );
    expect(result.current.second.threads).toBe(result.current.first.threads);
    expect(
      result.current.first.projects.map((project) => project.name),
    ).toEqual(["App", "Personal"]);
  });

  it("keeps plain-titled threads when another thread leaves the title lookup", () => {
    const plain = makeThreadListEntry({ id: "thr_plain", title: "Plain" });
    state.data = payload([plain]);

    let resources: ThreadTitleMentionResources = {
      sectionNamesById: new Map(),
      projectNamesById: new Map(),
      threadById: new Map([
        ["thr_archived", { ...plain, id: "thr_archived", title: "Gone" }],
      ]),
    };

    const { result, rerender } = renderHook(() => useSidebarThreads(), {
      wrapper: ({ children }) => (
        <ThreadTitleMentionResourcesProvider {...resources}>
          {children}
        </ThreadTitleMentionResourcesProvider>
      ),
    });

    const before = result.current.threads[0];
    resources = { ...resources, threadById: new Map() };
    rerender();
    expect(result.current.threads[0]).toBe(before);
  });
});

it.skipIf(!process.env.OMNYO_SIDEBAR_MEASUREMENT_OUTPUT)(
  "measures fixed sidebar mounts",
  () => {
    const output = process.env.OMNYO_SIDEBAR_MEASUREMENT_OUTPUT;

    if (output === undefined)
      throw new Error("Sidebar measurement output is missing");

    const projects = Array.from({ length: 20 }, (_, projectIndex) => ({
      id: `proj_${projectIndex}`,
      name: `Project ${projectIndex}`,
      threads: Array.from({ length: 200 }, (_, threadIndex) => {
        const index = projectIndex * 200 + threadIndex;

        return makeThreadListEntry({
          id: `thr_${index}`,
          projectId: `proj_${projectIndex}`,
          title: `Chat ${index}`,
          archivedAt: null,
          environmentHostId: "host_measurement",
        });
      }),
    }));

    const navigation = {
      ...payload([]),
      projects,
    };

    hostQuery.data = [
      makeHost({ id: "host_measurement", name: "Measurement host" }),
    ];

    const expectedThreads = projects.flatMap((project) =>
      project.threads.map((thread) => ({
        id: thread.id,
        projectId: project.id,
        title: thread.title,
        displayTitle: thread.title,
        href: `/projects/${project.id}/threads/${thread.id}`,
        host: { id: "host_measurement", name: "Measurement host" },
        isArchived: false,
      })),
    );

    const expectedProjects = [
      ...projects.map((project) => ({
        id: project.id,
        name: project.name,
        isPersonal: false,
        href: `/projects/${project.id}`,
        settingsHref: `/settings/projects/${project.id}`,
      })),
      {
        id: PERSONAL_PROJECT_ID,
        name: "Personal",
        isPersonal: true,
        href: "/",
        settingsHref: `/settings/projects/${PERSONAL_PROJECT_ID}`,
      },
    ];

    const expectedSummary = `4000Chat 0Chat 3999${expectedProjects.map((project) => project.name).join("")}`;
    const samplesMs: number[] = [];
    const projectionCounts: { threads: number; projects: number }[] = [];

    for (let run = 0; run < 20; run++) {
      state.data = { ...navigation };
      const snapshots = new Map<number, PluginSidebarThreadsState>();

      const onState = (
        index: number,
        sidebar: PluginSidebarThreadsState,
      ): void => {
        snapshots.set(index, sidebar);
      };

      const start = performance.now();

      const mounted = render(
        <>
          {Array.from({ length: 80 }, (_, index) => (
            <SidebarMeasurementConsumer
              key={index}
              index={index}
              onState={onState}
            />
          ))}
        </>,
      );

      const durationMs = performance.now() - start;

      try {
        expect(snapshots.size).toBe(80);
        const first = snapshots.get(0);

        if (first === undefined)
          throw new Error("Sidebar consumer did not mount");
        expect(first.status).toBe("ready");
        expect(first.experimental_archived).toBeNull();
        expect(
          first.threads.map((thread) => ({
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            displayTitle: thread.displayTitle,
            href: thread.href,
            host: thread.host,
            isArchived: thread.isArchived,
          })),
        ).toEqual(expectedThreads);
        expect(first.projects).toEqual(expectedProjects);

        const summaries = mounted.container.querySelectorAll(
          "[data-sidebar-measurement]",
        );

        expect(summaries).toHaveLength(80);

        for (const summary of summaries)
          expect(summary.textContent).toBe(expectedSummary);

        if (run >= 5) {
          samplesMs.push(durationMs);
          projectionCounts.push({
            threads: new Set(
              [...snapshots.values()].map((sidebar) => sidebar.threads),
            ).size,
            projects: new Set(
              [...snapshots.values()].map((sidebar) => sidebar.projects),
            ).size,
          });
        }
      } finally {
        mounted.unmount();
      }
    }

    writeFileSync(
      output,
      JSON.stringify(
        {
          completed: true,
          method:
            "React DOM mount; fresh navigation payload and stable entries per mount; assertions and unmount excluded",
          activeChats: 4000,
          mountedConsumers: 80,
          warmMounts: 5,
          measuredMounts: 15,
          samplesMs,
          projectionCounts,
          inputHash: createHash("sha256")
            .update(JSON.stringify(navigation))
            .digest("hex"),
          visibleContentHash: createHash("sha256")
            .update(
              JSON.stringify({
                threads: expectedThreads,
                projects: expectedProjects,
              }),
            )
            .digest("hex"),
        },
        null,
        2,
      ),
    );
  },
);

describe("useSidebarThreads pending chats", () => {
  it("lists a new chat as starting before the server confirms it, then hands over to the real row", async () => {
    state.data = payload([makeThreadListEntry({ id: "thr_existing" })]);
    const creation = createDeferredPromise<ThreadResponse>();
    const { result } = renderHook(() => useSidebarThreads());

    let pending: ReturnType<typeof createPendingChat> | undefined;
    act(() => {
      pending = createPendingChat({
        queueOwner: {},
        request: {
          projectId: "proj_app",
          providerId: "codex",
          model: "gpt",
          reasoningLevel: "high",
          permissionMode: "full",
          environment: { type: "reuse", environmentId: "env_1" },
          executionInputSources: { providerId: "explicit", model: "explicit" },
          input: [{ type: "text", text: "Fix the  login\nbug", mentions: [] }],
          sectionId: "sec_work",
          pinned: false,
        },
        create: () => creation.promise,
        send: vi.fn(),
        renderer: () => null,
        prepare: async () => {},
      });
    });

    const starting = result.current.threads[0];
    expect(starting).toMatchObject({
      id: pending?.id,
      projectId: "proj_app",
      displayTitle: "Fix the login bug",
      sectionId: "sec_work",
      status: "starting",
      runtimeStatus: "starting",
      indicator: "runtime",
      experimental_work: { primary: { label: "working" } },
      href: `/projects/proj_app/threads/${pending?.id}`,
    });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      pending?.id,
      "thr_existing",
    ]);

    await act(async () => {
      creation.resolve(
        makeThreadResponse({ id: "thr_created", projectId: "proj_app" }),
      );
      await pending?.completion;
    });

    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "thr_existing",
    ]);
  });

  it("keeps one sidebar family from handoff submission through realtime and confirmation", async () => {
    const source = makeThreadListEntry({
      id: "thr_source",
      projectId: "proj_app",
      title: "Source title",
      sectionId: "sec_work",
      pinnedAt: 100,
    });

    const child = makeThreadListEntry({
      id: "thr_child",
      projectId: source.projectId,
      parentThreadId: source.id,
    });

    const earlier = makeThreadListEntry({
      id: "thr_earlier_handoff",
      projectId: source.projectId,
      originKind: "handoff",
      sourceThreadId: source.id,
    });

    state.data = payload([source, child, earlier]);

    const queryClient = new QueryClient();
    queryClient.setQueryData(sidebarNavigationQueryKey(), state.data);
    const creation = createDeferredPromise<ThreadResponse>();
    const { result, rerender } = renderHook(() => useSidebarThreads());

    const pending = await act(async () =>
      createPendingChat({
        queueOwner: queryClient,
        request: {
          projectId: source.projectId,
          providerId: "codex",
          model: "gpt",
          reasoningLevel: "high",
          permissionMode: "full",
          environment: { type: "reuse", environmentId: "env_1" },
          executionInputSources: { providerId: "explicit", model: "explicit" },
          input: [{ type: "text", text: "Continue", mentions: [] }],
          originKind: "handoff",
          sourceThreadId: source.id,
        },
        create: () => creation.promise,
        send: vi.fn(),
        renderer: () => null,
        prepare: async () => {},
      }),
    );

    const rootIds = () =>
      result.current.threads
        .filter((thread) => thread.parentThreadId === null)
        .map((thread) => thread.id);

    expect(rootIds()).toEqual([pending.id, earlier.id]);
    expect(result.current.threads[0]).toMatchObject({
      displayTitle: source.title,
      originKind: "handoff",
      sourceThreadId: source.id,
      sectionId: source.sectionId,
    });
    expect(
      result.current.threads
        .filter((thread) => thread.parentThreadId === pending.id)
        .map((thread) => thread.id),
    ).toEqual([source.id, child.id]);

    const target = makeThreadListEntry({
      id: "thr_target",
      projectId: source.projectId,
      title: source.title,
      originKind: "handoff",
      sourceThreadId: source.id,
    });

    state.data = payload([target, source, child, earlier]);
    rerender();
    expect(rootIds()).toEqual([pending.id, earlier.id]);

    await act(async () => {
      creation.resolve(makeThreadResponse(target));
      await pending.completion;
    });
    expect(rootIds()).toEqual([target.id, earlier.id]);

    state.data = payload([
      target,
      { ...source, parentThreadId: target.id },
      { ...child, parentThreadId: target.id },
      earlier,
    ]);
    rerender();
    expect(rootIds()).toEqual([target.id, earlier.id]);
    expect(
      result.current.threads.some((thread) => thread.id === pending.id),
    ).toBe(false);
  });

  it("opens a starting chat through its pending route", async () => {
    state.data = payload([]);
    const creation = createDeferredPromise<ThreadResponse>();
    let pending: ReturnType<typeof createPendingChat> | undefined;
    act(() => {
      pending = createPendingChat({
        queueOwner: {},
        request: {
          projectId: "proj_app",
          providerId: "codex",
          model: "gpt",
          reasoningLevel: "high",
          permissionMode: "full",
          environment: { type: "reuse", environmentId: "env_1" },
          executionInputSources: { providerId: "explicit", model: "explicit" },
          input: [{ type: "text", text: "Open me", mentions: [] }],
        },
        create: () => creation.promise,
        send: vi.fn(),
        renderer: () => null,
        prepare: async () => {},
      });
    });
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() => {
      result.current.open(pending?.id ?? "");
    });
    expect(actions.navigate).toHaveBeenCalledWith(
      `/projects/proj_app/threads/${pending?.id}`,
    );

    await act(async () => {
      creation.resolve(
        makeThreadResponse({ id: "thr_opened", projectId: "proj_app" }),
      );
      await pending?.completion;
    });
  });
});

describe("sidebar lifecycle selection", () => {
  it("keeps active reads archive-free and selects archived, both, and active again", async () => {
    const active = makeThreadListEntry({ id: "thr_active", archivedAt: null });

    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });

    state.data = payload([active, archived]);
    archiveQuery.data = { pages: [[archived, active], [archived]] };
    archiveQuery.hasNextPage = true;

    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "archived")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["active"] } },
    );

    expect(archiveEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
    expect(result.current.experimental_archived).toBeNull();
    const activeThreads = result.current.threads;
    rerender({ lifecycles: ["archived"] });
    expect(archiveEnabled).toHaveBeenLastCalledWith(true);
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      archived.id,
    ]);
    expect(result.current.experimental_archived?.hasNextPage).toBe(true);
    await result.current.experimental_archived?.fetchNextPage();
    expect(archiveQuery.fetchNextPage).toHaveBeenCalledOnce();
    rerender({ lifecycles: ["active", "archived"] });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      archived.id,
      active.id,
    ]);
    rerender({ lifecycles: ["active"] });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
    expect(result.current.threads).toBe(activeThreads);
  });

  it("updates archive projections without rebuilding active projections", () => {
    const active = makeThreadListEntry({ id: "thr_active", archivedAt: null });

    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });

    const nextArchived = makeThreadListEntry({
      id: "thr_next",
      archivedAt: 43,
    });

    state.data = payload([active]);
    archiveQuery.data = { pages: [[archived]] };

    const { result, rerender } = renderHook(() => ({
      active: useSidebarThreads(),
      archived: useSidebarThreads({ experimental_lifecycles: ["archived"] }),
      both: useSidebarThreads({
        experimental_lifecycles: ["active", "archived"],
      }),
    }));

    const before = result.current;
    expect(before.active.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
    expect(before.archived.threads.map((thread) => thread.id)).toEqual([
      archived.id,
    ]);
    expect(before.both.threads.map((thread) => thread.id)).toEqual([
      archived.id,
      active.id,
    ]);

    archiveQuery.data = { pages: [[archived], [nextArchived]] };
    rerender();
    expect(result.current.active.threads).toBe(before.active.threads);
    expect(result.current.active.projects).toBe(before.active.projects);
    expect(result.current.archived.threads).not.toBe(before.archived.threads);
    expect(result.current.both.threads).not.toBe(before.both.threads);
    expect(result.current.archived.threads.map((thread) => thread.id)).toEqual([
      archived.id,
      nextArchived.id,
    ]);
    expect(result.current.both.threads.map((thread) => thread.id)).toEqual([
      archived.id,
      nextArchived.id,
      active.id,
    ]);
    expect(result.current.archived.threads[0]).toBe(before.archived.threads[0]);
    expect(result.current.active.experimental_archived).toBeNull();
  });

  it("keeps archive status, pagination, and callbacks local to each observer", async () => {
    state.data = payload([]);
    const firstFetch = archiveQuery.fetchNextPage;

    const first = renderHook(() =>
      useSidebarThreads({ experimental_lifecycles: ["archived"] }),
    );

    archiveQuery.isLoadingError = true;
    archiveQuery.hasNextPage = true;
    archiveQuery.isFetchingNextPage = true;
    archiveQuery.isFetchNextPageError = true;
    const secondFetch = vi.fn(async () => undefined);
    archiveQuery.fetchNextPage = secondFetch;

    const second = renderHook(() =>
      useSidebarThreads({ experimental_lifecycles: ["archived"] }),
    );

    expect(first.result.current.status).toBe("loading");
    expect(second.result.current.status).toBe("error");
    expect(first.result.current.experimental_archived).toMatchObject({
      status: "loading",
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    });
    expect(second.result.current.experimental_archived).toMatchObject({
      status: "error",
      hasNextPage: true,
      isFetchingNextPage: true,
      isFetchNextPageError: true,
    });
    expect(second.result.current).not.toBe(first.result.current);
    expect(second.result.current.experimental_archived).not.toBe(
      first.result.current.experimental_archived,
    );
    expect(second.result.current.threads).toBe(first.result.current.threads);
    await first.result.current.experimental_archived?.fetchNextPage();
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(secondFetch).not.toHaveBeenCalled();
    await second.result.current.experimental_archived?.fetchNextPage();
    expect(secondFetch).toHaveBeenCalledOnce();
  });

  it("reports archive loading and errors without hiding active rows in a combined view", () => {
    state.data = payload([makeThreadListEntry({ archivedAt: null })]);

    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "archived")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["archived"] } },
    );

    expect(result.current.status).toBe("loading");
    archiveQuery.isLoadingError = true;
    rerender({ lifecycles: ["archived"] });
    expect(result.current.status).toBe("error");
    rerender({ lifecycles: ["active", "archived"] });
    expect(result.current.status).toBe("ready");
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.experimental_archived?.status).toBe("error");
  });

  it("resolves archived entries for host-owned row actions and status", () => {
    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });

    state.data = payload([]);
    archiveQuery.data = { pages: [[archived]] };
    const { result } = renderHook(() => useSidebarThreadEntry(archived.id));
    expect(result.current).toBe(archived);
  });

  it("pages shelved threads and keeps them out of active reads", async () => {
    const active = makeThreadListEntry({ id: "thr_active" });
    const shelved = makeThreadListEntry({ id: "thr_shelved", shelvedAt: 50 });

    const shelvedChild = makeThreadListEntry({
      id: "thr_shelved_child",
      parentThreadId: shelved.id,
      shelvedAt: 50,
    });

    state.data = payload([active]);
    shelfQuery.data = { pages: [[shelved], [shelvedChild]] };
    shelfQuery.hasNextPage = true;

    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "shelved")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["active"] } },
    );

    expect(shelfEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
    expect(result.current.experimental_shelved).toBeNull();

    rerender({ lifecycles: ["shelved"] });
    expect(shelfEnabled).toHaveBeenLastCalledWith(true);
    expect(
      result.current.threads.map((thread) => [
        thread.id,
        thread.experimental_shelvedAt,
      ]),
    ).toEqual([
      [shelved.id, 50],
      [shelvedChild.id, 50],
    ]);
    expect(result.current.experimental_shelved?.hasNextPage).toBe(true);
    expect(result.current.experimental_archived).toBeNull();
    await result.current.experimental_shelved?.fetchNextPage();
    expect(shelfQuery.fetchNextPage).toHaveBeenCalledOnce();
    expect(archiveQuery.fetchNextPage).not.toHaveBeenCalled();

    rerender({ lifecycles: ["active", "shelved"] });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      shelved.id,
      shelvedChild.id,
      active.id,
    ]);
  });

  it("moves a thread between the active and shelved reads as soon as its cached entry changes", () => {
    const shelving = makeThreadListEntry({ id: "thr_shelving", shelvedAt: 60 });
    const stillShelved = makeThreadListEntry({ id: "thr_kept", shelvedAt: 50 });

    const unshelving = makeThreadListEntry({
      id: "thr_unshelving",
      shelvedAt: null,
    });

    const archivedFromShelf = makeThreadListEntry({
      id: "thr_archived",
      shelvedAt: null,
      archivedAt: 70,
    });

    const returned = makeThreadListEntry({
      id: "thr_returned",
      shelvedAt: null,
    });

    state.data = payload([shelving, returned]);
    shelfQuery.data = {
      pages: [
        [
          stillShelved,
          unshelving,
          archivedFromShelf,
          { ...returned, shelvedAt: 40 },
        ],
      ],
    };

    const { result } = renderHook(() => ({
      active: useSidebarThreads({ experimental_lifecycles: ["active"] }),
      shelved: useSidebarThreads({ experimental_lifecycles: ["shelved"] }),
      both: useSidebarThreads({
        experimental_lifecycles: ["active", "shelved"],
      }),
    }));

    expect(result.current.active.threads.map((thread) => thread.id)).toEqual([
      returned.id,
    ]);
    expect(result.current.shelved.threads.map((thread) => thread.id)).toEqual([
      stillShelved.id,
      shelving.id,
    ]);
    expect(result.current.both.threads.map((thread) => thread.id)).toEqual([
      stillShelved.id,
      unshelving.id,
      returned.id,
      shelving.id,
    ]);
  });

  it("reports shelf loading and errors for shelf-only reads", () => {
    state.data = payload([makeThreadListEntry({ id: "thr_active" })]);

    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "archived" | "shelved")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["shelved"] } },
    );

    expect(result.current.status).toBe("loading");
    expect(result.current.threads).toEqual([]);
    archiveQuery.data = { pages: [] };
    shelfQuery.isLoadingError = true;
    rerender({ lifecycles: ["archived", "shelved"] });
    expect(result.current.status).toBe("error");
    expect(result.current.experimental_archived?.status).toBe("ready");
    rerender({ lifecycles: ["active", "shelved"] });
    expect(result.current.status).toBe("ready");
    expect(result.current.experimental_shelved?.status).toBe("error");
  });

  it("resolves shelved entries for host-owned row actions and status", () => {
    const shelved = makeThreadListEntry({ id: "thr_shelved", shelvedAt: 50 });

    state.data = payload([]);
    shelfQuery.data = { pages: [[shelved]] };
    const { result } = renderHook(() => useSidebarThreadEntry(shelved.id));
    expect(result.current).toBe(shelved);
  });
});

describe("useSidebarThreads sections", () => {
  it("passes the bootstrap sections through in server order", () => {
    const sections = [
      { id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 },
      { id: "sec_slop", name: "Slop Cop", createdAt: 2, updatedAt: 2 },
    ];

    state.data = payload([], sections);
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.sections).toEqual(sections);
  });

  it("gives each project its compose and settings hrefs", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.projects).toEqual([
      {
        id: "proj_app",
        name: "App",
        isPersonal: false,
        href: "/projects/proj_app",
        settingsHref: "/settings/projects/proj_app",
      },
      {
        id: PERSONAL_PROJECT_ID,
        name: "Personal",
        isPersonal: true,
        href: "/",
        settingsHref: `/settings/projects/${PERSONAL_PROJECT_ID}`,
      },
    ]);
  });

  it("reports an empty section list while loading", () => {
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.status).toBe("loading");
    expect(result.current.sections).toEqual([]);
  });
});

describe("useSidebarThreadActions", () => {
  it.each([
    { pinned: true, pinnedAt: null, mutate: mutations.pinThreadAsync },
    { pinned: false, pinnedAt: 42, mutate: mutations.unpinThreadAsync },
  ])(
    "waits for the optimistic host mutation when setPinned is $pinned",
    async ({ pinned, pinnedAt, mutate }) => {
      const thread = makeThreadListEntry({ id: "thr_1", pinnedAt });
      state.data = payload([thread]);
      let resolveMutation: (() => void) | undefined;
      mutate.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveMutation = resolve;
        }),
      );
      const { result } = renderHook(() => useSidebarThreadActions());

      let settled = false;

      const request = result.current.setPinned(thread.id, pinned).then(() => {
        settled = true;
      });

      await act(async () => Promise.resolve());

      expect(mutate).toHaveBeenCalledWith({ id: thread.id });
      expect(settled).toBe(false);

      await act(async () => {
        resolveMutation?.();
        await request;
      });
      expect(settled).toBe(true);
    },
  );

  it("opens a project composer without a legacy route transition", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_target",
        focusPrompt: true,
      });
    });

    expect(actions.setRootComposeProjectId).toHaveBeenCalledWith("proj_target");
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: {
        focusPrompt: true,
        placement: { sectionId: null, pinned: false },
      },
    });
  });

  it("opens a section without changing the selected project", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        sectionId: "sec_later",
        focusPrompt: true,
      });
    });

    expect(actions.setRootComposeProjectId).not.toHaveBeenCalled();
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: {
        focusPrompt: true,
        sectionId: "sec_later",
        placement: { sectionId: "sec_later", pinned: false },
      },
    });
  });

  it("reuses an environment the way Omnyo's environment header does", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_app",
        environmentId: "env_1",
      });
    });

    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: {
        reuseEnvironmentId: "env_1",
        placement: { sectionId: null, pinned: false },
      },
    });
  });

  it("passes a machine selection to the root composer", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_app",
        hostId: "host_homelab",
        focusPrompt: true,
      });
    });

    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: {
        focusPrompt: true,
        newEnvironmentHostId: "host_homelab",
        placement: { sectionId: null, pinned: false },
      },
    });
  });

  it("preserves explicit pinned placement over the legacy section", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() =>
      result.current.openNewThread({
        sectionId: "sec_old",
        experimental_placement: { sectionId: "sec_managers", pinned: true },
      }),
    );
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: {
        sectionId: "sec_old",
        placement: { sectionId: "sec_managers", pinned: true },
      },
    });
  });

  it("clears placement when opening global new thread", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() => {
      result.current.openNewThread();
    });
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: { placement: { sectionId: null, pinned: false } },
    });
  });

  it("re-expands a collapsed conversation when opening its thread", () => {
    const thread = makeThreadListEntry({ id: "thr_1", projectId: "proj_app" });
    state.data = payload([thread]);
    const store = getDefaultStore();
    const collapsedAtom = getThreadConversationCollapsedAtom("thr_1");
    store.set(collapsedAtom, true);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.open("thr_1");
    });

    expect(store.get(collapsedAtom)).toBe(false);
    expect(actions.navigate).toHaveBeenCalledWith(
      "/projects/proj_app/threads/thr_1",
    );
  });

  it("ignores open for an unknown thread", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() => {
      result.current.open("thr_missing");
    });
    expect(actions.navigate).not.toHaveBeenCalled();
  });
});

describe("per-row client state hooks", () => {
  it("reports an unsent draft for a known thread and false otherwise", () => {
    const thread = makeThreadListEntry({ id: "thr_1", projectId: "proj_app" });
    state.data = payload([thread]);
    drafts.threadIds.add("thr_1");
    drafts.threadIds.add("thr_unknown");

    const known = renderHook(() => useSidebarThreadDraft("thr_1"));
    const unknown = renderHook(() => useSidebarThreadDraft("thr_unknown"));
    expect(known.result.current.hasUnsubmittedDraft).toBe(true);
    expect(unknown.result.current.hasUnsubmittedDraft).toBe(false);

    act(() => {
      drafts.threadIds.delete("thr_1");
      drafts.notify();
    });
    expect(known.result.current.hasUnsubmittedDraft).toBe(false);
  });

  it("collects every sidebar thread holding a draft", () => {
    state.data = payload([
      makeThreadListEntry({ id: "thr_1", projectId: "proj_app" }),
      makeThreadListEntry({ id: "thr_2", projectId: "proj_app" }),
    ]);
    drafts.threadIds.add("thr_2");
    const { result } = renderHook(() => useSidebarThreadDraftIds());
    expect([...result.current]).toEqual(["thr_2"]);

    act(() => {
      drafts.threadIds.add("thr_1");
      drafts.notify();
    });
    expect([...result.current].sort()).toEqual(["thr_1", "thr_2"]);
  });

  it("reads and tracks a row status set by another plugin", () => {
    const { result } = renderHook(() => useSidebarThreadRowStatus("thr_1"));
    expect(result.current).toBeNull();

    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", {
        icon: "Loading",
        label: "Drafting",
        tone: "running",
      });
    });
    expect(result.current).toEqual({
      icon: "Loading",
      label: "Drafting",
      tone: "running",
    });

    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", null);
    });
    expect(result.current).toBeNull();
  });

  it("collects every row status for group rollups and keeps identity while unchanged", () => {
    const { result } = renderHook(() => useSidebarThreadRowStatuses());
    expect(result.current.size).toBe(0);
    const initial = result.current;
    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", {
        icon: "Loading",
        label: "Drafting",
      });
      setPluginThreadRowStatus("thr_2", "plugin-a", {
        icon: "Check",
        label: "Done",
        tone: "success",
      });
    });
    expect([...result.current.keys()].sort()).toEqual(["thr_1", "thr_2"]);
    expect(result.current.get("thr_2")?.tone).toBe("success");
    const settled = result.current;
    act(() => {});
    expect(result.current).toBe(settled);
    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", null);
      setPluginThreadRowStatus("thr_2", "plugin-a", null);
    });
    expect(result.current.size).toBe(0);
    expect(result.current).toBe(initial);
  });

  it("reports the assigned shortcut only while the host provides one", () => {
    const withoutProvider = renderHook(() => useSidebarThreadShortcut("thr_1"));
    expect(withoutProvider.result.current).toBeNull();

    const keys = new Map([
      ["thr_1", { label: "⌘1", ariaKeyshortcuts: "Meta+1" }],
    ]);

    const { result } = renderHook(() => useSidebarThreadShortcut("thr_1"), {
      wrapper: ({ children }) => (
        <SidebarThreadShortcutKeysContext.Provider value={keys}>
          {children}
        </SidebarThreadShortcutKeysContext.Provider>
      ),
    });

    expect(result.current).toEqual({ label: "⌘1", ariaKeyshortcuts: "Meta+1" });

    const other = renderHook(() => useSidebarThreadShortcut("thr_2"), {
      wrapper: ({ children }) => (
        <SidebarThreadShortcutKeysContext.Provider value={keys}>
          {children}
        </SidebarThreadShortcutKeysContext.Provider>
      ),
    });

    expect(other.result.current).toBeNull();
  });
});

describe("useEnvironmentProviders", () => {
  it("reports loading until the catalog resolves, then a narrowed row per provider", () => {
    const { result, rerender } = renderHook(() => useEnvironmentProviders());
    expect(result.current).toEqual({ status: "loading", providers: [] });

    environmentProviders.providers = [
      {
        id: "git-worktree",
        displayName: "Git worktree",
        description: "A worktree per thread",
        icon: "GitBranch",
        logoUrl: null,
        pluginId: "environment-git-worktree",
        machineProviderId: null,
        requires: {},
        inputs: null,
        acceptsEmptyInputs: true,
        availability: null,
        machineAvailability: {},
      },
    ];
    rerender();
    expect(result.current).toEqual({
      status: "ready",
      providers: [
        {
          id: "git-worktree",
          displayName: "Git worktree",
          description: "A worktree per thread",
          icon: "GitBranch",
          logoUrl: null,
          pluginId: "environment-git-worktree",
          machineProviderId: null,
        },
      ],
    });
  });
});
