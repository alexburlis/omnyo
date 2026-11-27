import { afterEach, expect, it, vi } from "vitest";
import { getHost, updateHost } from "@omnyo/db";
import type {
  HostDaemonCommand,
  HostDaemonRpcCommand,
} from "@omnyo/host-daemon-contract";
import {
  callHostOnlineRpc,
  callHostOnlineRpcForWork,
} from "../../src/services/hosts/online-rpc.js";
import { runLiveHostCommand } from "../../src/services/hosts/live-command.js";
import { runLiveCommandAndWait } from "../../src/services/hosts/live-command-wait.js";
import { profileDesktopRenderer } from "../../src/services/desktop-browsers.js";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { installMachineProvider } from "../helpers/machine-provider.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const target = {
  threadId: "thread-policy",
  environmentId: "environment-policy",
};

const commands: HostDaemonCommand[] = [
  {
    ...target,
    type: "thread.archive",
    workspaceContext: { workspacePath: "/tmp/policy" },
    providerId: "codex",
    providerThreadId: "provider-thread",
    bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
  },
  {
    ...target,
    type: "thread.unarchive",
    providerId: "codex",
    providerThreadId: "provider-thread",
    bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
  },
  { ...target, type: "thread.rename", title: "New title" },
  { ...target, type: "thread.plan.cancel", expectedTurnId: "turn-policy" },
  { ...target, type: "thread.rewind.discard", leaseId: "lease-policy" },
];

afterEach(() => {
  vi.restoreAllMocks();
  setPluginMachineProviderBridge(undefined);
});

it("does not wake a suspended machine for renderer profiling or its capability discovery", async () =>
  withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps, {
      id: "renderer-profile-policy",
    });

    const resume = vi.fn(async () => ({ resource: { id: "restored" } }));

    installMachineProvider({
      resume,
      suspend: async () => ({ resource: { id: "saved" } }),
    });
    updateHost(harness.db, harness.hub, host.id, {
      machineProviderId: "test-machine",
      phase: "suspended",
      resource: { id: "saved" },
      suspendedAt: 1,
    });

    const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");

    const input = {
      hostId: host.id,
      instanceId: "window-policy",
      generation: "generation-policy",
      durationMs: 2000,
    };

    await expect(
      profileDesktopRenderer(harness.deps, input),
    ).rejects.toMatchObject({
      body: { code: "host_unavailable" },
    });
    await expect(
      callHostOnlineRpcForWork(harness.deps, {
        hostId: host.id,
        timeoutMs: 100,
        command: {
          type: "desktop.browser.profile_renderer",
          instanceId: input.instanceId,
          generation: input.generation,
          durationMs: input.durationMs,
        },
      }),
    ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
    expect(resume).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(getHost(harness.db, host.id)?.phase).toBe("suspended");
  }));

it.each(commands)(
  "does not wake for $type through either live command dispatcher",
  async (command) =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "non-waking-command",
      });

      const resume = vi.fn(async () => ({ resource: { id: "restored" } }));
      installMachineProvider({
        resume,
        suspend: async () => ({ resource: { id: "saved" } }),
      });
      updateHost(harness.db, harness.hub, host.id, {
        machineProviderId: "test-machine",
        phase: "suspended",
        resource: { id: "saved" },
        suspendedAt: 1,
      });
      const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");

      for (const run of [runLiveHostCommand, runLiveCommandAndWait]) {
        await expect(
          run(harness.deps, { hostId: host.id, command, timeoutMs: 100 }),
        ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
      }

      expect(resume).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(getHost(harness.db, host.id)?.phase).toBe("suspended");
    }),
);

it("only wakes a workspace preflight when its caller explicitly requests work", async () =>
  withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps, { id: "explicit-work" });
    const resume = vi.fn(async () => ({ resource: { id: "restored" } }));
    installMachineProvider({
      resume,
      suspend: async () => ({ resource: { id: "saved" } }),
    });
    updateHost(harness.db, harness.hub, host.id, {
      machineProviderId: "test-machine",
      phase: "suspended",
      resource: { id: "saved" },
      suspendedAt: 1,
    });

    const args = {
      hostId: host.id,
      command: { type: "host.paths_exist" as const, paths: ["/tmp/work"] },
      timeoutMs: 100,
    };

    await expect(callHostOnlineRpc(harness.deps, args)).rejects.toMatchObject({
      body: { code: "host_unavailable" },
    });
    expect(resume).not.toHaveBeenCalled();
    vi.spyOn(harness.hub, "requestHostOnlineRpc").mockResolvedValue({
      type: "host-rpc.response",
      requestId: "request-policy",
      commandType: "host.paths_exist",
      ok: true,
      result: { existence: { "/tmp/work": true } },
    });
    await expect(callHostOnlineRpcForWork(harness.deps, args)).resolves.toEqual(
      { existence: { "/tmp/work": true } },
    );
    expect(resume).toHaveBeenCalledOnce();
  }));

it("does not wake a suspended machine for migration RPCs", async () =>
  withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps, { id: "migration-policy" });
    const resume = vi.fn(async () => ({ resource: { id: "restored" } }));
    installMachineProvider({
      resume,
      suspend: async () => ({ resource: { id: "saved" } }),
    });
    updateHost(harness.db, harness.hub, host.id, {
      machineProviderId: "test-machine",
      phase: "suspended",
      resource: { id: "saved" },
      suspendedAt: 1,
    });

    const commands: HostDaemonRpcCommand[] = [
      { type: "server_move.inspect", paths: [], port: 38886 },
      {
        type: "server_move.probe",
        url: "https://test.example.com",
        moveId: "move-policy",
      },
      { type: "server_move.abort", moveId: "move-policy" },
      { type: "server_move.delete_old_copy" },
    ];

    const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");

    for (const command of commands) {
      await expect(
        callHostOnlineRpcForWork(harness.deps, {
          hostId: host.id,
          command,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
    }

    expect(resume).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(getHost(harness.db, host.id)?.phase).toBe("suspended");
  }));

it("does not wake a suspended machine for thread-storage cleanup, including bound work calls", async () =>
  withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    const resume = vi.fn(async () => ({ resource: { id: "restored" } }));
    installMachineProvider({
      resume,
      suspend: async () => ({ resource: { id: "saved" } }),
    });
    updateHost(harness.db, harness.hub, host.id, {
      machineProviderId: "test-machine",
      phase: "suspended",
      resource: { id: "saved" },
      suspendedAt: 1,
    });
    const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");

    for (const expectedSessionId of [undefined, session.id]) {
      await expect(
        callHostOnlineRpcForWork(harness.deps, {
          hostId: host.id,
          expectedSessionId,
          timeoutMs: 100,
          command: {
            type: "host.delete_thread_storage",
            threadId: "thr_abcdefghij",
          },
        }),
      ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
    }

    expect(resume).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }));
