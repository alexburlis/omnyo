import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  makeEnvironment,
  makeThreadListEntry,
  makeThreadWithRuntime,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  archivedThreadsListQueryKey,
  environmentQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import {
  beginArchiveThreadAndChildrenTransaction,
  beginThreadShelfTransaction,
  beginUnarchiveThreadTransaction,
  rollbackArchiveThreadsTransaction,
  rollbackThreadListMutationTransaction,
  rollbackThreadMetadataBatchTransaction,
} from "./thread-state-cache-owner";

function projectNavigation(threads: ReturnType<typeof makeThreadListEntry>[]) {
  return makeSidebarBootstrapResponse({
    orderedProjectIds: ["project-1"],
    projects: [makeProjectWithThreadsResponse({ id: "project-1", threads })],
  });
}

function pageIds(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient
    .getQueryData<{ pages: { id: string }[][] }>(queryKey)
    ?.pages.flat()
    .map(({ id }) => id);
}

function navigationThreads(queryClient: QueryClient) {
  return queryClient.getQueryData<ReturnType<typeof projectNavigation>>(
    sidebarNavigationQueryKey(),
  )?.projects[0]?.threads;
}

describe("sidebar archive cache", () => {
  it.each(["project-1", "proj_personal"])(
    "keeps a restored row in its sidebar hierarchy before the server responds (%s)",
    async (projectId) => {
      const queryClient = new QueryClient();
      const archivedKey = archivedThreadsListQueryKey({});

      const archived = makeThreadListEntry({
        id: "archived",
        projectId,
        archivedAt: 100,
        parentThreadId: "parent",
        sectionId: "section-1",
        pinnedAt: 10,
        pinSortKey: "a0",
        environmentId: "environment-1",
        environmentHostId: "host-1",
        latestAttentionAt: 20,
        createdAt: 5,
      });

      const neighbor = makeThreadListEntry({ id: "parent", projectId });

      const navigation = makeSidebarBootstrapResponse({
        orderedProjectIds: ["proj_personal", "project-1"],
        projects: [
          makeProjectWithThreadsResponse({
            id: "project-1",
            threads: projectId === "project-1" ? [neighbor] : [],
          }),
        ],
        personalProject: makeProjectWithThreadsResponse({
          id: "proj_personal",
          kind: "personal",
          threads: projectId === "proj_personal" ? [neighbor] : [],
        }),
      });

      const pages = { pages: [[archived]], pageParams: [0] };
      queryClient.setQueryData(archivedKey, pages);
      queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);

      const transaction = await beginUnarchiveThreadTransaction({
        queryClient,
        threadId: archived.id,
      });

      const next = queryClient.getQueryData<typeof navigation>(
        sidebarNavigationQueryKey(),
      )!;

      const destination =
        projectId === "proj_personal" ? next.personalProject : next.projects[0];

      expect(next.orderedProjectIds).toEqual(navigation.orderedProjectIds);

      const other =
        projectId === "proj_personal" ? next.projects[0] : next.personalProject;

      expect(destination?.threads).toEqual([
        neighbor,
        { ...archived, archivedAt: null },
      ]);
      expect(other?.threads).toEqual([]);
      expect(queryClient.getQueryData(archivedKey)).toMatchObject({
        pages: [[]],
      });

      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: archived.id,
        transaction,
      });
      expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toEqual(
        navigation,
      );
      expect(queryClient.getQueryData(archivedKey)).toEqual(pages);
    },
  );

  it("restores a row archived in this session when no list still caches it", async () => {
    const queryClient = new QueryClient();

    const archived = makeThreadListEntry({
      id: "archived",
      projectId: "project-1",
    });

    const neighbor = makeThreadListEntry({
      id: "neighbor",
      projectId: "project-1",
    });

    const navigation = (threads: (typeof archived)[]) =>
      makeSidebarBootstrapResponse({
        orderedProjectIds: ["project-1"],
        projects: [
          makeProjectWithThreadsResponse({ id: "project-1", threads }),
        ],
      });

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      navigation([neighbor, archived]),
    );
    await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: archived.id,
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      navigation([neighbor]),
    );

    await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: archived.id,
    });

    expect(
      queryClient.getQueryData<ReturnType<typeof navigation>>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads,
    ).toEqual([neighbor, { ...archived, archivedAt: null }]);
  });

  it("shows a just-archived chat at the top of matching archived lists until rollback", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const root = makeThreadListEntry({ id: "root", projectId: "project-1" });

    const older = makeThreadListEntry({
      id: "older",
      projectId: "project-1",
      archivedAt: 5,
    });

    const keys = {
      all: archivedThreadsListQueryKey({}),
      project: archivedThreadsListQueryKey({ projectId: "project-1" }),
      otherProject: archivedThreadsListQueryKey({ projectId: "project-2" }),
      children: archivedThreadsListQueryKey({ kind: "child" }),
    };

    const pages = { pages: [[older]], pageParams: [0] };

    for (const key of Object.values(keys)) queryClient.setQueryData(key, pages);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      projectNavigation([root]),
    );

    const transaction = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: root.id,
    });

    expect(pageIds(queryClient, keys.all)).toEqual(["root", "older"]);
    expect(pageIds(queryClient, keys.project)).toEqual(["root", "older"]);
    expect(pageIds(queryClient, keys.otherProject)).toEqual(["older"]);
    expect(pageIds(queryClient, keys.children)).toEqual(["older"]);
    expect(
      queryClient.getQueryData<typeof pages>(keys.all)?.pages[0]?.[0]
        ?.archivedAt,
    ).toEqual(expect.any(Number));

    await queryClient.fetchQuery({
      queryKey: keys.all,
      queryFn: async () => pages,
      staleTime: 0,
    });

    expect(pageIds(queryClient, keys.all)).toEqual(["root", "older"]);

    rollbackArchiveThreadsTransaction({ queryClient, transaction });

    for (const key of Object.values(keys))
      expect(queryClient.getQueryData(key)).toEqual(pages);
    expect(navigationThreads(queryClient)).toEqual([root]);
  });

  it("restores an unarchived chat from its cached detail when no list holds it", async () => {
    const queryClient = new QueryClient();

    const neighbor = makeThreadListEntry({
      id: "neighbor",
      projectId: "project-1",
    });

    const navigation = projectNavigation([neighbor]);
    queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    queryClient.setQueryData(
      threadQueryKey("archived"),
      makeThreadWithRuntime({
        id: "archived",
        projectId: "project-1",
        environmentId: "env-1",
        archivedAt: 100,
      }),
    );
    queryClient.setQueryData(
      environmentQueryKey("env-1"),
      makeEnvironment({
        id: "env-1",
        hostId: "host-1",
        name: "Workspace",
        branchName: "feature",
      }),
    );

    const transaction = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: "archived",
    });

    expect(navigationThreads(queryClient)).toEqual([
      neighbor,
      expect.objectContaining({
        id: "archived",
        archivedAt: null,
        environmentHostId: "host-1",
        environmentName: "Workspace",
        environmentBranchName: "feature",
        queuedWork: "none",
      }),
    ]);

    rollbackThreadListMutationTransaction({
      queryClient,
      threadId: "archived",
      transaction,
    });

    expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toEqual(
      navigation,
    );
  });

  it("moves a shelved family into the cached Shelf and marks the root read until rollback", async () => {
    const queryClient = new QueryClient();

    const root = makeThreadListEntry({
      id: "root",
      projectId: "project-1",
      lastReadAt: null,
      latestAttentionAt: 50,
    });

    const child = makeThreadListEntry({
      id: "child",
      projectId: "project-1",
      parentThreadId: "root",
      lastReadAt: null,
    });

    const shelved = makeThreadListEntry({
      id: "shelved",
      projectId: "project-1",
      shelvedAt: 1,
      shelfSortKey: "a0",
    });

    const navigation = projectNavigation([root, child]);
    const shelf = { pages: [[shelved]], pageParams: [0] };
    queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    queryClient.setQueryData(shelvedThreadsListQueryKey(), shelf);
    queryClient.setQueryData(
      threadQueryKey("root"),
      makeThreadWithRuntime({
        id: "root",
        lastReadAt: null,
        latestAttentionAt: 50,
      }),
    );

    const before = Date.now();

    const transaction = await beginThreadShelfTransaction({
      queryClient,
      shelvedAt: before,
      threadId: "root",
    });

    expect(pageIds(queryClient, shelvedThreadsListQueryKey())).toEqual([
      "root",
      "child",
      "shelved",
    ]);
    expect(navigationThreads(queryClient)).toEqual([
      expect.objectContaining({
        id: "root",
        shelvedAt: before,
        lastReadAt: expect.any(Number),
      }),
      expect.objectContaining({
        id: "child",
        shelvedAt: before,
        lastReadAt: null,
      }),
    ]);
    expect(
      queryClient.getQueryData<{ lastReadAt: number | null }>(
        threadQueryKey("root"),
      )?.lastReadAt,
    ).toBeGreaterThanOrEqual(before);

    rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
    transaction.releasePendingPatches();

    expect(queryClient.getQueryData(shelvedThreadsListQueryKey())).toEqual(
      shelf,
    );
    expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toEqual(
      navigation,
    );
    expect(
      queryClient.getQueryData<{ lastReadAt: number | null }>(
        threadQueryKey("root"),
      )?.lastReadAt,
    ).toBeNull();
  });

  it("puts an unshelved family back into sidebar navigation until rollback", async () => {
    const queryClient = new QueryClient();

    const neighbor = makeThreadListEntry({
      id: "neighbor",
      projectId: "project-1",
    });

    const root = makeThreadListEntry({
      id: "root",
      projectId: "project-1",
      shelvedAt: 10,
      shelfSortKey: "a0",
    });

    const child = makeThreadListEntry({
      id: "child",
      projectId: "project-1",
      parentThreadId: "root",
      shelvedAt: 10,
      shelfSortKey: "a0",
    });

    const navigation = projectNavigation([neighbor]);
    queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    queryClient.setQueryData(shelvedThreadsListQueryKey(), {
      pages: [[root, child]],
      pageParams: [0],
    });

    const transaction = await beginThreadShelfTransaction({
      queryClient,
      shelvedAt: null,
      threadId: "root",
    });

    expect(navigationThreads(queryClient)).toEqual([
      neighbor,
      expect.objectContaining({ id: "root", shelvedAt: null }),
      expect.objectContaining({ id: "child", shelvedAt: null }),
    ]);

    rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
    transaction.releasePendingPatches();

    expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toEqual(
      navigation,
    );
  });
});
