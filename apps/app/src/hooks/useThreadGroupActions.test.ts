import { QueryClient } from "@tanstack/react-query";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { getChatSelection, setChatSelection } from "@/lib/chat-selection";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { createThreadGroupActions } from "./useThreadGroupActions";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({
  threadGroups: { create: vi.fn(), delete: vi.fn(), update: vi.fn() },
  threads: { update: vi.fn() },
}));

vi.mock("@/components/ui/app-toast", () => ({ appToast: toast }));

vi.mock("@/lib/sdk", () => ({ sdk: sdkMocks }));

const group = {
  id: "grp_models",
  projectId: "proj_paraspeech",
  name: "CUSTOM MODEL",
  createdAt: 1,
  updatedAt: 1,
};

function seededClient(
  groupIds: Readonly<Record<string, string | null>> = {},
  groups: SidebarBootstrapResponse["groups"] = [],
) {
  const queryClient = new QueryClient();

  const chat = (id: string, title: string, projectId: string) =>
    makeThreadListEntry({
      id,
      projectId,
      title,
      parentThreadId: null,
      groupId: groupIds[id] ?? null,
    });

  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      groups,
      projects: [
        makeProjectWithThreadsResponse({
          id: "proj_paraspeech",
          threads: [
            chat("thr_commander", "COMMANDER CUSTOM MODEL", "proj_paraspeech"),
            chat("thr_e4b", "E4B CUSTOM MODEL", "proj_paraspeech"),
          ],
        }),
        makeProjectWithThreadsResponse({
          id: "proj_other",
          threads: [chat("thr_other", "Landing SEO", "proj_other")],
        }),
      ],
    }),
  );

  return queryClient;
}

function cachedGroupIds(queryClient: QueryClient) {
  return Object.fromEntries(
    getCachedSidebarNavigationThreads(queryClient).map((chat) => [
      chat.id,
      chat.groupId,
    ]),
  );
}

function cachedGroups(queryClient: QueryClient) {
  return queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  )?.groups;
}

afterEach(() => {
  setChatSelection([]);
  vi.clearAllMocks();
});

describe("createThreadGroupActions", () => {
  it("groups the selection's chats from the first chat's project under a shared name", async () => {
    const queryClient = seededClient();
    setChatSelection(["thr_commander", "thr_e4b", "thr_other"]);
    sdkMocks.threadGroups.create.mockResolvedValue({
      group,
      threadIds: ["thr_commander", "thr_e4b"],
    });

    const groupId = await createThreadGroupActions(queryClient).group([
      "thr_commander",
      "thr_e4b",
      "thr_other",
    ]);

    expect(groupId).toBe("grp_models");
    expect(sdkMocks.threadGroups.create).toHaveBeenCalledWith({
      name: "CUSTOM MODEL",
      threadIds: ["thr_commander", "thr_e4b"],
    });
    expect(cachedGroups(queryClient)).toEqual([group]);
    expect(cachedGroupIds(queryClient)).toEqual({
      thr_commander: "grp_models",
      thr_e4b: "grp_models",
      thr_other: null,
    });
    expect(getChatSelection()).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith(
      "Grouped 2 chats as “CUSTOM MODEL”",
      expect.objectContaining({
        description:
          "Left out 1 chat from another project or under another chat.",
        undo: expect.any(Function),
      }),
    );
  });

  it("does nothing for a selection with no top-level chats", async () => {
    const queryClient = seededClient();

    await expect(
      createThreadGroupActions(queryClient).group(["thr_missing"]),
    ).resolves.toBeNull();
    expect(sdkMocks.threadGroups.create).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
  });

  it("ungroups at once and restores the group when the server refuses", async () => {
    const queryClient = seededClient(
      { thr_commander: "grp_models", thr_e4b: "grp_models" },
      [group],
    );

    sdkMocks.threadGroups.delete.mockRejectedValue(new Error("offline"));

    const pending = createThreadGroupActions(queryClient).ungroup("grp_models");

    await expect(pending).rejects.toThrow("offline");
    expect(cachedGroups(queryClient)).toEqual([group]);
    expect(cachedGroupIds(queryClient)).toMatchObject({
      thr_commander: "grp_models",
      thr_e4b: "grp_models",
    });
    expect(toast.error).toHaveBeenCalledWith("Couldn't ungroup", {
      description: "offline",
    });
  });

  it("moves one chat out of its group", async () => {
    const queryClient = seededClient(
      { thr_commander: "grp_models", thr_e4b: "grp_models" },
      [group],
    );

    sdkMocks.threads.update.mockImplementation(
      async ({ threadId }: { threadId: string }) => ({
        ...makeThreadListEntry({ id: threadId, projectId: "proj_paraspeech" }),
        groupId: null,
      }),
    );

    await createThreadGroupActions(queryClient).move("thr_e4b", null);

    expect(sdkMocks.threads.update).toHaveBeenCalledWith({
      threadId: "thr_e4b",
      groupId: null,
    });
    expect(cachedGroupIds(queryClient)).toMatchObject({
      thr_commander: "grp_models",
      thr_e4b: null,
    });
  });
});
