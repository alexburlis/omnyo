import { createDeferredPromise } from "@omnyo/test-helpers";
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHost, setAppSettings, updateHost, upsertHost } from "@omnyo/db";
import { defaultAppSettings } from "@omnyo/domain";
import type { ServerAccessProviderDeclaration } from "@omnyo/plugin-sdk";
import {
  serverAccess,
  serverAccessStatus,
} from "../../../src/services/machines/server-access.js";
import { setServerAccessBridge } from "../../../src/services/plugins/plugin-server-access-registry.js";
import { listPublicHostsWithStatus } from "../../../src/services/lib/entity-lookup.js";
import { advanceUntilSettled } from "../../helpers/fake-timers.js";
import { withTestHarness } from "../../helpers/test-app.js";
import type { TestAppHarness } from "../../helpers/test-app.js";
import { seedHostSession, seedPrimaryHost } from "../../helpers/seed.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { isDirectAccessHeld } from "../../../src/services/machines/direct-access-state.js";
import { callHostOnlineRpc } from "../../../src/services/hosts/online-rpc.js";

const signal = new AbortController().signal;

afterEach(() => {
  setServerAccessBridge(undefined);
  vi.unstubAllEnvs();
});

function installProvider(provider: ServerAccessProviderDeclaration) {
  setServerAccessBridge({
    list: () => [{ pluginId: "access-plugin", provider }],
    invoke: async (_id, run) => run(),
  });
}

function provider(): ServerAccessProviderDeclaration {
  return {
    id: "relay",
    displayName: "Relay",
    description: "Use a managed relay.",
    availability: () => ({ status: "available" }),
    acquire: async ({ hostId }) => ({
      id: hostId,
      serverUrl: "https://omnyo.example.com",
      headers: { "x-access-token": "secret-header" },
    }),
    release: async () => {},
  };
}

