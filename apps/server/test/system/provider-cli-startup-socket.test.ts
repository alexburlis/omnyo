import { listQueuedThreadMessages } from "@omnyo/db";
import {
  hostDaemonServerWsMessageSchema,
  type ProviderInstallationOperation,
} from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  currentWorkspaceIdentity,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import {
  seedQueuedMessage,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function deferred() {
  let resolve = () => {};

  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });

  return { promise, resolve };
}

describe("provider CLI startup socket admission", () => {
  it("keeps queued chats waiting until the connected machine finishes its CLI update", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness, {
        session: { id: "startup-socket" },
        thread: { status: "idle" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: fixture.thread.id,
        environmentId: fixture.environment.id,
        providerThreadId: "startup-socket-provider",
      });
      seedQueuedMessage(harness.deps, {
        threadId: fixture.thread.id,
        content: [
          { type: "text", text: "Continue after updating", mentions: [] },
        ],
      });
      const observed = deferred();
      const finish = deferred();
      let operation: ProviderInstallationOperation | null = null;
      const registrations = vi.spyOn(harness.hub, "registerDaemon");

      try {
        registerHostRpcResponder(harness, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          async handle(request) {
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
              operation = {
                operationId: request.command.operationId,
                providerId: request.command.providerId,
                action: request.command.action,
                state: "installing",
                events: [],
              };

              return { ok: true, result: operation };
            }

            if (request.command.type === "provider.installation.get") {
              observed.resolve();
              await finish.promise;

              if (operation === null) throw new Error("Updater did not start");
              operation = {
                ...operation,
                state: "completed",
                events: [
                  {
                    type: "completed",
                    provider: "codex",
                    exitCode: 0,
                    signal: null,
                    success: true,
                  },
                ],
              };

              return {
                ok: true,
                result: { operation, held: false, holdOwner: null },
              };
            }

            if (request.command.type === "provider.health")
              return { ok: true, result: { supported: false } };

            if (request.command.type === "host.prepare_workspace_identity_v1")
              return {
                ok: true,
                result: currentWorkspaceIdentity(request.command.rootPath),
              };

            if (request.command.type === "host.read_workspace_agent_context")
              return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
            throw new Error(`Unexpected RPC ${request.command.type}`);
          },
        });
        const registered = registrations.mock.calls.at(-1);

        if (registered === undefined)
          throw new Error("Responder socket did not register");
        const rpcSocket = registered[2];
        registrations.mockRestore();

        const commandSocket = registerTestHostRpcCapture(harness.deps, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
        });

        onDaemonSocketOpen(harness.deps, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          socket: {
            close() {},
            send(data) {
              const message = hostDaemonServerWsMessageSchema.parse(
                JSON.parse(data),
              );

              if (
                message.type === "host-rpc.request" &&
                message.command.type !== "turn.submit"
              )
                rpcSocket.send(data);
              else commandSocket.send(data);
            },
          },
        });
        await observed.promise;
        await runQueuedMessageDispatch(harness.deps, {
          kind: "host-connected",
          hostId: fixture.host.id,
        });
        expect(
          listQueuedThreadMessages(harness.db, fixture.thread.id),
        ).toHaveLength(1);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
        ).toHaveLength(0);
        finish.resolve();
        await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === fixture.thread.id,
        );
        expect(
          listQueuedThreadMessages(harness.db, fixture.thread.id),
        ).toHaveLength(0);
      } finally {
        finish.resolve();
        registrations.mockRestore();
      }
    });
  });
});
