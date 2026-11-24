import { describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type {
  HostDaemonOnlineRpcCommand,
  ProviderCliInstallEvent,
} from "@omnyo/host-daemon-contract";
import type { ProviderInstallationStatus } from "@omnyo/provider-bridge-protocol";
import {
  dispatchOnlineRpcCommand,
  type CommandDispatchOptions,
} from "./command-dispatch.js";
import {
  createHarness,
  DISPATCH_TEST_BRIDGE_LAUNCH,
  noopEventSink,
} from "../test/command/dispatch-helpers.js";
import { CommandRouter } from "./command-router.js";
import {
  createFixture,
  registerServerMoveFixtureCleanup,
} from "./server-move/test-fixture.js";

registerServerMoveFixtureCleanup();

const installedStatus: ProviderInstallationStatus = {
  executableName: "codex",
  executablePath: "/fixture/codex",
  installed: true,
  installSource: "external",
  currentVersion: "2.0.0",
  latestVersion: "2.0.0",
  minimumSupportedVersion: null,
  npmPackageName: null,
  npmGlobalPackageVersion: null,
  installAction: null,
  needsUpdate: false,
  versionUnsupported: false,
};

function startCommand(operationId = "installation-one") {
  return {
    type: "provider.installation.start" as const,
    operationId,
    providerId: "codex",
    action: "update" as const,
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
  };
}

async function createInstallationHarness(
  activity: Partial<{
    commands: number;
    runtimes: number;
    terminals: number;
    pluginHosts: number;
    interactions: number;
  }> = {},
) {
  const fixture = await createFixture();
  const runtimeHarness = createHarness();
  let busy = false;

  const service = fixture.createService({
    getRuntimeUpdateActivity: () => ({
      commands: 0,
      runtimes: busy ? 1 : 0,
      terminals: 0,
      pluginHosts: 0,
      interactions: 0,
      ...activity,
    }),
  });

  const output = createDeferredPromise<void>();
  const verification = createDeferredPromise<ProviderInstallationStatus>();

  const providerRun = vi.fn(async () => ({
    available: true as const,
    command: {
      command: "fixture-installer",
      args: [],
      displayCommand: "fixture-installer",
    },
    verification: { kind: "version_at_least" as const, version: "2.0.0" },
  }));

  const providerStatus = vi.fn(() => verification.promise);

  const events: ProviderCliInstallEvent[] = [
    { type: "started", provider: "codex", command: "fixture-installer" },
    { type: "output", provider: "codex", stream: "stdout", text: "updated\n" },
    {
      type: "completed",
      provider: "codex",
      exitCode: 0,
      signal: null,
      success: true,
    },
  ];

  const stream = vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await output.promise;
          const encoder = new TextEncoder();

          for (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }

          controller.close();
        },
      }),
  );

  const options: CommandDispatchOptions = {
    ...runtimeHarness.dispatchOptions({ dataDir: fixture.options.dataDir }),
    serverMove: service,
    providerInstallationRun: providerRun,
    providerInstallationStatus: providerStatus,
    streamProviderInstallation: stream,
  };

  return {
    service,
    output,
    verification,
    providerRun,
    providerStatus,
    stream,
    events,
    options,
    setBusy(value: boolean) {
      busy = value;
    },
    start: (operationId?: string) =>
      dispatchOnlineRpcCommand(startCommand(operationId), options),
    get: (operationId = "installation-one") =>
      dispatchOnlineRpcCommand(
        {
          type: "provider.installation.get",
          operationId,
        },
        options,
      ),
  };
}