describe("machine server access", () => {
  it("cancels a pending availability check without acquiring access when it later resolves", async () => {
    await withTestHarness(async ({ deps }) => {
      const controller = new AbortController();
      const pending = createDeferredPromise<{ status: "available" }>();
      const availability = vi.fn(() => pending.promise);
      const acquire = vi.fn(provider().acquire);
      installProvider({ ...provider(), availability, acquire });
      const host = upsertHost(deps.db, deps.hub, { name: "cancelled" })!;

      const result = serverAccess.resolve(deps, {
        key: "cancelled",
        hostId: host.id,
        signal: controller.signal,
      });

      const rejected = expect(result).rejects.toThrow("Cancelled by user");
      await vi.waitFor(() => expect(availability).toHaveBeenCalledOnce());
      controller.abort(new Error("Cancelled by user"));
      await rejected;
      pending.resolve({ status: "available" });
      await pending.promise;
      expect(acquire).not.toHaveBeenCalled();
      expect(getHost(deps.db, host.id)?.serverAccessProviderId).toBeNull();
    });
  });

  it("prefers the first registered provider and respects an explicit direct default", async () => {
    await withTestHarness(async ({ deps }) => {
      vi.stubEnv("OMNYO_EXTERNAL_URL", "https://direct.example.com");
      expect((await serverAccessStatus(deps)).defaultProviderId).toBe("direct");
      installProvider(provider());
      expect((await serverAccessStatus(deps)).defaultProviderId).toBe("relay");
      expect((await serverAccessStatus(deps)).providers[0]).toMatchObject({
        id: "relay",
        pluginId: "access-plugin",
        description: "Use a managed relay.",
      });
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        defaultMachineAccess: "direct",
      });
      expect((await serverAccessStatus(deps)).defaultProviderId).toBe("direct");
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        defaultMachineAccess: "missing",
      });
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      await expect(
        serverAccess.resolve(deps, { key: "k", hostId: host.id, signal }),
      ).rejects.toThrow("unavailable");
    });
  });

  it("requires provider setup instead of silently falling back to a configured URL", async () => {
    await withTestHarness(async ({ deps }) => {
      vi.stubEnv("OMNYO_EXTERNAL_URL", "https://direct.example.com");

      const availability = vi.fn(() => ({
        status: "setup-required" as const,
        message: "Set up the relay",
      }));

      installProvider({
        ...provider(),
        availability,
      });
      expect((await serverAccessStatus(deps)).defaultProviderId).toBe("relay");
      availability.mockClear();
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      await expect(
        serverAccess.resolve(deps, { key: "k", hostId: host.id, signal }),
      ).rejects.toThrow("Set up the relay");
      expect(availability).toHaveBeenCalledOnce();
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        defaultMachineAccess: "direct",
      });
      expect(
        (
          await serverAccess.resolve(deps, {
            key: "k",
            hostId: host.id,
            signal,
          })
        ).serverUrl,
      ).toBe("https://direct.example.com");
    });
  });

  it("returns direct access without headers, including on repair", async () => {
    await withTestHarness(async ({ deps }) => {
      vi.stubEnv("OMNYO_EXTERNAL_URL", "https://direct.example.com");
      const host = upsertHost(deps.db, deps.hub, { name: "direct" })!;
      const args = { key: "direct", hostId: host.id, signal };

      const expected = {
        id: host.id,
        serverUrl: "https://direct.example.com",
      };

      await expect(serverAccess.resolve(deps, args)).resolves.toEqual(expected);
      await expect(serverAccess.repair(deps, args)).resolves.toEqual(expected);
      expect(getHost(deps.db, host.id)?.serverAccessProviderId).toBe("direct");
    });
  });

  it("stores grant identity without its code and retains provider on retry", async () => {
    await withTestHarness(async ({ deps }) => {
      installProvider(provider());
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;

      const grant = await serverAccess.resolve(deps, {
        key: "k",
        hostId: host.id,
        signal,
      });

      expect(grant.headers).toEqual({ "x-access-token": "secret-header" });
      const row = getHost(deps.db, host.id)!;
      expect(row.serverAccessProviderId).toBe("relay");
      expect(row.serverAccessGrantId).toBe(host.id);
      expect(JSON.stringify(row)).not.toContain("secret-header");
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        defaultMachineAccess: "direct",
        machineServerUrl: "https://other.example.com",
      });
      expect(
        await serverAccess.resolve(deps, { key: "k", hostId: host.id, signal }),
      ).toEqual(grant);
      await serverAccess.release(deps, { key: "k", hostId: host.id });
      expect(getHost(deps.db, host.id)?.serverAccessGrantId).toBeNull();
    });
  });

  it("releases before reacquiring from the selected provider and accepts a new grant identity", async () => {
    await withTestHarness(async ({ deps }) => {
      const release = vi.fn(provider().release);
      const acquire = vi.fn(provider().acquire);
      installProvider({ ...provider(), release, acquire });
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      const args = { key: "k", hostId: host.id, signal };
      await serverAccess.resolve(deps, args);
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        defaultMachineAccess: "direct",
      });
      acquire.mockImplementationOnce(async () => {
        expect(release).toHaveBeenCalledWith({
          key: "k",
          hostId: host.id,
          grantId: host.id,
        });

        return {
          id: "replacement",
          serverUrl: "https://omnyo.example.com",
          headers: { "x-access-token": "new" },
        };
      });
      await expect(serverAccess.repair(deps, args)).resolves.toMatchObject({
        id: "replacement",
      });
      expect(getHost(deps.db, host.id)).toMatchObject({
        serverAccessProviderId: "relay",
        serverAccessGrantId: "replacement",
      });
    });
  });

  it("retains the selected provider and supports retry after failed reacquisition", async () => {
    await withTestHarness(async ({ deps }) => {
      const acquire = vi.fn(provider().acquire);
      installProvider({ ...provider(), acquire });
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      const args = { key: "k", hostId: host.id, signal };
      await serverAccess.resolve(deps, args);
      acquire.mockRejectedValueOnce(new Error("unavailable"));
      await expect(serverAccess.repair(deps, args)).rejects.toThrow(
        "unavailable",
      );
      expect(getHost(deps.db, host.id)).toMatchObject({
        serverAccessProviderId: "relay",
        serverAccessGrantId: null,
      });
      await expect(serverAccess.repair(deps, args)).resolves.toMatchObject({
        id: host.id,
      });
    });
  });

  it("does not reacquire when release fails or switch providers when the selected one is missing", async () => {
    await withTestHarness(async ({ deps }) => {
      const acquire = vi.fn(provider().acquire);
      const release = vi.fn().mockRejectedValue(new Error("release failed"));
      installProvider({ ...provider(), acquire, release });
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      const args = { key: "k", hostId: host.id, signal };
      await serverAccess.resolve(deps, args);
      await expect(serverAccess.repair(deps, args)).rejects.toThrow(
        "release failed",
      );
      expect(acquire).toHaveBeenCalledOnce();
      setServerAccessBridge(undefined);
      await expect(serverAccess.repair(deps, args)).rejects.toThrow(
        "provider is unavailable",
      );
      expect(getHost(deps.db, host.id)).toMatchObject({
        serverAccessProviderId: "relay",
        serverAccessGrantId: host.id,
      });
    });
  });

  it("keeps failed release retryable and refuses invalid grant output without echoing it", async () => {
    await withTestHarness(async ({ deps }) => {
      const release = vi.fn().mockRejectedValueOnce(new Error("retry"));
      installProvider({ ...provider(), release });
      const host = upsertHost(deps.db, deps.hub, { name: "test" })!;
      await serverAccess.resolve(deps, { key: "k", hostId: host.id, signal });
      await expect(
        serverAccess.release(deps, { key: "k", hostId: host.id }),
      ).rejects.toThrow("retry");
      expect(getHost(deps.db, host.id)?.serverAccessGrantId).toBe(host.id);
      installProvider({
        ...provider(),
        acquire: async () => ({
          id: "id",
          serverUrl: "https://secret:secret@example.com",
        }),
      });
      await expect(
        serverAccess.resolve(deps, { key: "k", hostId: host.id, signal }),
      ).rejects.toThrow("invalid grant");
    });
  });

  it("uses the explicit machine URL before the environment fallback", async () => {
    vi.stubEnv("OMNYO_EXTERNAL_URL", "https://fallback.example.com");
    await withTestHarness(async ({ deps }) => {
      setAppSettings(deps.db, {
        ...defaultAppSettings,
        machineServerUrl: "https://configured.example.com",
      });
      expect(await serverAccessStatus(deps)).toMatchObject({
        effectiveUrl: "https://configured.example.com",
        urlSource: "setting",
      });
      setAppSettings(deps.db, defaultAppSettings);
      expect(await serverAccessStatus(deps)).toMatchObject({
        effectiveUrl: "https://fallback.example.com",
        urlSource: "OMNYO_EXTERNAL_URL",
      });
    });
  });
});

