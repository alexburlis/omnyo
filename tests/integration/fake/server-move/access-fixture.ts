import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { ServerConnection } from "../../../../apps/host-daemon/src/server-connection.js";
import { createServerClient } from "../../../../apps/host-daemon/src/server-client.js";
import type { HostDaemonRpcCommand } from "@omnyo/host-daemon-contract";
import { createFixture } from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import {
  testLogger,
  type RunningTestServer,
} from "../../../../apps/server/test/helpers/test-app.js";

export async function connectIssuedWorker(
  server: Pick<RunningTestServer, "deps" | "baseUrl">,
  hostId: string,
  issuedHostKey?: string,
  options: {
    busy?: boolean;
    omitWebSocket?: boolean;
    beforeProof?: () => Promise<void>;
  } = {},
) {
  const fixture = await createFixture();

  const hostKey =
    issuedHostKey === undefined
      ? await server.deps.machineAuth.issueDaemonHostKey({ hostId })
      : issuedHostKey;

  const events: string[] = [];
  const probeEntered = createDeferredPromise<void>();
  let probeBarrier: Promise<void> = Promise.resolve();
  let connection: ServerConnection;
  let instance = 0;
  let reconnect = true;
  const moved = createDeferredPromise<void>();

  const connect = async (
    serverUrl: string,
    serverHeaders: Record<string, string>,
  ) => {
    const client = createServerClient({
      serverUrl,
      serverHeaders,
      hostKey,
      logger: testLogger,
      getSessionId: () => connection.sessionId ?? "",
    });

    connection = new ServerConnection({
      serverUrl,
      serverHeaders,
      hostKey,
      serverClient: client,
      logger: testLogger,
      hostId,
      hostName: "Owned inert issued worker",
      dataDir: fixture.dataDir,
      instanceId: `inert-instance-${++instance}`,
      localApiPort: null,
      onServerMoved: async (notice) => {
        events.push("moved-handler");
        await worker.handleServerMoved(notice);
      },
      onHostRpcRequest: async (message) => {
        try {
          const command: HostDaemonRpcCommand = message.command;

          if (command.type === "server_access.prove_current_primary") {
            events.push("current-primary-proof-entered");
            probeEntered.resolve();
            await probeBarrier;
            await options.beforeProof?.();

            if (options.omitWebSocket) {
              await fetch(
                new URL(
                  "/internal/server-access/direct-proof",
                  command.serverUrl,
                ),
                {
                  method: "POST",
                  headers: {
                    authorization: "Bearer " + hostKey,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    challenge: command.challenge,
                    instanceId: command.instanceId,
                  }),
                },
              );
              connection.sendMessage({
                type: "host-rpc.response",
                requestId: message.requestId,
                commandType: command.type,
                ok: true,
                result: { ok: true },
              });
            } else {
              const result = await worker.proveCurrentPrimary(command);
              events.push("current-primary-http-ws-proved");
              connection.sendMessage({
                type: "host-rpc.response",
                requestId: message.requestId,
                commandType: command.type,
                ok: true,
                result,
              });
            }
          } else if (command.type === "server_access.probe_direct") {
            events.push("probe-entered");
            probeEntered.resolve();
            await probeBarrier;
            const result = await worker.probeDirect(command);
            events.push("direct-http-ws-proved");
            connection.sendMessage({
              type: "host-rpc.response",
              requestId: message.requestId,
              commandType: command.type,
              ok: true,
              result,
            });
          } else if (command.type === "server_access.release_direct_probe") {
            connection.sendMessage({
              type: "host-rpc.response",
              requestId: message.requestId,
              commandType: command.type,
              ok: true,
              result: await worker.releaseDirectProbe(command),
            });
          } else throw new Error(`Unexpected inert RPC ${command.type}`);
        } catch (error) {
          connection.sendMessage({
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: message.command.type,
            ok: false,
            errorCode: "inert_worker_error",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    const session = await connection.start();
    events.push("authenticated-primary:" + session.sessionId);

    return session;
  };

  const worker = fixture.createService({
    getDirectAccessActivity: () => ({
      commands: 0,
      runtimes: options.busy ? 1 : 0,
      terminals: 0,
      pluginHosts: 0,
      interactions: 0,
    }),
    hostId,
    hostKey,
    serverUrl: server.baseUrl,
    serverHeaders: {},
    getServerSessionId: () => connection.sessionId,
    requestShutdown: async () => {
      events.push("restart-requested");
      await connection.shutdown();

      const config = z
        .object({
          serverUrl: z.string().min(1),
          serverHeaders: z.record(z.string(), z.string()).optional(),
        })
        .passthrough()
        .parse(
          JSON.parse(
            await readFile(join(fixture.dataDir, "config.json"), "utf8"),
          ),
        );

      expect(config.serverUrl).toBe(server.baseUrl);
      events.push("config-persisted");

      if (reconnect) {
        await connect(config.serverUrl, config.serverHeaders ?? {});
        moved.resolve();
      }
    },
  });

  const first = await connect(server.baseUrl, {});

  return {
    fixture,
    hostKey,
    worker,
    events,
    firstSessionId: first.sessionId,
    probeEntered: probeEntered.promise,
    pauseProbe(barrier: Promise<void>) {
      probeBarrier = barrier;
    },
    suppressReconnect() {
      reconnect = false;
    },
    moved: moved.promise,
    sessionId: () => connection.sessionId,
    stop: () => connection.shutdown(),
  };
}
