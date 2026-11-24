import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import {
  createFixture,
  registerServerMoveFixtureCleanup,
  prepareCommand,
  activateCommand,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import { createServerMoveCoordinator } from "../../../../apps/server/src/services/server-move/coordinator.js";
import { isServerMoveFrozen } from "../../../../apps/server/src/services/server-move/freeze-state.js";
import { reconcileServerMoveRunAtBoot } from "../../../../apps/server/src/services/server-move/reconcile.js";
import {
  createTestServerMoveEnvironment,
  inspectResult,
  registerFakeDaemon,
} from "../../../../apps/server/test/helpers/server-move.js";
import {
  seedHost,
  seedPrimaryHost,
} from "../../../../apps/server/test/helpers/seed.js";
import { withTestHarness } from "../../../../apps/server/test/helpers/test-app.js";
import { readJsonIfPresent } from "./preparation-fixture.js";

registerServerMoveFixtureCleanup();

function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

describe("positive target fence through the production daemon", () => {
  it("proves pending process death before a receipt and prevents a late prepare after daemon restart", async () => {
    const fixture = await createFixture();
    const command = await prepareCommand(fixture);
    const prepared = await fixture.service.prepare(command);
    expect(alive(prepared.pid)).toBe(true);

    const receipt = await fixture.service.abort({
      type: "server_move.abort",
      moveId: command.moveId,
    });

    expect(receipt).toEqual({ ok: true, moveId: command.moveId, fenced: true });
    expect(alive(prepared.pid)).toBe(false);
    const restarted = fixture.createService();
    await expect(restarted.prepare(command)).rejects.toThrow(/fenced/u);
    await expect(
      restarted.activate({
        ...activateCommand,
        moveId: command.moveId,
        activationToken: command.activationToken,
      }),
    ).rejects.toThrow(/fenced/u);
  });

  it("waits for the actual in-flight preparation to stop before fencing and refuses its late continuation", async () => {
    const fixture = await createFixture();
    const entered = createDeferredPromise<void>();
    const transport = createDeferredPromise<void>();

    const service = fixture.createService({
      fetchFn: async (url, init) => {
        entered.resolve();
        await transport.promise;

        return fetch(url, init);
      },
    });

    const command = await prepareCommand(fixture);
    const preparing = service.prepare(command);

    const observed = preparing.then(
      () => "prepared",
      () => "refused",
    );

    await entered.promise;
    let acknowledged = false;

    const aborting = service
      .abort({ type: "server_move.abort", moveId: command.moveId })
      .then((value) => {
        acknowledged = true;

        return value;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      expect(acknowledged).toBe(false);
    } finally {
      transport.resolve();
    }

    expect(await observed).toBe("refused");
    expect(await aborting).toEqual({
      ok: true,
      moveId: command.moveId,
      fenced: true,
    });
    await expect(fixture.createService().prepare(command)).rejects.toThrow(
      /fenced/u,
    );
  });

  it("refuses abort after actual activation instead of reviving a stale source", async () => {
    const fixture = await createFixture();
    await fixture.service.prepare(await prepareCommand(fixture));
    await fixture.service.activate(activateCommand);
    await expect.poll(() => fixture.shutdownRequests.length).toBe(1);
    await expect(
      fixture.service.abort({
        type: "server_move.abort",
        moveId: activateCommand.moveId,
      }),
    ).rejects.toThrow(/activated/u);
    expect(
      await readJsonIfPresent(join(fixture.dataDir, "last-server-move.json")),
    ).toMatchObject({ moveId: activateCommand.moveId });
  });

  it.each(["positive", "lost", "unreachable"] as const)(
    "keeps source admission closed until %s transport has a real daemon fence",
    async (mode) => {
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          const source = "host-inert-fence-source",
            target = "host-target";

          seedHost(harness.deps, { id: source });
          seedPrimaryHost(harness.deps, source);
          seedHost(harness.deps, { id: target });
          const fixture = await createFixture();
          const entered = createDeferredPromise<void>();
          const deliverPrepare = createDeferredPromise<void>();
          const allowFence = createDeferredPromise<void>();
          const fenceEntered = createDeferredPromise<void>();
          const file = join(harness.config.dataDir, "inert-fence-package.tgz");
          const bytes = Buffer.from("inert fence transport bytes");
          await writeFile(file, bytes);

          const { environment } = createTestServerMoveEnvironment(harness, {
            fullArtifact: {
              availability: async () => ({
                available: true,
                unpackedSizeBytes: bytes.length,
                version: harness.config.appVersion,
              }),
              build: async () => ({
                path: file,
                sizeBytes: bytes.length,
                version: harness.config.appVersion,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                runtimeSha256: "0".repeat(64),
              }),
            },
          });

          const coordinator = createServerMoveCoordinator(environment);
          let targetPid: number | undefined;
          let command: Awaited<ReturnType<typeof prepareCommand>> | undefined;
          let drop = mode === "lost";

          const trace: {
            sourceAdmitted: boolean;
            targetProcessAlive: boolean;
          }[] = [];

          registerFakeDaemon(harness, {
            hostId: target,
            events: [],
            handle: async (message) => {
              if (message.command.type === "server_move.inspect")
                return {
                  ok: true,
                  result: inspectResult({
                    coreVersion: harness.config.appVersion,
                  }),
                };

              if (message.command.type === "server_move.prepare") {
                command = await prepareCommand(fixture, {
                  moveId: message.command.moveId,
                  activationToken: message.command.activationToken,
                });
                const result = await fixture.service.prepare(command);
                targetPid = result.pid;
                entered.resolve();
                await deliverPrepare.promise;

                return { ok: true, result };
              }

              if (message.command.type === "server_move.abort") {
                fenceEntered.resolve();
                await allowFence.promise;

                if (mode === "unreachable")
                  throw new Error("Inert unreachable target");
                const receipt = await fixture.service.abort(message.command);

                if (drop) {
                  drop = false;
                  throw new Error(
                    "Inert lost acknowledgement after actual fencing",
                  );
                }

                return { ok: true, result: receipt };
              }

              if (message.command.type === "server_move.probe")
                return {
                  ok: true,
                  result: {
                    reachable: false,
                    state: null,
                    message: "Inert recovery control",
                  },
                };
              throw new Error(
                `Unexpected fixture command ${message.command.type}`,
              );
            },
          });

          try {
            await coordinator.start({
              targetHostId: target,
              serverUrl: "https://inert-fence.example.test",
              stopRunningWork: true,
              archiveExistingTargetServerData: false,
            });
            await entered.promise;
            const cancelling = Promise.resolve(coordinator.cancel());
            await fenceEntered.promise;
            trace.push({
              sourceAdmitted: !isServerMoveFrozen(harness.db),
              targetProcessAlive: targetPid !== undefined && alive(targetPid),
            });
            expect(isServerMoveFrozen(harness.db)).toBe(true);
            allowFence.resolve();
            await cancelling;

            if (mode === "positive") {
              await expect
                .poll(() => isServerMoveFrozen(harness.db))
                .toBe(false);
              expect(alive(targetPid ?? 0)).toBe(false);
              await expect(
                fixture.createService().prepare(command!),
              ).rejects.toThrow(/fenced/u);
            } else {
              await expect
                .poll(() => coordinator.getStatus()?.state)
                .toBe("recovery_required");
              expect(isServerMoveFrozen(harness.db)).toBe(true);

              const restored = await reconcileServerMoveRunAtBoot({
                dataDir: harness.config.dataDir,
                logger: harness.deps.logger,
                now: Date.now(),
              });

              expect(restored?.kind).toBe("recovery_required");

              if (mode === "lost") {
                await coordinator.cancel();
                await expect
                  .poll(() => isServerMoveFrozen(harness.db))
                  .toBe(false);
              }
            }

            trace.push({
              sourceAdmitted: !isServerMoveFrozen(harness.db),
              targetProcessAlive: targetPid !== undefined && alive(targetPid),
            });
            expect(
              trace.every(
                (point) => !(point.sourceAdmitted && point.targetProcessAlive),
              ),
            ).toBe(true);
            await writeFile(
              join(harness.config.dataDir, "sole-writer-trace.json"),
              JSON.stringify(trace),
            );
          } finally {
            allowFence.resolve();
            deliverPrepare.resolve();
            coordinator.dispose();
          }
        },
      );
    },
  );
});