it("keeps interrupted access visible and releases the acquisition without a returned grant", async () => {
  await withTestHarness(async ({ deps }) => {
    const message = "Cloud device may need dashboard revocation";

    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue(undefined);

    installProvider({
      ...provider(),
      acquire: async () => ({ status: "failed", message }),
      release,
    });
    const host = upsertHost(deps.db, deps.hub, { name: "interrupted" })!;
    updateHost(deps.db, deps.hub, host.id, {
      machineProviderId: "test-machine",
      launchKey: "k",
      phase: "creating",
    });
    expect(
      listPublicHostsWithStatus(deps).some((entry) => entry.id === host.id),
    ).toBe(false);
    await expect(
      serverAccess.resolve(deps, { key: "k", hostId: host.id, signal }),
    ).rejects.toThrow(message);
    expect(getHost(deps.db, host.id)).toMatchObject({
      serverAccessProviderId: "relay",
      serverAccessGrantId: null,
      statusMessage: message,
    });
    expect(
      listPublicHostsWithStatus(deps, { includeCreating: true }).find(
        (entry) => entry.id === host.id,
      )?.lifecycle.message,
    ).toBe(message);
    await expect(
      serverAccess.release(deps, { key: "k", hostId: host.id }),
    ).rejects.toThrow(message);
    expect(getHost(deps.db, host.id)?.serverAccessProviderId).toBe("relay");
    await serverAccess.release(deps, { key: "k", hostId: host.id });
    expect(release).toHaveBeenLastCalledWith({
      key: "k",
      hostId: host.id,
      grantId: null,
    });
    expect(getHost(deps.db, host.id)?.serverAccessProviderId).toBeNull();
  });
});

it("refreshes access status through the real recheck notification and configuration route", async () => {
  await withTestHarness(async (h) => {
    await h.pluginService.install("builtin:keep-awake", { kind: "root" });
    const api = h.pluginService.getApi("keep-awake");

    if (!api) throw new Error("Test plugin did not load");

    let availability: Awaited<
      ReturnType<ServerAccessProviderDeclaration["availability"]>
    > = { status: "setup-required", message: "Pair the relay" };

    const acquire = vi.fn(provider().acquire);
    api.experimental_serverAccess.register({
      ...provider(),
      availability: () => availability,
      acquire,
    });
    setAppSettings(h.db, {
      ...defaultAppSettings,
      defaultMachineAccess: "relay",
    });
    const notify = vi.spyOn(h.hub, "notifySystem");

    for (const next of [
      { status: "setup-required", message: "Pair the relay" },
      { status: "available", serverUrl: "https://relay.example.com" },
      { status: "unavailable", message: "Credential revoked" },
      { status: "available" },
    ] as const) {
      availability = next;
      notify.mockClear();
      api.experimental_serverAccess.recheck();
      expect(notify).toHaveBeenCalledWith(["config-changed"]);
      const response = await h.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const config = await response.json();
      expect(
        config.serverAccess.providers.find(
          (entry: { id: string }) => entry.id === "relay",
        ).availability,
      ).toEqual(next);
    }

    expect(acquire).not.toHaveBeenCalled();
  });
});

