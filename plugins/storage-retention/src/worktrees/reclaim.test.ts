import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { makeSystemConfig } from "../../../../apps/app/src/test/fixtures/system-config.js";
import plugin from "../server.js";
import { scanInventory } from "./contract.js";

const selected = {
  projectId: "project",
  repo: "/remote/repo",
  path: "/remote/idle",
};

const completed = {
  status: "completed",
  sharedFiles: 3,
  privateBytesReleased: 4096,
  volumeFreeBytesChange: -12288,
  skippedFiles: 2,
  skippedWorktrees: [],
};

function inventory() {
  return scanInventory.parse({
    entries: [
      {
        projectId: "project",
        projectName: "Project",
        path: selected.repo,
        error: null,
        repo: {
          path: selected.repo,
          base: "main",
          branches: [],
          worktrees: [selected.repo, selected.path].map((path) => ({
            path,
            head: "abc",
            branch: "main",
            locked: false,
            missing: false,
            bare: false,
            error: null,
            dirty: false,
            dirtyFiles: [],
            ignored: false,
            ahead: 0,
            behind: 0,
            storage: {
              status: "measured",
              allocatedBytes: 8192,
              reclaimableBytes: 8192,
              measuredAt: "2026-11-27T00:00:00Z",
              error: null,
            },
            purgeReady: true,
            preserveIn: "main",
            reasons: [],
          })),
        },
      },
    ],
    issues: [],
    scannedAt: "2026-11-27T00:00:00Z",
  });
}

function fixture() {
  let current = inventory();

  const callRpc = vi.fn(
    async (_input: { method: string }): Promise<unknown> => completed,
  );

  const read = vi.fn(async () => current);

  const host = createFakePluginHost({
    pluginId: "omnyo--storage-retention",
    experimental_hostEntry: true,
    experimental_callHostRpc: read,
    sdk: {
      system: {
        config: async () => makeSystemConfig({ primaryHostId: "coordinator" }),
      },
      projects: { list: async () => [] },
      environments: { list: async () => [] },
      threads: { list: async () => [] },
      plugins: { callRpc },
    },
  });

  plugin(host.api);

  return {
    ...host,
    callRpc,
    read,
    change: (next: typeof current) => {
      current = next;
    },
  };
}

it("revalidates selected identities on the selected host and only calls Worktree sharing", async () => {
  const f = fixture();

  try {
    await f.harness.callRpc("hostInventory", { hostId: "remote" });
    expect(
      await f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [selected, selected],
      }),
    ).toEqual(completed);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(
      f.harness.experimental_hostRpcCalls.every(
        (call) => call.hostId === "remote" && call.method === "inventory",
      ),
    ).toBe(true);
    expect(f.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "environment-git-worktree",
        method: "reclaimWorktreeStorage",
        input: {
          hostId: "remote",
          worktrees: [{ sourcePath: selected.repo, path: selected.path }],
        },
      }),
    );
  } finally {
    await f.harness.dispose();
  }
});

it("skips stale, locked and primary selections while still checking the sharing setting", async () => {
  const f = fixture();

  try {
    await f.harness.callRpc("hostInventory", { hostId: "remote" });
    const changed = inventory();
    changed.entries[0]!.repo!.worktrees[1]!.locked = true;
    f.change(changed);

    const result = await f.harness.callRpc("reclaimSpace", {
      hostId: "remote",
      worktrees: [
        selected,
        { ...selected, path: selected.repo },
        { ...selected, path: "/remote/gone" },
      ],
    });

    expect(result).toMatchObject({
      skippedWorktrees: [
        { path: selected.path, reason: expect.stringContaining("locked") },
        { path: selected.repo, reason: expect.stringContaining("primary") },
        { path: "/remote/gone", reason: expect.stringContaining("no longer") },
      ],
    });
    expect(f.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({ input: { hostId: "remote", worktrees: [] } }),
    );
  } finally {
    await f.harness.dispose();
  }
});

