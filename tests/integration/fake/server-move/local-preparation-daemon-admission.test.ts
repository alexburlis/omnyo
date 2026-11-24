import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandRouter } from "../../../../apps/host-daemon/src/command-router.js";
import {
  createHarness,
  createTestWorkspaceReads,
  noopEventSink,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
} from "../../../../apps/host-daemon/test/command/dispatch-helpers.js";
import {
  createFixture,
  registerServerMoveFixtureCleanup,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";

registerServerMoveFixtureCleanup();

const probe = {
  type: "server_access.probe_direct",
  serverUrl: "http://127.0.0.1:1",
  challenge: "owned-inert-challenge",
  instanceId: "inert-server-instance",
} as const;

describe("worker owner admission before direct handoff", () => {
  it.each([
    "commands",
    "runtimes",
    "terminals",
    "pluginHosts",
    "interactions",
    "unknown",
  ])(
    "refuses %s before any direct transport or disruptive handoff",
    async (owner) => {
      const fixture = await createFixture();
      let fetches = 0;

      const service = fixture.createService({
        fetchFn: async () => {
          fetches++;
          throw new Error("Direct transport must remain untouched");
        },
        getDirectAccessActivity: () =>
          owner === "unknown"
            ? null
            : {
                commands: 0,
                runtimes: 0,
                terminals: 0,
                pluginHosts: 0,
                interactions: 0,
                [owner]: 1,
              },
      });

      await expect(service.probeDirect(probe)).rejects.toThrow(/busy|unknown/u);
      expect(fetches).toBe(0);
      expect(fixture.shutdownRequests).toEqual([]);
    },
  );

  it("blocks a late real file write through CommandRouter while proof is in flight, then opens only for matching precommit release", async () => {
    const fixture = await createFixture();
    let permit!: () => void;

    const waiting = new Promise<void>((resolve) => {
      permit = resolve;
    });

    let entered!: () => void;

    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const service = fixture.createService({
      getDirectAccessActivity: () => ({
        commands: 0,
        runtimes: 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
      fetchFn: async () => {
        entered();
        await waiting;
        throw new Error("Inert proof refused");
      },
    });

    const routerHarness = createHarness();

    const router = new CommandRouter({
      dataDir: fixture.dataDir,
      runtimeManager: routerHarness.manager,
      workspaceReads: createTestWorkspaceReads(routerHarness.manager),
      serverMove: service,
      eventSink: noopEventSink,
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      ...unexpectedProviderMaintenance,
      threadStorageRootPath: join(fixture.root, "thread-storage"),
      logger: { debug() {}, warn() {} },
    });

    const proving = service.probeDirect(probe).catch(() => undefined);

    try {
      await entry;
      const path = join(fixture.root, "late-write.txt");

      const response = await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "late-write",
        command: {
          type: "host.write_file",
          path,
          content: "late user bytes",
          contentEncoding: "utf8",
          createParents: false,
        },
      });

      expect(response.ok).toBe(false);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        service.releaseDirectProbe({
          type: "server_access.release_direct_probe",
          challenge: "wrong",
        }),
      ).rejects.toThrow(/owner|challenge/u);
      await expect(
        service.releaseDirectProbe({
          type: "server_access.release_direct_probe",
          challenge: probe.challenge,
        }),
      ).resolves.toEqual({ ok: true });
      permit();
      await proving;

      const admitted = await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "after-release",
        command: {
          type: "host.write_file",
          path,
          content: "released user bytes",
          contentEncoding: "utf8",
          createParents: false,
        },
      });

      expect(admitted.ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe("released user bytes");
    } finally {
      permit();
      await proving;
    }
  });
});
