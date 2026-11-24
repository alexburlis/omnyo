import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { symlink, rm } from "node:fs/promises";
import { resolveBundledNpmCli } from "../../../../packages/plugin-build/src/npm-cli.js";
import { createFullOmnyoAppArtifactService } from "../../../../apps/server/src/services/server-move/full-artifact.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getPluginKvValue,
  setPluginKvValue,
  createConnection,
} from "@omnyo/db";
import { exportServerArchive } from "../../../../apps/server/src/services/server-move/export.js";
import { SERVER_EXPORT_FREE_SPACE } from "../../../../apps/server/src/services/server-move/export-snapshot.js";
import { withTestHarness } from "../../../../apps/server/test/helpers/test-app.js";
import {
  seedHost,
  seedPrimaryHost,
} from "../../../../apps/server/test/helpers/seed.js";
import {
  createFixture,
  freePort,
  listen,
  prepareCommand,
  registerServerMoveFixtureCleanup,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import {
  disableBundledOwners,
  launchOwnedServer,
  readJsonIfPresent,
  writeInertPlugin,
  type OwnedServerProcess,
} from "./preparation-fixture.js";

registerServerMoveFixtureCleanup();

describe("actual imported promotion and restart", () => {
  it("keeps copied owners held through daemon preparation, promotion and production restart until matching release", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await disableBundledOwners(harness);
        seedHost(harness.deps, { id: "host-source" });
        seedPrimaryHost(harness.deps, "host-source");
        seedHost(harness.deps, { id: "host-target" });
        const fixture = await createFixture();
        const trace = join(fixture.root, "copied-owner-trace.txt");
        const builtRoot = resolve("../../packages/omnyo-app");
        const targetRoot = fixture.packageRoot;

        const artifact = await createFullOmnyoAppArtifactService({
          dataDir: join(fixture.root, "artifact-cache"),
          serverEntryUrl: pathToFileURL(join(builtRoot, "server/dist/index.js"))
            .href,
          commandRunner: async (_command, args, cwd) =>
            (
              await promisify(execFile)(
                process.execPath,
                [resolveBundledNpmCli(), ...args, "--offline"],
                {
                  cwd,
                  env: {
                    PATH: process.env.PATH ?? "",
                    HOME: fixture.root,
                    npm_config_cache: join(fixture.root, "npm-cache"),
                  },
                },
              )
            ).stdout,
        }).build();

        const packagedStartServerUrl = pathToFileURL(
          join(targetRoot, "server/dist/start-server.js"),
        ).href;

        const pluginRoot = await writeInertPlugin(
          harness.config.dataDir,
          "inert-promoted-owner",
          `import {appendFileSync} from 'node:fs'; export default function plugin(api){api.background.service('owned',{start(signal){appendFileSync(${JSON.stringify(trace)},'service\\n');return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}});}`,
        );

        await harness.pluginService.installPath(pluginRoot);
        await harness.pluginService.stop();
        await writeFile(trace, "");
        setPluginKvValue(
          harness.db,
          "inert-promoted-owner",
          "owner-state",
          JSON.stringify({ body: "retained loop", cadence: 91 }),
        );
        const workDir = join(harness.config.dataDir, "inert-export");
        await mkdir(workDir);

        const archive = await exportServerArchive({
          appVersion: harness.config.appVersion,
          dataDir: harness.config.dataDir,
          db: harness.db,
          fileName: "archive.tgz",
          freeSpace: SERVER_EXPORT_FREE_SPACE,
          logger: harness.deps.logger,
          now: Date.now(),
          sourceServerHostId: "host-source",
          vault: harness.deps.vault,
          workDir,
        });

        const transport = await listen((request, response) => {
          response.setHeader(
            "content-length",
            String(
              request.url === "/app-runtime"
                ? artifact.sizeBytes
                : archive.sizeBytes,
            ),
          );
          createReadStream(
            request.url === "/app-runtime" ? artifact.path : archive.path,
          ).pipe(response);
        });

        const port = await freePort();
        let pending: OwnedServerProcess | undefined;
        let promoted: OwnedServerProcess | undefined;

        const service = fixture.createService({
          serverUrl: transport.url,
          installOmnyoApp: async (tarball) => {
            await rm(targetRoot, { recursive: true, force: true });
            await mkdir(targetRoot, { recursive: true });
            await promisify(execFile)("tar", [
              "-xzf",
              tarball,
              "--strip-components=1",
              "-C",
              targetRoot,
            ]);
            await symlink(
              join(builtRoot, "node_modules"),
              join(targetRoot, "node_modules"),
              "dir",
            );
          },
          launchPendingServer: async (request) => {
            pending = await launchOwnedServer({
              launchId: request.env.OMNYO_SERVER_LAUNCH_ID,
              dataDir: request.dataDir,
              port: request.serverPort,
              detached: true,
              startServerUrl: packagedStartServerUrl,
            });

            return pending.child.pid!;
          },
        });

        const command = await prepareCommand(fixture, {
          serverPort: port,
          appRuntime: {
            downloadPath: "/app-runtime",
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            version: artifact.version,
            runtimeSha256: artifact.runtimeSha256,
          },
          archive: {
            downloadPath: "/archive",
            sha256: archive.sha256,
            sizeBytes: archive.sizeBytes,
          },
          sourceDataDir: harness.config.dataDir,
          sourceServerHostId: "host-source",
        });

        try {
          await service.prepare(command);
          expect(await readFile(trace, "utf8")).toBe("");
          expect(
            await readJsonIfPresent(
              join(fixture.dataDir, "server-maintenance-hold.json"),
            ),
          ).toMatchObject({
            id: command.moveId,
            phase: "held",
            kind: "migration",
          });
          await service.activate({
            type: "server_move.activate",
            moveId: command.moveId,
            activationToken: command.activationToken,
            lastMove: {
              moveId: command.moveId,
              fromHostId: "host-source",
              fromHostName: "inert",
              toHostId: "host-target",
              toHostName: "inert",
              completedAt: Date.now(),
              oldCopyDeletedAt: null,
            },
          });

          try {
            await expect
              .poll(() => fixture.shutdownRequests.length, { timeout: 15_000 })
              .toBe(1);
          } catch (error) {
            throw new Error(
              JSON.stringify(fixture.logger.error.mock.calls, (_key, value) =>
                value instanceof Error ? value.message : value,
              ),
              { cause: error },
            );
          }

          await pending?.stop();
          promoted = await launchOwnedServer({
            dataDir: fixture.dataDir,
            port,
            startServerUrl: packagedStartServerUrl,
          });
          await promoted.stop();
          const tamperedPath = join(targetRoot, "dist", "index.js");
          const originalBytes = await readFile(tamperedPath);

          try {
            await writeFile(
              tamperedPath,
              Buffer.concat([
                originalBytes,
                Buffer.from("\n// inert tamper\n"),
              ]),
            );
            await expect(
              launchOwnedServer({
                dataDir: fixture.dataDir,
                port,
                startServerUrl: packagedStartServerUrl,
              }),
            ).rejects.toThrow(/Runtime identity inventory digest mismatch/u);
          } finally {
            await writeFile(tamperedPath, originalBytes);
          }

          promoted = await launchOwnedServer({
            dataDir: fixture.dataDir,
            port,
            startServerUrl: packagedStartServerUrl,
          });
          expect(await readFile(trace, "utf8")).toBe("");

          const maintenance = await fetch(
            `${promoted.baseUrl}/api/v1/server/maintenance`,
          );

          expect(maintenance.status).toBe(200);
          expect(await maintenance.json()).toMatchObject({
            hold: {
              id: command.moveId,
              phase: "held",
              artifact: {
                archiveSha256: artifact.sha256,
                runtimeSha256: artifact.runtimeSha256,
              },
            },
            runtime: {
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              appVersion: artifact.version,
            },
          });

          const wrong = await fetch(
            `${promoted.baseUrl}/api/v1/server/maintenance/release`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: command.moveId,
                ownerId: "wrong-owner",
                expectedServerHostId: "host-target",
              }),
            },
          );

          expect(wrong.status).toBe(409);

          const released = await fetch(
            `${promoted.baseUrl}/api/v1/server/maintenance/release`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: command.moveId,
                ownerId: command.moveId,
                expectedServerHostId: "host-target",
              }),
            },
          );

          expect(released.status, await released.clone().text()).toBe(200);
          await expect
            .poll(
              async () =>
                (await readFile(trace, "utf8")).trim().split("\n").length,
            )
            .toBe(1);

          const receiptDir = fileURLToPath(
            new URL("../../.local-server-move-artifacts/", import.meta.url),
          );

          await mkdir(receiptDir, { recursive: true });
          await writeFile(
            join(receiptDir, "packaged-promotion-receipt.json"),
            JSON.stringify(
              {
                schemaVersion: 1,
                archiveSha256: artifact.sha256,
                runtimeSha256: artifact.runtimeSha256,
                runtimeVersion: artifact.version,
                hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
                installedRoot: targetRoot,
                bootEntry: packagedStartServerUrl,
                tamperedBootRefused: true,
                promotedAndRestartedHeld: true,
                matchingOwnerRelease: true,
                osPromotion: "inert fixture",
                input: "actual locally produced runtime archive",
              },
              null,
              2,
            ) + "\n",
          );
          const db = createConnection(join(fixture.dataDir, "app.db"));

          try {
            expect(
              JSON.parse(
                getPluginKvValue(db, "inert-promoted-owner", "owner-state")!,
              ),
            ).toEqual({ body: "retained loop", cadence: 91 });
          } finally {
            db.$client.close();
          }
        } finally {
          await promoted?.stop();
          await pending?.stop();
        }
      },
    );
  });
});
