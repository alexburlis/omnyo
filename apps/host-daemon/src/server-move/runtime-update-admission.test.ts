import { describe, expect, it } from "vitest";
import {
  createFixture,
  registerServerMoveFixtureCleanup,
} from "./test-fixture.js";

registerServerMoveFixtureCleanup();

describe("worker update admission", () => {
  it("ignores exactly the acquiring RPC and preserves owner-bound admission", async () => {
    let commands = 1;
    const fixture = await createFixture();

    const service = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands,
        runtimes: 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    expect(service.tryAcquireRuntimeUpdateHold(1, "restart-owner")).toBe(true);
    expect(service.runtimeUpdateStatus()).toMatchObject({
      activity: { commands: 1 },
      held: true,
      holdOwner: "restart-owner",
      blockers: ["update_held", "commands"],
    });
    expect(() => service.releaseRuntimeUpdateHold("foreign-owner")).toThrow();
    expect(() =>
      service.assertDirectAccessAdmission("terminal.create"),
    ).toThrow();
    service.releaseRuntimeUpdateHold("restart-owner");
    commands = 2;
    expect(service.tryAcquireRuntimeUpdateHold(1, "restart-owner")).toBe(false);
    expect(service.runtimeUpdateStatus()).toMatchObject({
      held: false,
      holdOwner: null,
      blockers: ["commands"],
    });
    commands = 1;
    expect(service.tryAcquireRuntimeUpdateHold(1, "restart-owner")).toBe(true);
    expect(() => service.assertDirectAccessAdmission("thread.start")).toThrow();
    service.releaseRuntimeUpdateHold("restart-owner");
    expect(() =>
      service.assertDirectAccessAdmission("thread.start"),
    ).not.toThrow();
  });

  it("restores an uncertain installer fence before admission while preserving existing busy work", async () => {
    let runtimes = 1;
    const fixture = await createFixture();

    const service = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands: 0,
        runtimes,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    expect(service.restoreRuntimeUpdateHold("installer-owner")).toBe(true);
    expect(service.runtimeUpdateStatus()).toMatchObject({
      held: true,
      holdOwner: "installer-owner",
      activity: { runtimes: 1 },
    });
    expect(service.restoreRuntimeUpdateHold("foreign-owner")).toBe(false);
    expect(() => service.assertDirectAccessAdmission("thread.start")).toThrow();
    expect(() =>
      service.assertDirectAccessAdmission("terminal.create"),
    ).toThrow();
    expect(service.tryAcquireRuntimeUpdateHold(0, "installer-owner")).toBe(
      false,
    );
    expect(service.runtimeUpdateStatus().held).toBe(true);
    expect(runtimes).toBe(1);
    runtimes = 0;
    expect(service.tryAcquireRuntimeUpdateHold(0, "installer-owner")).toBe(
      true,
    );
    service.releaseRuntimeUpdateHold("installer-owner");
    expect(() =>
      service.assertDirectAccessAdmission("thread.start"),
    ).not.toThrow();
  });

  it("holds new commands only after all existing owners are idle and releases a failed update", async () => {
    let busy = true;

    const activity = () => ({
      commands: 0,
      runtimes: busy ? 1 : 0,
      terminals: 0,
      pluginHosts: 0,
      interactions: 0,
    });

    const fixture = await createFixture();

    const service = fixture.createService({
      getDirectAccessActivity: activity,
      getRuntimeUpdateActivity: activity,
    });

    expect(service.tryAcquireRuntimeUpdateHold()).toBe(false);
    expect(() =>
      service.assertDirectAccessAdmission("thread.turn_start"),
    ).not.toThrow();
    busy = false;
    expect(service.tryAcquireRuntimeUpdateHold()).toBe(true);
    expect(() =>
      service.assertDirectAccessAdmission("thread.turn_start"),
    ).toThrow("update");
    expect(service.tryAcquireRuntimeUpdateHold()).toBe(false);
    service.releaseRuntimeUpdateHold();
    expect(() =>
      service.assertDirectAccessAdmission("thread.turn_start"),
    ).not.toThrow();
  });

  it.each([null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses unknown or invalid update ownership without holding commands: %s",
    async (count) => {
      const fixture = await createFixture();

      const service = fixture.createService({
        getDirectAccessActivity: () => ({
          commands: 0,
          runtimes: 0,
          terminals: 0,
          pluginHosts: 0,
          interactions: 0,
        }),
        getRuntimeUpdateActivity: () =>
          count === null
            ? null
            : {
                commands: 0,
                runtimes: count,
                terminals: 0,
                pluginHosts: 0,
                interactions: 0,
              },
      });

      expect(service.tryAcquireRuntimeUpdateHold()).toBe(false);
      expect(service.tryAcquireProviderUpdateHold()).toBe(false);
      expect(() => service.assertDirectAccessAdmission()).not.toThrow();
    },
  );

  it("keeps direct handoff strict and cannot update through its held probe", async () => {
    let resident = true;
    const fixture = await createFixture();

    const service = fixture.createService({
      getDirectAccessActivity: () => ({
        commands: 0,
        runtimes: resident ? 1 : 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
      getRuntimeUpdateActivity: () => ({
        commands: 0,
        runtimes: 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
      fetchFn: async () => {
        throw new Error("unavailable direct route");
      },
    });

    const probe = {
      type: "server_access.probe_direct" as const,
      serverUrl: fixture.options.serverUrl,
      challenge: "worker-update-probe",
      instanceId: "coordinator",
    };

    expect(service.tryAcquireRuntimeUpdateHold()).toBe(true);
    service.releaseRuntimeUpdateHold();
    await expect(service.probeDirect(probe)).rejects.toThrow("busy");
    resident = false;
    await expect(service.probeDirect(probe)).rejects.toThrow("unavailable");
    expect(service.tryAcquireRuntimeUpdateHold()).toBe(false);
    expect(service.tryAcquireProviderUpdateHold()).toBe(false);
    await service.releaseDirectProbe({
      type: "server_access.release_direct_probe",
      challenge: probe.challenge,
    });
    expect(service.tryAcquireRuntimeUpdateHold()).toBe(true);
    service.releaseRuntimeUpdateHold();
  });
});
