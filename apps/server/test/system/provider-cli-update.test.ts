import {
  getThread,
  getAppSettings,
  setAppSettings,
  hostDaemonSessions,
  listEvents,
  listQueuedThreadMessages,
} from "@omnyo/db";
import {
  providerCliInstallEventSchema,
  type HostDaemonOnlineRpcRequestMessage,
  type ProviderInstallationOperation,
} from "@omnyo/host-daemon-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { beginProviderCliStartup } from "../../src/services/system/provider-cli-startup.js";
import {
  isHostUpdateDraining,
  reserveHostUpdateDrain,
} from "../../src/services/system/server-update-drain.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  currentWorkspaceIdentity,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  seedHostSession,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function deferred() {
  let resolve = () => {};

  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });

  return { promise, resolve };
}

function seedRunningThread(
  harness: TestAppHarness,
  id: string,
  status: "active" | "idle" = "active",
) {
  const fixture = seedThreadFixture(harness, {
    session: { id },
    thread: { status },
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-cli-update-thread",
    inputText: "Finish the requested task",
    model: "gpt-5",
    permissionMode: "auto",
    reasoningLevel: "high",
    serviceTier: "default",
  });
  seedTurnStarted(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-cli-update-thread",
    turnId: "provider-cli-update-turn",
  });

  return fixture;
}

