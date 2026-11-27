import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { PluginEnvironmentProviderCreateContext } from "@omnyo/plugin-sdk/environment-provider";
import plugin from "./server.js";

const caller = {
  experimental_caller: { kind: "plugin", pluginId: "omnyo--storage-retention" },
} as const;

const result = {
  status: "completed",
  sharedFiles: 2,
  privateBytesReleased: 8192,
  skippedFiles: 0,
  skippedWorktrees: [],
} as const;

const context: PluginEnvironmentProviderCreateContext = {
  thread: makeThreadResponse({ id: "thread", projectId: "project" }),
  project: {
    id: "project",
    kind: "standard",
    name: "project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
  },
  host: makeHostResponse({ id: "host" }),
  projectCheckout: { path: "/source", experimental_ownsPath: false },
  gitRemote: null,
  inputs: { branch: { kind: "default" } },
  suggestedBranchName: "feature",
  attempt: 1,
  pathKey: "thread",
  experimental_claimPath: async () => true,
  report: { step: () => {}, log: () => {} },
  signal: new AbortController().signal,
};

describe("worktree storage sharing policy", () => {
  it.each([undefined, false, true])(
    "passes the current persisted setting %s to managed creation",
    async (value) => {
      const { api, harness } = createFakePluginHost({
        settings: value === undefined ? {} : { shareWorktreeStorage: value },
        experimental_callHostRpc: () => ({
          status: "created",
          path: "/target",
          baseBranch: "main",
        }),
      });

      await plugin(api);

      const provider =
        harness.registrations.environmentProviders.get("git-worktree");

      if (!provider) throw new Error("Provider not registered");
      await provider.create(context);
      expect(harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
        shareWorktreeStorage: value ?? true,
      });
    },
  );

  it("cancels sharing after opt-out without aborting checkout creation", async () => {
    let finish: (value: unknown) => void = () => {};

    let creates = 0;

    const { api, harness } = createFakePluginHost({
      experimental_callHostRpc: ({ method }) => {
        if (method !== "create") return { cancelled: true };

        if (creates++ > 0)
          return { status: "created", path: "/target", baseBranch: "main" };

        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });

    await plugin(api);

    const provider =
      harness.registrations.environmentProviders.get("git-worktree");

    if (!provider) throw new Error("Provider not registered");
    const creating = provider.create(context);
    await vi.waitFor(() =>
      expect(harness.experimental_hostRpcCalls).toHaveLength(1),
    );
    await harness.setSettings({ shareWorktreeStorage: false });
    await vi.waitFor(() =>
      expect(harness.experimental_hostRpcCalls).toHaveLength(2),
    );
    expect(harness.experimental_hostRpcCalls[1]).toMatchObject({
      method: "cancelStorageSharing",
      input: { operationId: "create#thread#1" },
    });
    expect(context.signal.aborted).toBe(false);
    finish({ status: "created", path: "/target", baseBranch: "main" });
    await expect(creating).resolves.toMatchObject({ status: "created" });
    await provider.create({ ...context, attempt: 2 });
    expect(harness.experimental_hostRpcCalls.at(-1)?.input).toMatchObject({
      shareWorktreeStorage: false,
    });
  });

  it("restricts manual sharing and applies the off switch before host dispatch", async () => {
    const { api, harness } = createFakePluginHost({
      settings: { shareWorktreeStorage: false },
    });

    await plugin(api);

    const input = {
      hostId: "host",
      worktrees: [{ sourcePath: "/source", path: "/target" }],
    };

    await expect(
      harness.callRpc("reclaimWorktreeStorage", input),
    ).rejects.toThrow("Only Storage Retention");
    await expect(
      harness.callRpc("reclaimWorktreeStorage", input, caller),
    ).resolves.toMatchObject({
      status: "disabled",
      sharedFiles: 0,
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("cancels only the selected machine's manual operation and preserves its result counters", async () => {
    let finish: (value: unknown) => void = () => {};

    const { api, harness } = createFakePluginHost({
      sdk: {
        projects: {
          list: () => [
            {
              sources: [
                { type: "local_path", hostId: "host", path: "/source" },
              ],
            },
          ],
        },
        environments: { list: () => [] },
        threads: { list: () => [] },
      },
      experimental_callHostRpc: ({ method }) => {
        if (method === "cancelStorageSharing") return { cancelled: true };

        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });

    await plugin(api);

    const reclaiming = harness.callRpc(
      "reclaimWorktreeStorage",
      {
        hostId: "host",
        worktrees: [{ sourcePath: "/source", path: "/target" }],
      },
      caller,
    );

    await vi.waitFor(() =>
      expect(harness.experimental_hostRpcCalls).toHaveLength(1),
    );
    await expect(
      harness.callRpc("cancelWorktreeStorage", { hostId: "other" }, caller),
    ).resolves.toEqual({ cancelled: false });
    await expect(
      harness.callRpc("cancelWorktreeStorage", { hostId: "host" }, caller),
    ).resolves.toEqual({ cancelled: true });
    expect(harness.experimental_hostRpcCalls[1]).toMatchObject({
      method: "cancelStorageSharing",
      hostId: "host",
    });
    expect(harness.experimental_hostRpcCalls[1]?.input).toEqual({
      operationId: expect.any(String),
    });
    finish({ ...result, status: "cancelled" });
    await expect(reclaiming).resolves.toMatchObject({
      status: "cancelled",
      sharedFiles: 2,
      privateBytesReleased: 8192,
    });
  });

  it("rechecks configured sources and active environment ownership before dispatch", async () => {
    const { api, harness } = createFakePluginHost({
      sdk: {
        projects: {
          list: () => [
            {
              sources: [
                { type: "local_path", hostId: "host", path: "/source" },
              ],
            },
          ],
        },
        environments: {
          list: () => [
            { path: "/busy", hostLifecycle: "active", status: "ready" },
          ],
        },
        threads: { list: () => [] },
      },
      experimental_callHostRpc: () => result,
    });

    await plugin(api);

    const reclaimed = await harness.callRpc(
      "reclaimWorktreeStorage",
      {
        hostId: "host",
        worktrees: [
          { sourcePath: "/source", path: "/idle" },
          { sourcePath: "/source", path: "/busy" },
          { sourcePath: "/unknown", path: "/foreign" },
          { sourcePath: "/source", path: "/source" },
        ],
      },
      caller,
    );

    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "reclaimWorktreeStorage",
      hostId: "host",
      input: {
        worktrees: [{ sourcePath: "/source", path: "/idle" }],
        protectedPaths: ["/busy"],
      },
    });
    expect(reclaimed).toMatchObject({
      ...result,
      skippedWorktrees: expect.arrayContaining([
        { path: "/busy", reason: expect.stringContaining("active") },
        { path: "/foreign", reason: expect.stringContaining("configured") },
        {
          path: "/source",
          reason: expect.stringContaining("project checkout"),
        },
      ]),
    });
  });
});