it("surfaces disabled sharing and host failures without invoking removal", async () => {
  const f = fixture();

  try {
    f.callRpc.mockResolvedValueOnce({
      ...completed,
      status: "disabled",
      sharedFiles: 0,
      privateBytesReleased: 0,
    });
    expect(
      await f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [selected],
      }),
    ).toMatchObject({ status: "disabled" });
    f.callRpc.mockRejectedValueOnce(new Error("remote unavailable"));
    await expect(
      f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [selected],
      }),
    ).rejects.toThrow("remote unavailable");
    expect(
      await f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [selected],
      }),
    ).toEqual(completed);
    expect(
      f.harness.experimental_hostRpcCalls.every(
        (call) => call.method === "inventory",
      ),
    ).toBe(true);
  } finally {
    await f.harness.dispose();
  }
});

it("cancels during inventory without admitting native work", async () => {
  const f = fixture();
  let finish: (result: ReturnType<typeof inventory>) => void = () => {};

  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  try {
    const pending = f.harness.callRpc("reclaimSpace", {
      hostId: "remote",
      worktrees: [selected],
    });

    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    expect(
      await f.harness.callRpc("cancelReclaim", { hostId: "remote" }),
    ).toEqual({ cancelled: true });
    finish(inventory());
    expect(await pending).toMatchObject({
      status: "cancelled",
      sharedFiles: 0,
    });
    expect(f.callRpc).not.toHaveBeenCalled();
  } finally {
    finish(inventory());
    await f.harness.dispose();
  }
});

it("forwards cancellation to the admitted host operation and rejects duplicate admission", async () => {
  const f = fixture();
  let finish: (result: typeof completed) => void = () => {};

  f.callRpc.mockImplementation(async ({ method }) => {
    if (method === "cancelWorktreeStorage") return { cancelled: true };

    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  try {
    const pending = f.harness.callRpc("reclaimSpace", {
      hostId: "remote",
      worktrees: [selected],
    });

    await vi.waitFor(() => expect(f.callRpc).toHaveBeenCalledOnce());
    await expect(
      f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [selected],
      }),
    ).rejects.toThrow("already running");
    expect(
      await f.harness.callRpc("cancelReclaim", { hostId: "remote" }),
    ).toEqual({ cancelled: true });
    expect(f.callRpc).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "cancelWorktreeStorage",
        input: { hostId: "remote" },
      }),
    );
    finish({ ...completed, status: "cancelled" });
    expect(await pending).toMatchObject({ status: "cancelled" });
  } finally {
    finish(completed);
    await f.harness.dispose();
  }
});

it("rejects injected roots and nested hosts and never forwards unregistered paths", async () => {
  const f = fixture();

  try {
    await expect(
      f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        root: "/",
        worktrees: [selected],
      }),
    ).rejects.toThrow();
    await expect(
      f.harness.callRpc("reclaimSpace", {
        hostId: "remote",
        worktrees: [{ ...selected, hostId: "coordinator" }],
      }),
    ).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.callRpc).not.toHaveBeenCalled();
    await f.harness.callRpc("reclaimSpace", {
      hostId: "remote",
      worktrees: [{ ...selected, repo: "/forged/repo", path: "/forged/path" }],
    });
    expect(f.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { hostId: "remote", worktrees: [] },
      }),
    );
  } finally {
    await f.harness.dispose();
  }
});

it("admits an idle worktree with edits so the host can preserve user files and share eligible files", async () => {
  const f = fixture();

  try {
    const changed = inventory();
    changed.entries[0]!.repo!.worktrees[1]!.dirty = true;
    changed.entries[0]!.repo!.worktrees[1]!.dirtyFiles = [
      "edited.txt",
      "untracked.txt",
    ];
    f.change(changed);
    await f.harness.callRpc("reclaimSpace", {
      hostId: "remote",
      worktrees: [selected],
    });
    expect(f.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          hostId: "remote",
          worktrees: [{ sourcePath: selected.repo, path: selected.path }],
        },
      }),
    );
  } finally {
    await f.harness.dispose();
  }
});
