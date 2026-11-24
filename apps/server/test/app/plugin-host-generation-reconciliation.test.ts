import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getHost,
  getLatestSessionForHost,
  getPluginHostGeneration,
  setPluginHostGeneration,
  updateHost,
  upsertHost,
} from "@omnyo/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonSessionOpenResponseSchema,
} from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  readServerImportFile,
  writeMaintenanceHold,
  writeServerImportFile,
} from "@omnyo/server-archive";
import { createApp } from "../../src/server.js";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestDaemonHostKey,
  withTestHarness,
} from "../helpers/test-app.js";

function sessionRequest(
  hostId: string,
  overrides: { authenticatedHostId?: string; protocolVersion?: number } = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${createTestDaemonHostKey({ hostId: overrides.authenticatedHostId ?? hostId })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      activeThreads: [],
      dataDir: "/tmp/omnyo-generation-reconnect",
      hasMachineCredential: false,
      hostId,
      hostName: "Reconnected host",
      instanceId: "generation-reconnect-instance",
      platform: "darwin",
      protocolVersion:
        overrides.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION,
    }),
  };
}

describe("plugin host generation session authority", () => {
  it.each(["maintenance-held", "manual-import"])(
    "accepts an empty authoritative snapshot on %s boot without starting plugins",
    async (mode) => {
      await withTestHarness(async (harness) => {
        const hostId = "host-frozen-generation";
        setPluginHostGeneration(harness.db, "previous-worker", {
          digest: "a".repeat(64),
          byteLength: 1,
          generation: "11111111-1111-4111-8111-111111111111",
        });
        await writeMaintenanceHold(harness.config.dataDir, {
          version: 1,
          id: "held-generation-boot",
          ownerId: "test-owner",
          kind: "startup",
          phase: "held",
          serverHostId: hostId,
          createdAt: 1,
          artifact: null,
        });

        if (mode === "manual-import") {
          upsertHost(harness.db, harness.hub, {
            id: "host-import-source",
            name: "Source",
          });
          upsertHost(harness.db, harness.hub, { id: hostId, name: "Target" });
          updateHost(harness.db, harness.hub, hostId, {
            machineProviderId: "manual",
          });
          await writeFile(
            join(harness.config.dataDir, "host-id"),
            `${hostId}\n`,
          );
          await writeServerImportFile(harness.config.dataDir, {
            version: 1,
            kind: "manual",
            moveId: null,
            activationToken: null,
            sourceDataDir: "/tmp/source-generation-server",
            sourceServerHostId: "host-import-source",
            targetHostId: null,
            serverUrl: null,
            importedEntries: ["app.db", "plugins/npm"],
            createdAt: 1,
            fixupsAppliedAt: 1,
          });
        }

        const frozen = createApp(harness.deps, {
          serverMove: {
            appSurface: "web",
            bindHost: null,
            manualImportPending: mode === "manual-import",
            pending: null,
            restoredRun: null,
            retireProcess() {},
          },
        });

        try {
          const response = await frozen.app.request(
            "/internal/session/open",
            sessionRequest(hostId),
          );

          expect(response.status).toBe(201);
          expect(
            hostDaemonSessionOpenResponseSchema.parse(await response.json())
              .pluginHostGenerations,
          ).toEqual([]);
          expect(
            getPluginHostGeneration(harness.db, "previous-worker"),
          ).toBeUndefined();
          expect(
            frozen.pluginService.getMaintenanceActivity().pluginLoads,
          ).toBe(0);
          expect(
            frozen.pluginService
              .list()
              .some((plugin) => plugin.status === "running"),
          ).toBe(false);

          if (mode === "manual-import") {
            expect(
              await readServerImportFile(harness.config.dataDir),
            ).toBeNull();
            expect(getHost(harness.db, hostId)?.machineProviderId).toBeNull();
            expect(
              getHost(harness.db, "host-import-source")?.machineProviderId,
            ).toBe("manual");
          }
        } finally {
          await frozen.pluginService.stop();
        }
      });
    },
  );

  it.each(["startup", "maintenance-resume"])(
    "rejects session reconciliation without side effects until %s accepts the full plugin set",
    async (mode) => {
      await withTestHarness(async (harness) => {
        const rootDir = join(harness.config.dataDir, "generation-plugin");
        await mkdir(rootDir, { recursive: true });
        await writeFile(
          join(rootDir, "package.json"),
          JSON.stringify({
            name: "omnyo-plugin-aaa-generation",
            version: "0.1.0",
            omnyo: {
              name: "Generation fixture",
              description: "Session lifecycle fixture",
              branding: { icon: "Zap" },
              server: "./server.ts",
              host: "./host.ts",
            },
          }),
        );
        await writeFile(
          join(rootDir, "server.ts"),
          "export default function plugin() {}",
        );
        await writeFile(
          join(rootDir, "host.ts"),
          `const schema = { "~standard": { validate(value) { return { value }; } } };
           export default {
             experimental_apiVersion: 1,
             contract: { ping: { input: schema, output: schema } },
             handlers: { ping: (input) => input },
           };`,
        );
        expect((await harness.pluginService.installPath(rootDir)).status).toBe(
          "running",
        );
        await harness.pluginService.stop();

        const hold = {
          sources: listBundledPluginRegistrations().map(
            (plugin) => `builtin:${plugin.name}`,
          ),
          detail: "Builtin services held by session fixture",
          isActive: async () => true,
        };

        if (mode === "maintenance-resume") {
          await harness.pluginService.start({ hold });
          await harness.pluginService.suspendPlugins({
            keep: () => false,
            strict: true,
          });
        }

        let release = () => {};

        let enter = () => {};

        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });

        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });

        vi.stubGlobal("__generationFactoryGate", gate);
        vi.stubGlobal("__generationFactoryEntered", enter);
        await writeFile(
          join(rootDir, "server.ts"),
          `export default async function plugin() {
             globalThis.__generationFactoryEntered();
             await globalThis.__generationFactoryGate;
           }`,
        );

        const { host, session: previousSession } = seedHostSession(
          harness.deps,
          { id: "host-generation-existing" },
        );

        const previousHost = getHost(harness.db, host.id);

        const loading =
          mode === "startup"
            ? harness.pluginService.start({ hold })
            : harness.pluginService.resumeMaintenancePlugins();

        try {
          await entered;

          const denied = await harness.app.request(
            "/internal/session/open",
            sessionRequest(host.id),
          );

          expect(denied.status).toBe(503);
          expect(await denied.json()).toMatchObject({ retryable: true });
          expect(
            getLatestSessionForHost(harness.db, { hostId: host.id })?.id,
          ).toBe(previousSession.id);
          expect(getHost(harness.db, host.id)).toEqual(previousHost);

          const newHostId = "host-generation-new";

          const deniedNewHost = await harness.app.request(
            "/internal/session/open",
            sessionRequest(newHostId),
          );

          expect(deniedNewHost.status).toBe(503);
          expect(getHost(harness.db, newHostId)).toBeNull();
          expect(
            getLatestSessionForHost(harness.db, { hostId: newHostId }),
          ).toBeNull();

          const unauthenticated = await harness.app.request(
            "/internal/session/open",
            { ...sessionRequest(host.id), headers: {} },
          );

          expect(unauthenticated.status).toBe(401);

          const wrongHost = await harness.app.request(
            "/internal/session/open",
            sessionRequest(host.id, { authenticatedHostId: "another-host" }),
          );

          expect(wrongHost.status).toBe(403);

          const wrongProtocol = await harness.app.request(
            "/internal/session/open",
            sessionRequest(host.id, {
              protocolVersion: 234,
            }),
          );

          expect(wrongProtocol.status).toBe(400);
          expect(await wrongProtocol.json()).toMatchObject({
            code: "protocol_version_mismatch",
          });
        } finally {
          release();
          await loading;
          vi.unstubAllGlobals();
        }

        const accepted = await harness.app.request(
          "/internal/session/open",
          sessionRequest(host.id),
        );

        expect(accepted.status).toBe(201);

        const opened = hostDaemonSessionOpenResponseSchema.parse(
          await accepted.json(),
        );

        expect(opened.pluginHostGenerations).toEqual(
          harness.pluginService.listHostArtifactGenerations(),
        );
        expect(opened.pluginHostGenerations).toContainEqual({
          pluginId: "aaa-generation",
          generation: expect.any(String),
        });
        expect(opened.sessionId).not.toBe(previousSession.id);
      });
    },
  );
});