function startUpdate(harness: TestAppHarness, hostId: string) {
  return harness.app.request(`/api/v1/hosts/${hostId}/provider-clis/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "codex",
      actionKind: "update",
      confirmInterruptingThreads: true,
    }),
  });
}

function readEvents(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => providerCliInstallEventSchema.parse(JSON.parse(line)));
}

function operationFor(
  command: Extract<
    HostDaemonOnlineRpcRequestMessage["command"],
    { type: "provider.installation.start" }
  >,
  state: ProviderInstallationOperation["state"],
): ProviderInstallationOperation {
  return {
    operationId: command.operationId,
    providerId: command.providerId,
    action: command.action,
    state,
    events:
      state === "completed"
        ? [
            {
              type: "completed",
              provider: command.providerId,
              exitCode: 0,
              signal: null,
              success: true,
            },
          ]
        : state === "failed"
          ? [
              {
                type: "error",
                provider: command.providerId,
                code: "provider_installation_verification_failed",
                message: "The installed version did not change.",
              },
            ]
          : [],
  };
}

function contextResponse(
  request: HostDaemonOnlineRpcRequestMessage,
): HostRpcHandlerResult {
  if (request.command.type === "host.prepare_workspace_identity_v1") {
    return {
      ok: true,
      result: currentWorkspaceIdentity(request.command.rootPath),
    };
  }

  if (request.command.type === "host.read_workspace_agent_context") {
    return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
  }

  throw new Error(`Unexpected RPC ${request.command.type}`);
}

describe("provider CLI Update now", () => {
  it("does not hold or inspect a machine when startup updates are disabled", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedRunningThread(harness, "startup-disabled", "idle");
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        autoUpdateProviderClisOnStartup: false,
      });
      await beginProviderCliStartup(
        harness.deps,
        fixture.host.id,
        fixture.session.id,
      );
      expect(isHostUpdateDraining(harness.deps, fixture.host.id)).toBe(false);
    });
  });

  it.each(["completed", "failed"] as const)(
    "holds startup dispatch through a %s provider update",
    async (outcome) => {
      await withTestHarness(async (harness) => {
        const fixture = seedRunningThread(
          harness,
          `startup-${outcome}`,
          "idle",
        );

        const statusReady = deferred();
        const finish = deferred();
        let operation: ProviderInstallationOperation | null = null;

        const responder = registerHostRpcResponder(harness, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          async handle(request) {
            if (request.command.type === "provider.health")
              return { ok: true, result: { supported: false } };

            if (request.command.type === "provider.installation.status")
              return {
                ok: true,
                result: {
                  executableName: "codex",
                  executablePath: "/bin/codex",
                  installed: request.command.providerId === "codex",
                  installSource: "external",
                  currentVersion: "1.0.0",
                  latestVersion: "2.0.0",
                  minimumSupportedVersion: null,
                  npmPackageName: null,
                  npmGlobalPackageVersion: null,
                  installAction: {
                    kind: "update",
                    label: "Update",
                    command: "codex update",
                  },
                  needsUpdate: true,
                  versionUnsupported: false,
                },
              };

            if (request.command.type === "provider.installation.start") {
              operation = operationFor(request.command, "installing");

              return { ok: true, result: operation };
            }

            if (request.command.type === "provider.installation.get") {
              statusReady.resolve();
              await finish.promise;

              if (operation === null) throw new Error("Update did not start");
              operation = {
                ...operation,
                state: outcome,
                events: [
                  {
                    type: "completed",
                    provider: "codex",
                    success: outcome === "completed",
                    exitCode: outcome === "completed" ? 0 : 1,
                    signal: null,
                  },
                ],
              };

              return {
                ok: true,
                result: { operation, held: false, holdOwner: null },
              };
            }

            return contextResponse(request);
          },
        });

        const startup = beginProviderCliStartup(
          harness.deps,
          fixture.host.id,
          fixture.session.id,
        );

        expect(isHostUpdateDraining(harness.deps, fixture.host.id)).toBe(true);
        expect(
          beginProviderCliStartup(
            harness.deps,
            fixture.host.id,
            fixture.session.id,
          ),
        ).toBe(startup);
        await statusReady.promise;
        expect(isHostUpdateDraining(harness.deps, fixture.host.id)).toBe(true);
        expect(
          responder.requests.filter(
            ({ command }) => command.type === "provider.installation.start",
          ),
        ).toHaveLength(1);
        finish.resolve();
        await startup;
        expect(isHostUpdateDraining(harness.deps, fixture.host.id)).toBe(false);
        await beginProviderCliStartup(
          harness.deps,
          fixture.host.id,
          fixture.session.id,
        );
        expect(
          responder.requests.filter(
            ({ command }) => command.type === "provider.installation.start",
          ),
        ).toHaveLength(outcome === "completed" ? 1 : 2);

        const statusResponse = await harness.app.request(
          `/api/v1/hosts/${fixture.host.id}/provider-clis/status`,
        );

        expect(statusResponse.status).toBe(200);
        const statuses = await statusResponse.json();

        if (outcome === "failed")
          expect(statuses.codex.startupUpdateError).toContain(
            "Automatic CLI update failed",
          );
        else expect(statuses.codex.startupUpdateError).toBeUndefined();
      });
    },
  );
  it("reconciles an uncertain update on the same session with latest CLIs and automatic updates disabled", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "startup-pending-existing",
      });

      const observed = deferred();
      const finish = deferred();
      let loseResponse = true;
      let restoreClock = () => {};

      let operation: ProviderInstallationOperation | null = null;

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        async handle(request) {
          if (request.command.type === "provider.installation.status")
            return {
              ok: true,
              result: {
                executableName: "codex",
                executablePath: "/bin/codex",
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
              },
            };

          if (request.command.type === "provider.health")
            return { ok: true, result: { supported: false } };

          if (request.command.type === "provider.installation.start") {
            operation = operationFor(request.command, "installing");

            return { ok: true, result: operation };
          }

          if (request.command.type === "provider.installation.get") {
            if (loseResponse) {
              loseResponse = false;

              const now = vi
                .spyOn(Date, "now")
                .mockReturnValue(Date.now() + 16 * 60_000);

              restoreClock = () => now.mockRestore();

              return {
                ok: true,
                result: {
                  operation: null,
                  held: true,
                  holdOwner: request.command.operationId,
                },
              };
            }

            observed.resolve();
            await finish.promise;

            if (operation === null) throw new Error("No installation");
            operation = {
              ...operation,
              state: "completed",
              events: [
                {
                  type: "completed",
                  provider: "codex",
                  success: true,
                  exitCode: 0,
                  signal: null,
                },
              ],
            };

            return {
              ok: true,
              result: { operation, held: false, holdOwner: null },
            };
          }

          return contextResponse(request);
        },
      });

      await beginProviderCliStartup(harness.deps, host.id, session.id);
      const first = await startUpdate(harness, host.id);

      try {
        expect(readEvents(await first.text())).toContainEqual(
          expect.objectContaining({
            type: "error",
            code: "provider_cli_update_outcome_unknown",
          }),
        );
      } finally {
        restoreClock();
      }

      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        autoUpdateProviderClisOnStartup: false,
      });

      const reconnect = beginProviderCliStartup(
        harness.deps,
        host.id,
        session.id,
      );

      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(true);
      await observed.promise;
      finish.resolve();
      await reconnect;
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "provider.installation.start",
        ),
      ).toHaveLength(1);
    });
  });

  it("surfaces failed status checks and clears the failure after all installed CLIs are verified current", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "startup-status-unavailable",
      });

      let statusUnavailable = true;

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle(request) {
          if (
            !statusUnavailable &&
            request.command.type === "provider.installation.status"
          )
            return {
              ok: true,
              result: {
                executableName: "codex",
                executablePath: "/bin/codex",
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
              },
            };

          if (request.command.type === "provider.health")
            return { ok: true, result: { supported: false } };

          return {
            ok: false,
            errorCode: "provider_status_failed",
            errorMessage: "The version query failed",
          };
        },
      });

      await beginProviderCliStartup(harness.deps, host.id, session.id);
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);

      const response = await harness.app.request(
        `/api/v1/hosts/${host.id}/provider-clis/status`,
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: "provider_cli_startup_failed",
      });
      statusUnavailable = false;

      const rechecked = await harness.app.request(
        `/api/v1/hosts/${host.id}/provider-clis/status`,
      );

      expect(rechecked.status).toBe(200);

      const statuses = await rechecked.json();

      expect(statuses.codex.startupUpdateError).toBeUndefined();
      expect(
        responder.requests.some(
          ({ command }) => command.type === "provider.installation.start",
        ),
      ).toBe(false);
    });
  });

  it("holds new messages only on the selected machine", async () => {
    await withTestHarness(async (harness) => {
      const selected = seedRunningThread(
        harness,
        "cli-queued-selected",
        "idle",
      );

      const unrelated = seedRunningThread(
        harness,
        "cli-queued-unrelated",
        "idle",
      );

      const release = reserveHostUpdateDrain(harness.db, selected.host.id);

      const send = (threadId: string) =>
        harness.app.request(`/api/v1/threads/${threadId}/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "A new task" }],
          }),
        });

      const held = await send(selected.thread.id);
      expect(held.status).toBe(200);
      expect(await held.json()).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "server-update" } },
      });
      const running = await send(unrelated.thread.id);
      expect(running.status).toBe(200);
      expect(await running.json()).toMatchObject({ delivery: "sent" });
      expect(getThread(harness.db, unrelated.thread.id)?.status).toBe("active");

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(getThread(harness.db, selected.thread.id)?.status).toBe("idle");
      release();
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(getThread(harness.db, selected.thread.id)?.status).toBe("active");
      expect(listQueuedThreadMessages(harness.db, selected.thread.id)).toEqual(
        [],
      );
    });
  });

  it("updates a provider on an older worker whose protocol is accepted", async () => {
    await withTestHarness({ appVersion: "1.0.50" }, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "cli-older-runtime",
      });

      harness.hub.recordDaemonSessionRuntimeUpdate(session.id, {
        runtimeVersion: "1.0.49",
        automaticUpdates: true,
      });
      let operation: ProviderInstallationOperation | null = null;

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle(request) {
          if (request.command.type === "provider.installation.start") {
            operation = operationFor(request.command, "completed");

            return { ok: true, result: operation };
          }

          if (request.command.type === "provider.installation.get")
            return {
              ok: true,
              result: { operation, held: false, holdOwner: null },
            };

          return contextResponse(request);
        },
      });

      const response = await startUpdate(harness, host.id);

      expect(response.status).toBe(200);
      expect(readEvents(await response.text())).toContainEqual(
        expect.objectContaining({ type: "completed", success: true }),
      );
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "provider.installation.start",
        ),
      ).toHaveLength(1);
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
      expect(harness.hub.getDaemonSessionIdForHost(host.id)).toBe(session.id);
      expect(harness.hub.getDaemonSessionRuntimeVersion(session.id)).toBe(
        "1.0.49",
      );
    });
  });

  it("rejects an older worker before pausing any chat", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningThread(
        harness,
        "cli-old-worker",
      );

      harness.db
        .update(hostDaemonSessions)
        .set({ protocolVersion: 249 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      const response = await startUpdate(harness, host.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "provider_cli_update_requires_worker_update",
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it.each(["completed", "failed", "busy-then-completed"] as const)(
    "pauses only the selected machine and resumes once after %s",
    async (scenario) => {
      await withTestHarness(async (harness) => {
        const outcome = scenario === "failed" ? "failed" : "completed";
        const selected = seedRunningThread(harness, `cli-selected-${outcome}`);

        const unrelated = seedRunningThread(
          harness,
          `cli-unrelated-${outcome}`,
        );

        const installing = deferred();
        const finish = deferred();
        let operation: ProviderInstallationOperation | null = null;
        let refused = false;

        const requestsBefore = listEvents(harness.db, {
          threadId: selected.thread.id,
        }).filter((event) => event.type === "client/turn/requested");

        const register = () =>
          registerHostRpcResponder(harness, {
            hostId: selected.host.id,
            sessionId: selected.session.id,
            async handle(request) {
              if (request.command.type === "provider.installation.start") {
                if (scenario === "busy-then-completed" && !refused) {
                  refused = true;

                  return {
                    ok: false,
                    errorCode: "runtime_update_busy",
                    errorMessage: "A provider status read is still running.",
                  };
                }

                operation = operationFor(request.command, "installing");

                return { ok: true, result: operation };
              }

              if (request.command.type === "provider.installation.get") {
                installing.resolve();
                await finish.promise;

                if (operation === null)
                  throw new Error("Installation did not start");
                operation = {
                  ...operation,
                  state: outcome,
                  events:
                    outcome === "completed"
                      ? [
                          {
                            type: "completed",
                            provider: "codex",
                            exitCode: 0,
                            signal: null,
                            success: true,
                          },
                        ]
                      : [
                          {
                            type: "error",
                            provider: "codex",
                            code: "provider_installation_verification_failed",
                            message: "The installed version did not change.",
                          },
                        ],
                };

                return {
                  ok: true,
                  result: { operation, held: false, holdOwner: null },
                };
              }

              return contextResponse(request);
            },
          });

        const response = await startUpdate(harness, selected.host.id);
        expect(response.status).toBe(200);
        const eventsPromise = response.text();

        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === selected.thread.id,
        );

        const responder = register();
        expect(
          responder.requests.some(
            ({ command }) => command.type === "provider.installation.start",
          ),
        ).toBe(false);
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
        });

        const reachedInstallation = await Promise.race([
          installing.promise.then(() => true),
          eventsPromise.then(() => false),
        ]);

        expect(reachedInstallation).toBe(true);

        expect(isHostUpdateDraining(harness.deps, selected.host.id)).toBe(true);
        expect(
          listQueuedThreadMessages(harness.db, selected.thread.id),
        ).toHaveLength(1);
        expect(isHostUpdateDraining(harness.deps, unrelated.host.id)).toBe(
          false,
        );
        expect(getThread(harness.db, unrelated.thread.id)?.status).toBe(
          "active",
        );
        expect(
          listQueuedThreadMessages(harness.db, unrelated.thread.id),
        ).toEqual([]);

        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(
          listEvents(harness.db, { threadId: selected.thread.id }).filter(
            (event) => event.type === "client/turn/requested",
          ),
        ).toHaveLength(requestsBefore.length);

        finish.resolve();
        const events = readEvents(await eventsPromise);
        expect(
          events
            .filter((event) => event.type === "progress")
            .map((event) => event.phase),
        ).toEqual(["pausing", "waiting-for-host", "installing", "resuming"]);
        expect(isHostUpdateDraining(harness.deps, selected.host.id)).toBe(
          false,
        );

        const operationIds = responder.requests.flatMap(({ command }) =>
          command.type === "provider.installation.start"
            ? [command.operationId]
            : [],
        );

        expect(operationIds).toHaveLength(
          scenario === "busy-then-completed" ? 2 : 1,
        );
        expect(new Set(operationIds).size).toBe(1);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(
          listEvents(harness.db, { threadId: selected.thread.id }).filter(
            (event) => event.type === "client/turn/requested",
          ),
        ).toHaveLength(requestsBefore.length + 1);
        expect(
          listQueuedThreadMessages(harness.db, selected.thread.id),
        ).toEqual([]);
        expect(
          events.some((event) => event.type === "completed" && event.success),
        ).toBe(outcome === "completed");
      });
    },
  );

  it("reconciles a lost start response and observer disconnect without replaying installation", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "cli-observer-disconnect",
      });

      let operation: ProviderInstallationOperation | null = null;
      const finish = deferred();
      const observed = deferred();

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        async handle(request) {
          if (request.command.type === "provider.installation.start") {
            operation = operationFor(request.command, "completed");

            return {
              ok: false,
              errorCode: "command_timeout",
              errorMessage: "Start response was lost",
            };
          }

          if (request.command.type === "provider.installation.get") {
            observed.resolve();
            await finish.promise;

            return {
              ok: true,
              result: { operation, held: false, holdOwner: null },
            };
          }

          return contextResponse(request);
        },
      });

      const first = await startUpdate(harness, host.id);
      await first.body?.cancel();
      await observed.promise;
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(true);
      const second = await startUpdate(harness, host.id);
      const result = second.text();
      finish.resolve();
      expect(
        readEvents(await result).some(
          (event) => event.type === "completed" && event.success,
        ),
      ).toBe(true);
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "provider.installation.start",
        ),
      ).toHaveLength(1);
    });
  });

  it("keeps chats paused until the worker releases even a terminal operation's hold", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "cli-held-terminal",
      });

      const observed = deferred();
      const released = deferred();
      let operation: ProviderInstallationOperation | null = null;
      let reads = 0;

      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        async handle(request) {
          if (request.command.type === "provider.installation.start") {
            operation = operationFor(request.command, "failed");

            return { ok: true, result: operation };
          }

          if (request.command.type === "provider.installation.get") {
            reads += 1;

            if (reads === 1) {
              observed.resolve();

              return {
                ok: true,
                result: {
                  operation,
                  held: true,
                  holdOwner: request.command.operationId,
                },
              };
            }

            await released.promise;

            return {
              ok: true,
              result: { operation, held: false, holdOwner: null },
            };
          }

          return contextResponse(request);
        },
      });

      const response = await startUpdate(harness, host.id);
      const result = response.text();
      await observed.promise;
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(true);
      released.resolve();
      const events = readEvents(await result);
      expect(
        events.some(
          (event) =>
            event.type === "error" &&
            event.code === "provider_installation_verification_failed",
        ),
      ).toBe(true);
      expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
      expect(reads).toBe(2);
    });
  });

  it("shares the pause deadline with persistent busy refusals and resumes once", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedRunningThread(
        harness,
        "cli-busy-deadline",
      );

      const startedAt = Date.now();
      let elapsedMs = 0;
      let starts = 0;

      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() => startedAt + elapsedMs);

      try {
        const response = await startUpdate(harness, host.id);
        const result = response.text();

        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
        );

        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle(request) {
            if (request.command.type === "provider.installation.start") {
              elapsedMs = starts === 0 ? 30_000 : 60_000;
              starts += 1;

              return {
                ok: false,
                errorCode: "runtime_update_busy",
                errorMessage: "Active provider work has not stopped.",
              };
            }

            return contextResponse(request);
          },
        });

        elapsedMs = 20_000;
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
        });
        const events = readEvents(await result);

        expect(events.at(-1)).toMatchObject({
          type: "error",
          code: "runtime_update_busy",
        });
        expect(
          events.filter(
            (event) => event.type === "progress" && event.phase === "pausing",
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "progress" && event.phase === "resuming",
          ),
        ).toHaveLength(1);
        expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
        expect(
          responder.requests.filter(
            ({ command }) => command.type === "provider.installation.start",
          ),
        ).toHaveLength(1);
        expect(
          responder.requests.some(
            ({ command }) => command.type === "provider.installation.get",
          ),
        ).toBe(false);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it.each(["provider_installation_operation_conflict", "direct_access_held"])(
    "does not retry a guarded %s refusal",
    async (code) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `cli-refused-${code}`,
        });

        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle(request) {
            if (request.command.type === "provider.installation.start")
              return {
                ok: false,
                errorCode: code,
                errorMessage: "Another operation owns admission.",
              };

            return contextResponse(request);
          },
        });

        const response = await startUpdate(harness, host.id);

        expect(readEvents(await response.text()).at(-1)).toMatchObject({
          type: "error",
          code,
        });
        expect(isHostUpdateDraining(harness.deps, host.id)).toBe(false);
        expect(responder.requests).toHaveLength(1);
      });
    },
  );
});
