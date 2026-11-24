import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import { useEffect, useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { PERSONAL_PROJECT_ID, projectThreadWork } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { Button } from "@omnyo/shared-ui/button";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import {
  hostsQueryKey,
  sidebarNavigationQueryKey,
} from "@/hooks/queries/query-keys";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { createAppQueryClient } from "@/lib/query-client";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { loadPluginAppDefinition } from "../../../.ladle/plugin-app-module";
import {
  PROJECT_IDS,
  makeProject,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { PluginThreadList } from "./PluginThreadList";
import { useThreadListReplacement } from "./threadListProvider";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";

installTestPluginRuntime();

const threadListApp = await loadPluginAppDefinition(
  import.meta.glob<unknown>("../../../../../plugins/thread-list/app.tsx"),
);

export default { title: "sidebar/Thread list" };

const THREAD_LIST_PLUGIN_ID = "thread-list";

const INBOX = { id: "sec_inbox", name: "Inbox", createdAt: 1, updatedAt: 1 };

const READ_AT = 10_000;

const STORY_NOW = Date.now();

function inboxEntry(
  id: string,
  title: string,
  latestAttentionAt: number,
  unread: boolean,
  overrides: Parameters<typeof makeThreadListEntry>[0] = {},
) {
  return makeThreadListEntry({
    id,
    projectId: PROJECT_IDS.omnyo,
    title,
    titleFallback: title,
    sectionId: INBOX.id,
    environmentId: null,
    latestAttentionAt,
    lastMessageAt: STORY_NOW - (1_000 - latestAttentionAt) ** 2 * 1_000,
    createdAt: STORY_NOW - (1_000 - latestAttentionAt) * 3_600_000,
    updatedAt: latestAttentionAt,
    lastReadAt: unread ? 0 : READ_AT,
    ...overrides,
  });
}

const INBOX_THREADS = [
  inboxEntry("thr_flaky", "Fix flaky composer test", 900, false),
  inboxEntry("thr_release", "Release notes draft", 800, true),
  inboxEntry("thr_ambient", "Ambient shader palette", 700, false),
  inboxEntry("thr_digest", "Digest: GitHub activity", 600, true),
  inboxEntry("thr_pins", "File Pins menu alignment", 500, false),
  inboxEntry("thr_places", "Saved Places import", 400, true),
  inboxEntry("thr_catalog", "Plugin catalog refresh", 200, false),
  inboxEntry("thr_catalog_shots", "Catalog screenshots", 190, false, {
    parentThreadId: "thr_catalog",
  }),
  inboxEntry("thr_catalog_copy", "Catalog descriptions", 180, true, {
    parentThreadId: "thr_catalog",
  }),
];

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

const SUBAGENT_THREADS = [
  ["Improve Omnyo bottom-bar toggle", 0],
  ["Reduce Omnyo agent time sinks", 1],
  ["Context menu glow redesign", 3],
  ["Sidebar chat status flicker", 12],
] as const satisfies readonly (readonly [string, number])[];

const WORKING_SUBAGENT_THREADS = SUBAGENT_THREADS.map(([title, count], index) =>
  inboxEntry(`thr_subagents_${count}`, title, 900 - index, false, {
    status: "active",
    runtime: { displayStatus: "active" },
    work: WORKING_SUMMARY,
    activity: {
      activeBackgroundAgentCount: count === 0 ? 0 : 1,
      activeSubagentCount: count,
    },
  }),
);

function sidebarNavigation(
  threads: SidebarBootstrapResponse["projects"][number]["threads"],
): SidebarBootstrapResponse {
  return {
    sections: [INBOX],
    groups: [],
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

function createThreadListQueryClient(
  threads: SidebarBootstrapResponse["projects"][number]["threads"] = INBOX_THREADS,
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
    sidebarNavigation(threads),
  );

  return queryClient;
}

function useThreadListPreferenceRpc(initial: Record<string, unknown>) {
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
        const { key, value } = JSON.parse(init.body) as {
          key: string;
          value: unknown;
        };

        preferences[key] = value;

        return reply({ key, value });
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

function ThreadListSidebar() {
  const replacement = useThreadListReplacement();
  const { data } = useSidebarNavigation();

  return (
    <SidebarThreadEntriesProvider navigation={data}>
      <SidebarProvider defaultOpen className="min-h-0 w-auto">
        <div className="flex h-[560px] w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground">
          <SidebarContent>
            <PluginThreadList replacement={replacement} onNavigate={() => {}} />
          </SidebarContent>
        </div>
      </SidebarProvider>
    </SidebarThreadEntriesProvider>
  );
}

function OpenThreadControls() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [, refresh] = useState(0);
  const openThreadId = pathname.match(/\/threads\/([^/]+)/)?.[1] ?? null;

  const navigation = queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );

  const openThread = navigation?.projects[0]?.threads.find(
    (thread) => thread.id === openThreadId,
  );

  const openThreadIsUnread =
    openThread !== undefined &&
    (openThread.lastReadAt ?? 0) < openThread.latestAttentionAt;

  const markOpenThreadRead = () => {
    queryClient.setQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
      (current) =>
        current && {
          ...current,
          projects: current.projects.map((project) => ({
            ...project,
            threads: project.threads.map((thread) =>
              thread.id === openThreadId
                ? { ...thread, lastReadAt: READ_AT }
                : thread,
            ),
          })),
        },
    );
    refresh((count) => count + 1);
  };

  return (
    <section className="grid max-w-xs content-start gap-3 text-sm">
      <p className="text-muted-foreground">
        Organize → Groups → By read status starts on. Click a thread to open it,
        then mark it read the way Omnyo does when you view it. It keeps its
        group until you open another thread.
      </p>
      <p className="text-xs text-muted-foreground">
        Open thread: {openThread?.title ?? "none"}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!openThreadIsUnread}
          onClick={markOpenThreadRead}
        >
          Mark open thread read
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            queryClient.setQueryData(
              sidebarNavigationQueryKey(),
              sidebarNavigation(INBOX_THREADS),
            );
            navigate("/");
          }}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}

const READ_STATUS_PREFERENCES = {
  organizationMode: "chronological",
  groupByReadStatus: true,
};

export function InboxReadStatus() {
  const [queryClient] = useState(createThreadListQueryClient);
  const rpcReady = useThreadListPreferenceRpc(READ_STATUS_PREFERENCES);
  useThreadListPlugin();

  if (!rpcReady) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <ThreadActionsProvider>
          <main className="flex gap-6 p-6">
            <ThreadListSidebar />
            <OpenThreadControls />
          </main>
        </ThreadActionsProvider>
      </ActionHistoryProvider>
    </QueryClientProvider>
  );
}

const CHRONOLOGICAL_PREFERENCES = { organizationMode: "chronological" };

export function WorkingSubagents() {
  const [queryClient] = useState(() =>
    createThreadListQueryClient(WORKING_SUBAGENT_THREADS),
  );

  const rpcReady = useThreadListPreferenceRpc(CHRONOLOGICAL_PREFERENCES);
  useThreadListPlugin();

  if (!rpcReady) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <ThreadActionsProvider>
          <main className="flex gap-6 p-6">
            <ThreadListSidebar />
          </main>
        </ThreadActionsProvider>
      </ActionHistoryProvider>
    </QueryClientProvider>
  );
}
