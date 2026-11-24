import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID, projectThreadWork } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import {
  hostsQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
} from "@/hooks/queries/query-keys";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { createAppQueryClient } from "@/lib/query-client";
import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { loadPluginAppDefinition } from "../../../.ladle/plugin-app-module";
import {
  PROJECT_IDS,
  makeProject,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { PluginThreadList } from "./PluginThreadList";
import {
  ThreadListPlaceholder,
  type ThreadListPlaceholderState,
} from "./ThreadListPlaceholder";
import { useThreadListReplacement } from "./threadListProvider";

installTestPluginRuntime();

const threadListApp = await loadPluginAppDefinition(
  import.meta.glob<unknown>("../../../../../plugins/thread-list/app.tsx"),
);

export default { title: "sidebar/Thread list states" };

const THREAD_LIST_PLUGIN_ID = "thread-list";

const DESIGN = { id: "sec_design", name: "Design", createdAt: 1, updatedAt: 1 };

const STORY_NOW = Date.now();

const HOUR = 3_600_000;

const WORKING_SUMMARY = projectThreadWork({
  revision: "story-working",
  basis: "story",
  activity: [
    {
      id: "story:turn",
      kind: "turn",
      label: "Working",
      phase: "running",
      actor: { kind: "agent", id: null, label: "Agent" },
    },
  ],
  requiredInput: [],
  optionalInput: [],
  failures: [],
  waits: [],
  coverageComplete: true,
  unknownReason: null,
  assessment: null,
  postponement: null,
  closed: false,
});

function entry(
  id: string,
  title: string,
  hoursAgo: number,
  overrides: Parameters<typeof makeThreadListEntry>[0] = {},
) {
  return makeThreadListEntry({
    id,
    projectId: PROJECT_IDS.omnyo,
    title,
    titleFallback: title,
    sectionId: null,
    environmentId: null,
    latestAttentionAt: STORY_NOW - hoursAgo * HOUR,
    lastMessageAt: STORY_NOW - hoursAgo * HOUR,
    createdAt: STORY_NOW - hoursAgo * HOUR,
    updatedAt: STORY_NOW - hoursAgo * HOUR,
    lastReadAt: STORY_NOW,
    ...overrides,
  });
}

function working(subagents: number) {
  return {
    status: "active" as const,
    runtime: { displayStatus: "active" as const },
    work: WORKING_SUMMARY,
    activity: {
      activeBackgroundAgentCount: subagents === 0 ? 0 : 1,
      activeSubagentCount: subagents,
    },
  };
}

const SECTION_THREADS = [
  entry("thr_tokens", "Theme token audit", 0.2, {
    sectionId: DESIGN.id,
    ...working(3),
  }),
  entry("thr_rail", "Nav rail spacing", 3, { sectionId: DESIGN.id }),
  entry("thr_flaky", "Fix flaky composer test", 0.5, working(0)),
  entry("thr_release", "Release notes draft", 5),
  entry("thr_digest", "Digest: GitHub activity", 26),
  entry("thr_places", "Saved Places import", 24 * 9),
  entry("thr_catalog", "Plugin catalog refresh", 24 * 40),
];

const LAUNCH_GROUP = {
  id: "grp_launch",
  projectId: PROJECT_IDS.omnyo,
  name: "Launch week",
  createdAt: 1,
  updatedAt: 1,
};

const GROUPED_THREADS = [
  entry("thr_launch_copy", "Landing page copy", 1, {
    groupId: LAUNCH_GROUP.id,
  }),
  entry("thr_launch_video", "Demo video script", 2, {
    groupId: LAUNCH_GROUP.id,
    ...working(2),
  }),
  entry("thr_launch_mail", "Announcement email", 6, {
    groupId: LAUNCH_GROUP.id,
  }),
  entry("thr_flaky_project", "Fix flaky composer test", 0.5),
  entry("thr_release_project", "Release notes draft", 30),
];

function sidebarNavigation(
  threads: SidebarBootstrapResponse["projects"][number]["threads"],
  sections: SidebarBootstrapResponse["sections"],
): SidebarBootstrapResponse {
  return {
    sections,
    groups: threads.some((thread) => thread.groupId === LAUNCH_GROUP.id)
      ? [LAUNCH_GROUP]
      : [],
    orderedProjectIds: [PROJECT_IDS.omnyo, PERSONAL_PROJECT_ID],
    projects: [{ ...makeProject(), defaultExecutionOptions: null, threads }],
    personalProject: {
      ...makeProject({
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        name: "Personal",
        sources: [],
      }),
      defaultExecutionOptions: null,
      threads: [],
    },
  };
}

function createQueryClient(
  threads: SidebarBootstrapResponse["projects"][number]["threads"],
  sections: SidebarBootstrapResponse["sections"],
  shelfLoads: boolean,
) {
  const queryClient = createAppQueryClient({
    showMutationErrorToasts: false,
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });

  queryClient.setQueryData(hostsQueryKey(), []);
  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    sidebarNavigation(threads, sections),
  );

  if (shelfLoads) {
    queryClient.setQueryData(shelvedThreadsListQueryKey(), {
      pages: [[]],
      pageParams: [0],
    });
  }

  return queryClient;
}