it.each([
  { status: "available", serverUrl: "https://secret:password@example.com" },
  { status: "unexpected", message: "private diagnostics" },
  new Error("private diagnostics"),
])(
  "fails closed without exposing invalid provider output: %s",
  async (output) => {
    await withTestHarness(async ({ deps }) => {
      const availability = vi.fn();

      if (output instanceof Error) availability.mockRejectedValue(output);
      else availability.mockResolvedValue(output);
      installProvider({ ...provider(), availability });
      const status = await serverAccessStatus(deps);
      expect(availability).toHaveBeenCalledOnce();
      expect(status.providers[0]?.availability?.status).toBe("unavailable");
      expect(JSON.stringify(status)).not.toMatch(
        /secret|password|private diagnostics/,
      );
    });
  },
);

it("bounds a stalled availability check and recovers on the next read", async () => {
  await withTestHarness(async ({ deps }) => {
    const pending = createDeferredPromise<{ status: "available" }>();
    installProvider({ ...provider(), availability: () => pending.promise });
    vi.useFakeTimers();

    try {
      const result = serverAccessStatus(deps);
      expect(
        (await advanceUntilSettled(result, 5_000)).providers[0]?.availability
          ?.status,
      ).toBe("unavailable");
      pending.resolve({ status: "available" });
      expect(
        (await serverAccessStatus(deps)).providers[0]?.availability,
      ).toEqual({ status: "available" });
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  { id: "direct" },
  { id: "Invalid ID" },
  { displayName: " " },
  { description: " " },
])(
  "matches real and fake server-access registration validation: %j",
  async (invalid) => {
    await withTestHarness(async (h) => {
      await h.pluginService.install("builtin:keep-awake", { kind: "root" });
      const real = h.pluginService.getApi("keep-awake");

      if (!real) throw new Error("Test plugin did not load");
      const fake = createFakePluginHost();

      try {
        for (const api of [real, fake.api])
          expect(() =>
            api.experimental_serverAccess.register({
              ...provider(),
              ...invalid,
            }),
          ).toThrow();
      } finally {
        await fake.harness.lifecycle.dispose();
      }
    });
  },
);

it("rejects duplicate server-access registrations in real and fake hosts", async () => {
  await withTestHarness(async (h) => {
    await h.pluginService.install("builtin:keep-awake", { kind: "root" });
    const real = h.pluginService.getApi("keep-awake");

    if (!real) throw new Error("Test plugin did not load");
    const fake = createFakePluginHost();

    try {
      for (const api of [real, fake.api]) {
        api.experimental_serverAccess.register(provider());
        expect(() =>
          api.experimental_serverAccess.register(provider()),
        ).toThrow("already registered");
      }
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  });
});

function seedDirectWorker(harness: TestAppHarness) {
  seedPrimaryHost(harness.deps, "host-primary");
  const worker = seedHostSession(harness.deps, { id: "host-direct-worker" });
  setAppSettings(harness.db, {
    ...defaultAppSettings,
    machineServerUrl: "https://direct.example.test",
  });

  return worker;
}

describe("direct worker handoff", () => {
  it.each([true, false])(
    "preserves the first worker refusal across cleanup outcomes: %s",
    async (cleanupSucceeds) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedDirectWorker(harness);

        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: ({ command }) => {
            if (command.type === "server_access.probe_direct")
              return {
                ok: false,
                errorCode: "direct_access_busy",
                errorMessage: "Worker owners are busy",
              };

            if (command.type === "server_access.release_direct_probe")
              return cleanupSucceeds
                ? { ok: true, result: { ok: true } }
                : {
                    ok: false,
                    errorCode: "direct_access_owner_mismatch",
                    errorMessage: "Direct probe owner differs",
                  };
            throw new Error(`Unexpected command ${command.type}`);
          },
        });

        const response = await harness.app.request(
          `/api/v1/hosts/${host.id}/direct-access`,
          { method: "POST" },
        );

        const body = await response.json();
        expect(response.status).toBe(409);
        expect(body).toMatchObject({
          code: "direct_access_busy",
          message: "Worker owners are busy",
        });

        if (!cleanupSucceeds)
          expect(body).toMatchObject({
            details: {
              releaseUncertain: true,
              cleanupError: {
                code: "direct_access_owner_mismatch",
                message: "Direct probe owner differs",
              },
            },
          });
        expect(isDirectAccessHeld(harness.deps, host.id)).toBe(
          !cleanupSucceeds,
        );
        expect(getHost(harness.db, host.id)).toMatchObject({
          serverAccessProviderId: null,
          serverAccessGrantId: null,
        });
        expect(responder.requests.map(({ command }) => command.type)).toEqual([
          "server_access.probe_direct",
          "server_access.release_direct_probe",
        ]);
      });
    },
  );

  it.each(["absent", "uncommitted", "committed", "unavailable"] as const)(
    "inspects actual %s worker ownership while uncertain admission stays held",
    async (workerState) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedDirectWorker(harness);
        let challenge: string | null = null;

        const foreignFingerprint = createHash("sha256")
          .update("foreign-test-probe")
          .digest("hex");

        const probe =
          workerState === "uncommitted" || workerState === "committed"
            ? {
                phase: workerState,
                ownerFingerprint: foreignFingerprint,
                coordinatorInstanceId: "different-coordinator",
                sessionId: "different-probe-session",
              }
            : null;

        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: ({ command }) => {
            if (command.type === "server_access.probe_direct") {
              challenge = command.challenge;

              return {
                ok: false,
                errorCode: "direct_access_busy",
                errorMessage: "Worker owners are busy",
              };
            }

            if (command.type === "server_access.release_direct_probe")
              return {
                ok: false,
                errorCode: "release_transport_uncertain",
                errorMessage: "Worker release result is unavailable",
              };

            if (command.type === "server_access.inspect_direct_probe")
              return workerState === "unavailable"
                ? {
                    ok: false,
                    errorCode: "worker_status_unavailable",
                    errorMessage: "Worker ownership cannot be observed",
                  }
                : {
                    ok: true,
                    result: {
                      hostId: host.id,
                      workerInstanceId: session.instanceId,
                      sessionId: session.id,
                      probe,
                    },
                  };
            throw new Error(`Unexpected command ${command.type}`);
          },
        });

        await harness.app.request(`/api/v1/hosts/${host.id}/direct-access`, {
          method: "POST",
        });
        await expect(
          callHostOnlineRpc(harness.deps, {
            hostId: host.id,
            timeoutMs: 100,
            command: { type: "host.paths_exist", paths: ["/tmp"] },
          }),
        ).rejects.toThrow("admission is held");
        const response = await harness.app.request(`/api/v1/hosts/${host.id}`);
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.directAccess.status).toBe("available");

        if (challenge === null) throw new Error("Probe was not sent");
        expect(body.directAccess.coordinator).toMatchObject({
          held: true,
          phase: "release-uncertain",
          sessionId: session.id,
          ownerFingerprint: createHash("sha256")
            .update(challenge)
            .digest("hex"),
        });
        expect(body.directAccess.coordinator.instanceId).toEqual(
          expect.any(String),
        );
        expect(body.directAccess.worker).toEqual(
          workerState === "unavailable"
            ? {
                status: "unavailable",
                code: "worker_status_unavailable",
                message: "Worker ownership cannot be observed",
              }
            : {
                status: "available",
                hostId: host.id,
                workerInstanceId: session.instanceId,
                sessionId: session.id,
                probe,
              },
        );
        expect(JSON.stringify(body.directAccess)).not.toContain(challenge);
        expect(isDirectAccessHeld(harness.deps, host.id)).toBe(true);
        expect(responder.requests.map(({ command }) => command.type)).toEqual([
          "server_access.probe_direct",
          "server_access.release_direct_probe",
          "server_access.inspect_direct_probe",
        ]);

        const denied = await harness.app.request(`/api/v1/hosts/${host.id}`, {
          headers: { "x-omnyo-gate-auth": "machine" },
        });

        expect(denied.status).toBe(200);
        expect((await denied.json()).directAccess).toEqual({
          status: "unavailable",
          code: "machine_host_management_forbidden",
          message: "Machine credentials cannot inspect direct access ownership",
        });
        expect(responder.requests).toHaveLength(3);
      });
    },
  );
});
