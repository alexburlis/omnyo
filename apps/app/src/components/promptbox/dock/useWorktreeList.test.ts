// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  mergeWorktreeRows,
  useWorktreeList,
  type LocalWorktree,
} from "./useWorktreeList";

vi.mock("@/lib/sdk", () => ({
  sdk: { plugins: { callRpc: vi.fn() } },
}));

const MAC = "host_macpro";

const RTX3090 = "host_3090";

function environment(
  overrides: Partial<ReuseThreadOption> & { environmentId: string },
): ReuseThreadOption {
  return {
    branchName: null,
    name: null,
    path: null,
    environmentProviderId: "git-worktree",
    hostId: MAC,
    hostName: "Mac Pro",
    threads: [],
    ...overrides,
  };
}

const featureEnvironment = environment({
  environmentId: "env_feature",
  name: "Launcher dock",
  branchName: "launcher/dock",
  path: "/Users/developer/wt/launcher-dock",
});

const otherHostEnvironment = environment({
  environmentId: "env_3090",
  branchName: "gpu/bench",
  path: "/home/alex/wt/gpu-bench",
  hostId: RTX3090,
});

const local: readonly LocalWorktree[] = [
  { path: "/Users/developer/wt/detached-b", branch: null, prunable: false },
  { path: "/Users/developer/wt/zeta", branch: "zeta", prunable: false },
  {
    path: "/Users/developer/wt/launcher-dock",
    branch: "launcher/dock",
    prunable: false,
  },
  { path: "/Users/developer/wt/detached-a", branch: null, prunable: true },
  { path: "/Users/developer/wt/alpha", branch: "alpha", prunable: false },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mergeWorktreeRows", () => {
  it("lists the host's environments first, then named worktrees by branch, then detached ones by path", () => {
    expect(
      mergeWorktreeRows([featureEnvironment, otherHostEnvironment], local, MAC),
    ).toEqual([
      {
        kind: "environment",
        environmentId: "env_feature",
        label: "Launcher dock",
        branch: "launcher/dock",
        path: "/Users/developer/wt/launcher-dock",
      },
      {
        kind: "local",
        path: "/Users/developer/wt/alpha",
        branch: "alpha",
        prunable: false,
      },
      {
        kind: "local",
        path: "/Users/developer/wt/zeta",
        branch: "zeta",
        prunable: false,
      },
      {
        kind: "local",
        path: "/Users/developer/wt/detached-a",
        branch: null,
        prunable: true,
      },
      {
        kind: "local",
        path: "/Users/developer/wt/detached-b",
        branch: null,
        prunable: false,
      },
    ]);
  });

  it("labels an unnamed environment by its branch", () => {
    expect(
      mergeWorktreeRows(
        [
          environment({
            environmentId: "env_branch",
            branchName: "fix/escape",
          }),
        ],
        [],
        MAC,
      ),
    ).toEqual([
      {
        kind: "environment",
        environmentId: "env_branch",
        label: "fix/escape",
        branch: "fix/escape",
        path: null,
      },
    ]);
  });
});

describe("useWorktreeList", () => {
  function renderList(enabled: boolean) {
    const { wrapper } = createQueryClientTestHarness();

    return renderHook(
      () =>
        useWorktreeList({
          projectId: "proj_omnyo",
          hostId: MAC,
          hostName: "Mac Pro",
          environments: [featureEnvironment],
          enabled,
        }),
      { wrapper },
    );
  }

  it("asks the worktree plugin for this project's worktrees on this machine", async () => {
    vi.mocked(sdk.plugins.callRpc).mockResolvedValue({
      worktrees: [
        { path: "/Users/developer/wt/alpha", branch: "alpha", prunable: false },
      ],
    });

    const { result } = renderList(true);

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(vi.mocked(sdk.plugins.callRpc).mock.calls[0]?.[0]).toMatchObject({
      pluginId: "environment-git-worktree",
      method: "listExistingWorktrees",
      input: { projectId: "proj_omnyo", hostId: MAC },
    });
    expect(result.current.rows.map((row) => row.kind)).toEqual([
      "environment",
      "local",
    ]);
  });

  it("keeps environments listed and names the machine when listing fails", async () => {
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(new Error("Host offline"));

    const { result } = renderList(true);

    await waitFor(() => expect(result.current.status).toBe("failed"));

    expect(result.current).toEqual({
      status: "failed",
      message: "Couldn't list worktrees on the Mac Pro.",
      rows: [
        {
          kind: "environment",
          environmentId: "env_feature",
          label: "Launcher dock",
          branch: "launcher/dock",
          path: "/Users/developer/wt/launcher-dock",
        },
      ],
    });
  });

  it("does not call the plugin until the list is wanted", () => {
    const { result } = renderList(false);

    expect(sdk.plugins.callRpc).not.toHaveBeenCalled();
    expect(result.current.status).toBe("loading");
    expect(result.current.rows).toHaveLength(1);
  });
});