const preferenceInputSchema = {
  parse(body: string): { key: string; value: unknown } | null {
    const parsed: unknown = JSON.parse(body);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("key" in parsed) ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }

    return { key: parsed.key, value: "value" in parsed ? parsed.value : null };
  },
};

function usePreferenceRpc(initial: Record<string, unknown>) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const preferences = { ...initial };
    const prefix = `/api/v1/plugins/${THREAD_LIST_PLUGIN_ID}/rpc/`;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      const method = url.includes(prefix) ? url.split(prefix)[1] : null;

      const reply = (result: unknown) =>
        new Response(JSON.stringify({ ok: true, result }), {
          headers: { "content-type": "application/json" },
        });

      if (method === "listPreferences") return reply({ preferences });

      if (method === "setPreference" && typeof init?.body === "string") {
        const update = preferenceInputSchema.parse(init.body);

        if (update !== null) {
          preferences[update.key] = update.value;

          return reply(update);
        }
      }

      return originalFetch(input, init);
    };

    setReady(true);

    return () => {
      globalThis.fetch = originalFetch;
    };
  }, [initial]);

  return ready;
}

function useThreadListPlugin() {
  useEffect(() => {
    setPluginSlotRegistrations(
      THREAD_LIST_PLUGIN_ID,
      makePluginRegistrationSet({
        threadLists: collectPluginAppRegistrations(threadListApp).threadLists,
      }),
    );

    return () => removePluginSlotRegistrations(THREAD_LIST_PLUGIN_ID);
  }, []);
}

function SidebarFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen className="min-h-0 w-auto">
      <div className="flex h-[560px] w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground">
        <SidebarContent>{children}</SidebarContent>
      </div>
    </SidebarProvider>
  );
}

function ThreadListSidebar() {
  const replacement = useThreadListReplacement();
  const { data } = useSidebarNavigation();

  return (
    <SidebarThreadEntriesProvider navigation={data}>
      <SidebarFrame>
        <PluginThreadList replacement={replacement} onNavigate={() => {}} />
      </SidebarFrame>
    </SidebarThreadEntriesProvider>
  );
}

function StoryNote({ children }: { children: ReactNode }) {
  return <p className="max-w-xs text-sm text-muted-foreground">{children}</p>;
}

function ThreadListStory({
  threads,
  sections,
  preferences,
  note,
  shelfLoads = true,
}: {
  threads: SidebarBootstrapResponse["projects"][number]["threads"];
  sections: SidebarBootstrapResponse["sections"];
  preferences: Record<string, unknown>;
  note: string;
  shelfLoads?: boolean;
}) {
  const [queryClient] = useState(() =>
    createQueryClient(threads, sections, shelfLoads),
  );

  const rpcReady = usePreferenceRpc(preferences);
  useThreadListPlugin();

  if (!rpcReady) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <ThreadActionsProvider>
          <main className="flex gap-6 p-6">
            <ThreadListSidebar />
            <StoryNote>{note}</StoryNote>
          </main>
        </ThreadActionsProvider>
      </ActionHistoryProvider>
    </QueryClientProvider>
  );
}

const COLLAPSED_PREFERENCES = {
  organizationMode: "chronological",
  collapsedSections: ["threads"],
};

export function CollapsedSections() {
  return (
    <ThreadListStory
      threads={SECTION_THREADS}
      sections={[DESIGN]}
      preferences={COLLAPSED_PREFERENCES}
      note="Threads starts collapsed and shows how many threads it hides. Click a section's name or its chevron to fold it; the choice is remembered. Hover a working glyph to read what it means, including how many subagents are running."
    />
  );
}

const CHRONOLOGICAL_PREFERENCES = { organizationMode: "chronological" };

export function EmptyAndErrorStates() {
  return (
    <ThreadListStory
      threads={[]}
      sections={[DESIGN]}
      preferences={CHRONOLOGICAL_PREFERENCES}
      shelfLoads={false}
      note="An empty section says so in legible text. Shelved threads fail to load in this story, so the Shelf error notice appears below the list."
    />
  );
}

const PLACEHOLDER_STATES: readonly {
  label: string;
  state: ThreadListPlaceholderState;
}[] = [
  { label: "Loading", state: { kind: "loading" } },
  { label: "No list plugin", state: { kind: "missing", onReload: () => {} } },
  {
    label: "List crashed",
    state: { kind: "crashed", pluginTitle: "Thread list", onReload: () => {} },
  },
];

export function PlaceholderStates() {
  return (
    <main className="flex flex-wrap gap-6 p-6">
      {PLACEHOLDER_STATES.map(({ label, state }) => (
        <section key={label} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold text-muted-foreground">
            {label}
          </h2>
          <SidebarFrame>
            <ThreadListPlaceholder state={state} />
          </SidebarFrame>
        </section>
      ))}
    </main>
  );
}

const PROJECT_PREFERENCES = { organizationMode: "project" };

export function ProjectModeGroups() {
  return (
    <ThreadListStory
      threads={GROUPED_THREADS}
      sections={[]}
      preferences={PROJECT_PREFERENCES}
      note="Organized by project. A chat group reads as a folder: it has a folder glyph that opens when expanded and a count chip for how many chats it holds. Click the folder row to fold it."
    />
  );
}