describe("provider installation operations", () => {
  it.each([
    { activity: { commands: 1 }, blocker: "commands 1" },
    { activity: { runtimes: 1 }, blocker: "runtimes 1" },
    { activity: { interactions: 1 }, blocker: "interactions 1" },
    { activity: { terminals: -1 }, blocker: "terminals invalid" },
    { activity: { pluginHosts: Number.NaN }, blocker: "pluginHosts invalid" },
  ])(
    "preserves provider admission for $blocker",
    async ({ activity, blocker }) => {
      const harness = await createInstallationHarness(activity);
      await expect(harness.start()).rejects.toMatchObject({
        code: "runtime_update_busy",
        message: `Worker activity prevents a provider update: ${blocker}`,
      });
      expect(harness.providerRun).not.toHaveBeenCalled();
      expect(harness.service.runtimeUpdateStatus().held).toBe(false);
    },
  );

  it("uses provider admission for the synchronous installation route too", async () => {
    const harness = await createInstallationHarness({
      terminals: 1,
      pluginHosts: 1,
    });

    harness.output.resolve();
    harness.verification.resolve(installedStatus);

    const result = await dispatchOnlineRpcCommand(
      {
        type: "provider.installation.run",
        providerId: "codex",
        action: "update",
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      },
      harness.options,
    );

    expect(result.events).toContainEqual({
      type: "completed",
      provider: "codex",
      exitCode: 0,
      signal: null,
      success: true,
    });
    expect(harness.service.runtimeUpdateStatus().held).toBe(false);
  });

  it("updates a provider while unrelated terminals and plugin hosts remain resident", async () => {
    const harness = await createInstallationHarness({
      terminals: 2,
      pluginHosts: 3,
    });

    expect(harness.service.tryAcquireRuntimeUpdateHold()).toBe(false);
    expect(await harness.start()).toMatchObject({ state: "installing" });
    expect(() =>
      harness.service.assertDirectAccessAdmission("thread.start"),
    ).toThrow();
    harness.output.resolve();
    harness.verification.resolve(installedStatus);
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: { state: "completed" },
        held: false,
      }),
    );
    expect(harness.service.tryAcquireRuntimeUpdateHold()).toBe(false);
    expect(harness.providerRun).toHaveBeenCalledOnce();
  });

  it("refuses active host work before preparing an installer", async () => {
    const harness = await createInstallationHarness();
    harness.setBusy(true);
    await expect(harness.start()).rejects.toMatchObject({
      code: "runtime_update_busy",
    });
    expect(harness.providerRun).not.toHaveBeenCalled();
    expect(await harness.get()).toEqual({
      operation: null,
      held: false,
      holdOwner: null,
    });
    harness.setBusy(false);
    expect(harness.service.restoreRuntimeUpdateHold("installation-one")).toBe(
      true,
    );
    await expect(harness.start()).rejects.toMatchObject({
      code: "runtime_update_busy",
    });
    expect(harness.providerRun).not.toHaveBeenCalled();
    harness.service.releaseRuntimeUpdateHold("installation-one");
  });

  it("holds admission through verification and deduplicates repeated starts", async () => {
    const harness = await createInstallationHarness();
    const started = await harness.start();
    expect(started).toMatchObject({
      operationId: "installation-one",
      state: "installing",
    });
    expect(harness.service.runtimeUpdateStatus()).toMatchObject({
      held: true,
      holdOwner: "installation-one",
    });
    expect(() =>
      harness.service.assertDirectAccessAdmission("thread.start"),
    ).toThrow();
    expect(() =>
      harness.service.assertDirectAccessAdmission("provider.installation.get"),
    ).not.toThrow();
    expect(() =>
      harness.service.assertDirectAccessAdmission(
        "provider.installation.start",
      ),
    ).not.toThrow();
    expect(await harness.start()).toMatchObject({
      operationId: "installation-one",
      state: "installing",
    });
    await vi.waitFor(() => expect(harness.stream).toHaveBeenCalledOnce());
    expect(harness.providerRun).toHaveBeenCalledOnce();
    await expect(harness.start("installation-two")).rejects.toMatchObject({
      code: "runtime_update_busy",
    });

    harness.output.resolve();
    await vi.waitFor(() =>
      expect(harness.providerStatus).toHaveBeenCalledOnce(),
    );
    expect(await harness.get()).toMatchObject({
      operation: { state: "verifying", events: harness.events.slice(0, 2) },
      held: true,
      holdOwner: "installation-one",
    });
    harness.verification.resolve(installedStatus);
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: { state: "completed", events: harness.events },
        held: false,
        holdOwner: null,
      }),
    );
    expect(await harness.start()).toMatchObject({ state: "completed" });
    expect(harness.providerRun).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an operation id with different installation inputs", async () => {
    const harness = await createInstallationHarness();
    await harness.start();

    const other = {
      ...startCommand(),
      providerId: "claude",
    } satisfies HostDaemonOnlineRpcCommand;

    await expect(
      dispatchOnlineRpcCommand(other, harness.options),
    ).rejects.toMatchObject({
      code: "provider_installation_operation_conflict",
    });
    harness.output.resolve();
    harness.verification.resolve(installedStatus);
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: { state: "completed" },
        held: false,
      }),
    );
  });

  it("records an installer failure and releases only its own hold", async () => {
    const harness = await createInstallationHarness();
    harness.providerRun.mockRejectedValueOnce(
      new Error("Fixture installation failed"),
    );
    await harness.start();
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: {
          state: "failed",
          events: [{ type: "error", message: "Fixture installation failed" }],
        },
        held: false,
        holdOwner: null,
      }),
    );
    expect(() =>
      harness.service.assertDirectAccessAdmission("thread.start"),
    ).not.toThrow();
    expect(await harness.start()).toMatchObject({ state: "failed" });
    expect(harness.providerRun).toHaveBeenCalledOnce();

    const release = vi
      .spyOn(harness.service, "releaseRuntimeUpdateHold")
      .mockImplementationOnce(() => {
        throw new Error("Fixture admission release failed");
      });

    try {
      await harness.start("installation-two");
      harness.output.resolve();
      harness.verification.resolve(installedStatus);
      await vi.waitFor(async () =>
        expect(await harness.get("installation-two")).toMatchObject({
          operation: {
            state: "failed",
            events: [
              harness.events[0],
              harness.events[1],
              { ...harness.events[2], success: false },
              { type: "error", message: "Fixture admission release failed" },
            ],
          },
          held: true,
          holdOwner: "installation-two",
        }),
      );
    } finally {
      release.mockRestore();
      harness.service.releaseRuntimeUpdateHold("installation-two");
    }
  });

  it("reports verification failure instead of installer exit success", async () => {
    const harness = await createInstallationHarness();
    await harness.start();
    harness.output.resolve();
    harness.verification.resolve({
      ...installedStatus,
      currentVersion: "1.0.0",
    });
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: {
          state: "failed",
          events: expect.arrayContaining([
            {
              type: "completed",
              provider: "codex",
              exitCode: 0,
              signal: null,
              success: false,
            },
          ]),
        },
        held: false,
      }),
    );
  });

  it("preserves output when post-install runtime invalidation fails", async () => {
    const harness = await createInstallationHarness();
    vi.spyOn(
      harness.options.runtimeManager,
      "invalidateProviderMaintenanceRuntime",
    ).mockRejectedValueOnce(new Error("Fixture runtime invalidation failed"));
    await harness.start();
    harness.output.resolve();
    harness.verification.resolve(installedStatus);
    await vi.waitFor(async () =>
      expect(await harness.get()).toMatchObject({
        operation: {
          state: "failed",
          events: [
            harness.events[0],
            harness.events[1],
            { ...harness.events[2], success: false },
            {
              type: "error",
              code: "command_failed",
              message: "Fixture runtime invalidation failed",
            },
          ],
        },
        held: false,
      }),
    );
  });

  it("uses the actual acquiring RPC count and serves status under its hold", async () => {
    const fixture = await createFixture();
    const harness = createHarness();
    let router: CommandRouter;

    const admission = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands: router.getDirectAccessActivityCount(),
        runtimes: 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    const plan =
      createDeferredPromise<
        Awaited<ReturnType<CommandDispatchOptions["providerInstallationRun"]>>
      >();

    const providerRun = vi.fn(() => plan.promise);
    router = new CommandRouter({
      ...harness.dispatchOptions({ dataDir: fixture.options.dataDir }),
      eventSink: noopEventSink,
      serverMove: admission,
      providerInstallationRun: providerRun,
    });

    const request = (command: HostDaemonOnlineRpcCommand) =>
      router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "installation-rpc",
        command,
      });

    expect(await request(startCommand())).toMatchObject({
      ok: true,
      result: { state: "installing" },
    });
    expect(await request(startCommand())).toMatchObject({
      ok: true,
      result: { state: "installing" },
    });
    expect(
      await request({
        type: "provider.installation.get",
        operationId: "installation-one",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        operation: { state: "installing" },
        held: true,
        holdOwner: "installation-one",
      },
    });
    expect(
      await request({ type: "host.paths_exist", paths: ["/fixture"] }),
    ).toMatchObject({ ok: false, errorCode: "runtime_update_held" });
    await vi.waitFor(() => expect(providerRun).toHaveBeenCalledOnce());
    plan.resolve({
      available: false,
      message: "Fixture update is unavailable",
    });
    await vi.waitFor(async () =>
      expect(
        await request({
          type: "provider.installation.get",
          operationId: "installation-one",
        }),
      ).toMatchObject({
        ok: true,
        result: {
          operation: {
            state: "failed",
            events: [
              { type: "error", code: "provider_installation_unavailable" },
            ],
          },
          held: false,
          holdOwner: null,
        },
      }),
    );
  });
});
