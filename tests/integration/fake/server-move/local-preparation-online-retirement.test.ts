import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  getAppSettings,
  getHost,
  getSessionById,
  getThread,
  openSession,
  hosts,
  serverAccessRetirements,
  setAppSettings,
} from "@omnyo/db";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../../../../apps/server/test/helpers/seed.js";
import { startTestServer } from "../../../../apps/server/test/helpers/test-app.js";
import { registerServerMoveFixtureCleanup } from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import { connectIssuedWorker } from "./access-fixture.js";
import { writeInertPlugin } from "./preparation-fixture.js";
import {
  createDirectProof,
  directAccessState,
} from "../../../../apps/server/src/services/machines/direct-access-state.js";

registerServerMoveFixtureCleanup();

describe("online direct-access retirement", () => {
  it.each([
    "complete",
    "missing-ws",
    "changed-row",
    "changed-session",
    "owned-handoff",
    "foreign-handoff",
    "reserving-handoff",
    "uncommitted-handoff",
    "changed-hold",
    "changed-hold-on-release",
    "release-failed",
  ])(
    "requires stable owned fresh proofs while preserving busy work (%s)",
    async (mode) => {
      const omitWebSocket = mode === "missing-ws";
      const completes = mode === "complete" || mode === "owned-handoff";
      const server = await startTestServer({ seedFirstPartyProviders: false });
      let worker: Awaited<ReturnType<typeof connectIssuedWorker>> | undefined;
      let replacementSessionId: string | null = null;

      try {
        seedHost(server.deps, { id: "host-online-primary" });
        seedPrimaryHost(server.deps, "host-online-primary");
        seedHost(server.deps, { id: "host-online-worker" });
        server.db
          .update(hosts)
          .set({
            serverAccessProviderId: "direct",
            serverAccessGrantId: "host-online-worker",
          })
          .where(eq(hosts.id, "host-online-worker"))
          .run();
        setAppSettings(server.db, {
          ...getAppSettings(server.db),
          machineServerUrl: server.baseUrl,
        });
        const releases = join(server.config.dataDir, "online-releases.jsonl");
        const releaseEntered = join(server.config.dataDir, "release-entered");
        const releaseResume = join(server.config.dataDir, "release-resume");

        const plugin = await writeInertPlugin(
          server.config.dataDir,
          "online-access-owner",
          `import {appendFileSync,existsSync} from 'node:fs'; export default function plugin(api) { api.experimental_serverAccess.register({ id:'inert-online', displayName:'Owned relay', description:'No external provider', availability:async()=>({status:'available'}), acquire:async()=>({id:'unused',serverUrl:${JSON.stringify(server.baseUrl)}}), release:async(value)=>{if (${mode === "release-failed"}) throw new Error('Owned release refused'); if (${mode === "changed-hold-on-release"}) {appendFileSync(${JSON.stringify(releaseEntered)},'entered');const deadline=Date.now()+5000;while(!existsSync(${JSON.stringify(releaseResume)})){if(Date.now()>deadline) throw new Error('Release barrier timed out');await new Promise(resolve=>setTimeout(resolve,5));}} appendFileSync(${JSON.stringify(releases)},JSON.stringify(value)+'\\n'); } }); }`,
        );

        await server.pluginService.installPath(plugin);
        server.db
          .insert(serverAccessRetirements)
          .values({
            hostId: "host-online-worker",
            providerId: "inert-online",
            grantId: "old-online-grant",
            acquisitionKey: "old-online-owner",
            serverUrl: server.baseUrl,
            challenge: "old-process-challenge",
            primaryProofRuntimeId: "old-process-runtime",
            createdAt: 1,
          })
          .run();

        const { project } = seedProjectWithSource(server.deps, {
          hostId: "host-online-worker",
        });

        const environment = seedEnvironment(server.deps, {
          projectId: project.id,
          hostId: "host-online-worker",
        });

        worker = await connectIssuedWorker(
          server,
          "host-online-worker",
          undefined,
          {
            busy: true,
            omitWebSocket,
            beforeProof:
              mode === "changed-row"
                ? async () => {
                    server.db
                      .update(serverAccessRetirements)
                      .set({ grantId: "replacement-grant" })
                      .where(
                        eq(
                          serverAccessRetirements.hostId,
                          "host-online-worker",
                        ),
                      )
                      .run();
                  }
                : mode === "changed-session"
                  ? async () => {
                      replacementSessionId = openSession(server.db, {
                        hostId: "host-online-worker",
                        instanceId: "replacement-authenticated-session",
                        hostName: "Owned inert issued worker",
                        dataDir: "/tmp/replacement-session",
                        protocolVersion: 236,
                        heartbeatIntervalMs: 5_000,
                        leaseTimeoutMs: 30_000,
                      }).id;
                    }
                  : mode === "changed-hold"
                    ? async () => {
                        directAccessState(server.deps).holds.set(
                          "host-online-worker",
                          "replacement-handoff-owner",
                        );
                      }
                    : undefined,
          },
        );

        const thread = seedThread(server.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "active",
        });

        const sessionId = worker.sessionId();
        const hostBefore = getHost(server.db, "host-online-worker");
        const configPath = join(worker.fixture.dataDir, "config.json");
        await writeFile(
          configPath,
          JSON.stringify({ serverUrl: server.baseUrl }),
        );
        const configBefore = await readFile(configPath);
        const state = directAccessState(server.deps);
        let heldChallenge: string | undefined;

        if (
          [
            "owned-handoff",
            "foreign-handoff",
            "uncommitted-handoff",
            "changed-hold",
            "changed-hold-on-release",
            "release-failed",
          ].includes(mode)
        ) {
          const handoff = createDirectProof(
            server.deps,
            "host-online-worker",
            server.baseUrl,
            "retired-primary-session",
          );

          handoff.committed = mode !== "uncommitted-handoff";
          handoff.http = true;
          handoff.ws = true;
          handoff.expiresAt = Date.now() - 1;
          heldChallenge = handoff.challenge;

          if (mode !== "foreign-handoff") {
            server.db
              .update(serverAccessRetirements)
              .set({ challenge: heldChallenge })
              .where(eq(serverAccessRetirements.hostId, "host-online-worker"))
              .run();
          }
        } else if (mode === "reserving-handoff") {
          heldChallenge = "reserving";
          state.holds.set("host-online-worker", heldChallenge);
        }

        const requests = Array.from({ length: completes ? 2 : 1 }, () =>
          fetch(
            `${server.baseUrl}/api/v1/hosts/host-online-worker/direct-access`,
            { method: "POST" },
          ),
        );

        if (mode === "changed-hold-on-release") {
          await expect
            .poll(async () =>
              readFile(releaseEntered).then(
                () => true,
                () => false,
              ),
            )
            .toBe(true);
          state.holds.set("host-online-worker", "replacement-handoff-owner");
          await writeFile(releaseResume, "resume");
        }

        const responses = await Promise.all(requests);

        expect(responses.map((response) => response.status)).toEqual(
          completes ? [200, 200] : [409],
        );

        if (
          mode === "foreign-handoff" ||
          mode === "reserving-handoff" ||
          mode === "uncommitted-handoff"
        ) {
          expect(worker.events).not.toContain("current-primary-proof-entered");
        } else {
          expect(worker.events).toContain("current-primary-proof-entered");
        }

        if (mode === "changed-session") {
          expect(replacementSessionId).toEqual(expect.any(String));
          expect(replacementSessionId).not.toBe(sessionId);
          expect(
            getSessionById(server.db, {
              sessionId: worker.firstSessionId,
            }),
          ).toMatchObject({ status: "closed", closeReason: "replaced" });
          expect(
            replacementSessionId
              ? getSessionById(server.db, { sessionId: replacementSessionId })
              : null,
          ).toMatchObject({
            id: replacementSessionId,
            hostId: "host-online-worker",
            instanceId: "replacement-authenticated-session",
          });
        } else {
          expect(worker.sessionId()).toBe(sessionId);
        }

        expect(worker.events).not.toContain("restart-requested");
        expect(
          await readFile(join(worker.fixture.dataDir, "config.json")),
        ).toEqual(configBefore);
        expect(getThread(server.db, thread.id)?.status).toBe("active");

        if (mode === "changed-session") {
          expect(getHost(server.db, "host-online-worker")).toMatchObject({
            id: hostBefore?.id,
            phase: "active",
            serverAccessProviderId: "direct",
            serverAccessGrantId: "host-online-worker",
          });
        } else {
          expect(getHost(server.db, "host-online-worker")).toEqual(hostBefore);
        }

        const retirement = server.db
          .select()
          .from(serverAccessRetirements)
          .where(eq(serverAccessRetirements.hostId, "host-online-worker"))
          .get();

        if (!completes) {
          expect(retirement?.grantId).toBe(
            mode === "changed-row" ? "replacement-grant" : "old-online-grant",
          );

          if (mode === "changed-hold-on-release") {
            expect(
              JSON.parse((await readFile(releases, "utf8")).trim()),
            ).toEqual({
              key: "old-online-owner",
              hostId: "host-online-worker",
              grantId: "old-online-grant",
            });
          } else {
            await expect(readFile(releases, "utf8")).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } else {
          expect(retirement).toBeUndefined();
          expect(JSON.parse((await readFile(releases, "utf8")).trim())).toEqual(
            {
              key: "old-online-owner",
              hostId: "host-online-worker",
              grantId: "old-online-grant",
            },
          );

          const repeat = await fetch(
            `${server.baseUrl}/api/v1/hosts/host-online-worker/direct-access`,
            { method: "POST" },
          );

          expect(repeat.status).toBe(200);
          expect(
            (await readFile(releases, "utf8")).trim().split("\n"),
          ).toHaveLength(1);
        }

        expect(state.holds.get("host-online-worker")).toBe(
          completes
            ? undefined
            : mode === "changed-hold" || mode === "changed-hold-on-release"
              ? "replacement-handoff-owner"
              : heldChallenge,
        );

        if (completes && heldChallenge !== undefined) {
          expect(state.proofs.has(heldChallenge)).toBe(false);
        }
      } finally {
        await worker?.stop();
        await server.close();
      }
    },
  );
});
