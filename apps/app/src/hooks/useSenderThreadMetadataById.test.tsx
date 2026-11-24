// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadListEntry } from "@omnyo/domain";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "@/hooks/queries/query-keys";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { useSenderThreadMetadataById } from "./useSenderThreadMetadataById";
import { createQueryNotificationScheduler } from "@/test/queryNotificationScheduler";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

const notifications = createQueryNotificationScheduler();

const metadataSources = [
  {
    name: "sidebar",
    queryKey: sidebarNavigationQueryKey(),
    data: (thread: ThreadListEntry) =>
      makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ threads: [thread] })],
      }),
  },
  {
    name: "detail",
    queryKey: threadQueryKey("thr_sender"),
    data: (thread: ThreadListEntry) => thread,
  },
  {
    name: "list",
    queryKey: threadsQueryKey(),
    data: (thread: ThreadListEntry) => [thread],
  },
];

function renderMetadataHook(queryClient: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return renderHook(() => useSenderThreadMetadataById(), { wrapper: Wrapper });
}

beforeEach(() => notifications.install());

afterEach(() => {
  cleanup();
  notifications.restore();
});

describe("useSenderThreadMetadataById", () => {
  it.each(metadataSources)(
    "does not read all metadata for $name fetch, invalidation, error or status events",
    async ({ queryKey, data }) => {
      const queryClient = new QueryClient();
      const titleReads = vi.fn(() => "Sender thread");
      const thread = makeThreadListEntry();
      Object.defineProperty(thread, "title", { get: titleReads });
      queryClient.setQueryData<unknown>(queryKey, data(thread));
      const { result } = renderMetadataHook(queryClient);
      const initial = result.current;
      titleReads.mockClear();
      const failure = new Error("Refresh failed");

      await act(async () => {
        const fetchResult = await queryClient
          .fetchQuery({
            queryKey,
            queryFn: async () => {
              throw failure;
            },
            retry: false,
          })
          .catch((error: unknown) => error);

        expect(fetchResult).toBe(failure);
        await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
        const status = { status: "success" as const };
        Object.setPrototypeOf(status, {
          data: data(makeThreadListEntry({ title: "Inherited data" })),
        });
        queryClient.getQueryCache().find({ queryKey })!.setState(status);
        queryClient.getQueryCache().build(queryClient, {
          queryKey: [queryKey[0], "empty"],
        });
        queryClient.setQueryData(["unrelated"], []);
        queryClient.removeQueries({ queryKey: ["unrelated"] });
      });
      await notifications.flush();

      expect(result.current).toBe(initial);
      expect(result.current.get("thr_sender")?.title).toBe("Sender thread");
      expect(titleReads).not.toHaveBeenCalled();
    },
  );

  it.each(metadataSources)(
    "tracks hydrated $name data, explicit data updates and clearing",
    async ({ queryKey, data }) => {
      const queryClient = new QueryClient();
      const { result } = renderMetadataHook(queryClient);
      const persisted = new QueryClient();
      persisted.setQueryData<unknown>(queryKey, data(makeThreadListEntry()));

      await act(async () => hydrate(queryClient, dehydrate(persisted)));
      await notifications.flush();
      expect(result.current.get("thr_sender")?.title).toBe("Sender thread");

      await act(async () => {
        queryClient
          .getQueryCache()
          .find({ queryKey })!
          .setState({
            data: data(
              makeThreadListEntry({
                projectId: "proj_changed",
                title: "  ",
                titleFallback: "  Fallback title  ",
                originKind: "fork",
                originPluginId: "plugin_sender",
                visibility: "hidden",
              }),
            ),
          });
      });
      await notifications.flush();
      expect(result.current.get("thr_sender")).toEqual({
        projectId: "proj_changed",
        title: "Fallback title",
        originKind: "fork",
        originPluginId: "plugin_sender",
        visibility: "hidden",
      });

      await act(async () => {
        queryClient
          .getQueryCache()
          .find({ queryKey })!
          .setState({ data: undefined });
      });
      await notifications.flush();
      expect(result.current.size).toBe(0);
    },
  );

  it("preserves source precedence and falls back when cached queries are removed", async () => {
    const queryClient = new QueryClient();

    for (const source of metadataSources) {
      queryClient.setQueryData<unknown>(
        source.queryKey,
        source.data(makeThreadListEntry({ title: source.name })),
      );
    }

    const { result } = renderMetadataHook(queryClient);
    expect(result.current.get("thr_sender")?.title).toBe("sidebar");

    await act(async () => {
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        metadataSources[0]!.data(
          makeThreadListEntry({ title: null, titleFallback: null }),
        ),
      );
    });
    await notifications.flush();
    expect(result.current.get("thr_sender")?.title).toBe("detail");

    for (const [queryKey, title] of [
      [sidebarNavigationQueryKey(), "detail"],
      [threadQueryKey("thr_sender"), "list"],
      [threadsQueryKey(), undefined],
    ] as const) {
      await act(async () => queryClient.removeQueries({ queryKey }));
      await notifications.flush();
      expect(result.current.get("thr_sender")?.title).toBe(title);
    }
  });

  it("keeps the same map reference when a cache event rebuilds equal metadata", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
    ]);
    const { result } = renderMetadataHook(queryClient);
    const initial = result.current;
    expect(initial.get("thr_sender")?.title).toBe("Sender thread");
    expect(initial.get("thr_sender")?.projectId).toBe("proj_test");

    await act(async () => {
      queryClient.setQueryData(threadsQueryKey(), [
        makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
      ]);
    });
    await notifications.flush();

    expect(result.current).toBe(initial);
  });

  it("returns a new map when thread metadata actually changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: null }),
    ]);
    const { result } = renderMetadataHook(queryClient);
    const initial = result.current;
    expect(initial.get("thr_sender")?.title).toBeNull();

    await act(async () => {
      queryClient.setQueryData(threadsQueryKey(), [
        makeThreadListEntry({ id: "thr_sender", title: "Titled later" }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.get("thr_sender")?.title).toBe("Titled later");
    });
    expect(result.current).not.toBe(initial);
  });
});
