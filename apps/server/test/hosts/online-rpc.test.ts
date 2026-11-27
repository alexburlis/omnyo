import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonOnlineRpcResult,
} from "@omnyo/host-daemon-contract";
import { hostDaemonSessions, openSession, updateHost } from "@omnyo/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  LEASE_TIMEOUT_MS,
} from "../../src/constants.js";
import { ApiError } from "../../src/errors.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
  callHostRetryableOnlineRpcForWork,
} from "../../src/services/hosts/online-rpc.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import {
  handleDaemonSessionSilent,
  handleDaemonSocketClosed,
} from "../../src/internal/session-owner-side-effects.js";
import {
  feedRawDaemonWebSocketMessage,
  type TestDaemonWebSocket,
} from "../helpers/daemon-ws.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

type TestHostRpcSocket = TestDaemonWebSocket;

interface DaemonSocketCloseRecord {
  code: number | undefined;
  reason: string | undefined;
}

interface DropThenReplaceSocketArgs {
  hostId: string;
  hub: NotificationHub;
  requests: HostDaemonOnlineRpcRequestMessage[];
  sessionId: string;
  successResult: HostDaemonOnlineRpcResult;
}

function parseHostRpcRequest(
  data: string,
): HostDaemonOnlineRpcRequestMessage | null {
  const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));

  if (
    message.type === "diagnostics-policy.replace" ||
    message.type === "command-catalog-retain"
  )
    return null;

  if (message.type !== "host-rpc.request") {
    throw new Error(`Expected host-rpc.request, got ${message.type}`);
  }

  return message;
}

function registerDropThenReplaceSocket(args: DropThenReplaceSocketArgs): void {
  const retrySocket: TestHostRpcSocket = {
    close() {},
    send(data) {
      const request = parseHostRpcRequest(data);

      if (request === null) return;
      args.requests.push(request);
      args.hub.recordHostOnlineRpcResponse({
        sessionId: args.sessionId,
        message: hostDaemonOnlineRpcResponseMessageSchema.parse({
          type: "host-rpc.response",
          requestId: request.requestId,
          commandType: request.command.type,
          ok: true,
          result: args.successResult,
        }),
      });
    },
  };

  const droppedSocket: TestHostRpcSocket = {
    close() {},
    send(data) {
      const request = parseHostRpcRequest(data);

      if (request === null) return;
      args.requests.push(request);
      args.hub.unregisterDaemon(args.sessionId);
      args.hub.registerDaemon(args.sessionId, args.hostId, retrySocket);
    },
  };

  args.hub.unregisterDaemon(args.sessionId);
  args.hub.registerDaemon(args.sessionId, args.hostId, droppedSocket);
}

describe("host online RPC retry semantics", () => {
  it("does not wait for a replacement when the inventoried daemon is disconnected", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      harness.hub.unregisterDaemon(session.id);
      const reconnect = vi.spyOn(harness.hub, "waitForDaemonForHost");

      try {
        await expect(
          callHostOnlineRpc(harness.deps, {
            hostId: host.id,
            expectedSessionId: session.id,
            timeoutMs: 100,
            command: {
              type: "host.delete_thread_storage",
              threadId: "thr_abcdefghij",
            },
          }),
        ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
        expect(reconnect).not.toHaveBeenCalled();
      } finally {
        reconnect.mockRestore();
      }
    });
  });

  it("does not replay a bound deletion after disconnect while the RPC is pending", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const original = createMockHubSocket();
      const replacement = createMockHubSocket();
      harness.hub.registerDaemon(session.id, host.id, original);
      const reconnect = vi.spyOn(harness.hub, "waitForDaemonForHost");

      try {
        const pending = callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          expectedSessionId: session.id,
          timeoutMs: 100,
          command: {
            type: "host.delete_thread_storage",
            threadId: "thr_abcdefghij",
          },
        });

        expect(
          original.messages.filter((message) =>
            message.includes('"type":"host-rpc.request"'),
          ),
        ).toHaveLength(1);

        const rejected = expect(pending).rejects.toMatchObject({
          body: { code: "host_unavailable" },
        });

        harness.hub.unregisterDaemon(session.id);
        harness.hub.registerDaemon("new-session", host.id, replacement);
        await rejected;
        expect(
          replacement.messages.filter((message) =>
            message.includes('"type":"host-rpc.request"'),
          ),
        ).toEqual([]);
        expect(reconnect).not.toHaveBeenCalled();
      } finally {
        reconnect.mockRestore();
        harness.hub.unregisterDaemon("new-session");
      }
    });
  });

  it("refuses installation on legacy workers before sending any mutation", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "legacy-install-worker",
      });

      harness.db
        .update(hostDaemonSessions)
        .set({ protocolVersion: 236 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();
      const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.installation.run",
            providerId: "codex",
            action: "update",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
          },
        }),
      ).rejects.toMatchObject({ body: { code: "runtime_update_busy" } });
      expect(request).not.toHaveBeenCalled();
    });
  });
  it("classifies suspended hosts before sending read-only RPCs", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-online-rpc-suspended-read",
      });

      updateHost(harness.db, harness.hub, host.id, {
        phase: "suspended",
        suspendedAt: 123,
      });
      const request = vi.spyOn(harness.hub, "requestHostOnlineRpc");

      await expect(
        callHostRetryableOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).rejects.toMatchObject({
        status: 502,
        body: {
          code: "host_unavailable",
          message: "Host is suspended",
          details: {
            reason: "suspended",
            hostStatus: "disconnected",
            suspendedAt: 123,
            destroyedAt: null,
          },
          retryable: false,
        },
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("runs a retryable RPC when the daemon websocket is still registered with a stale lease", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-stale-lease-live-socket",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      harness.hub.unregisterDaemon(session.id);

      const socket: TestHostRpcSocket = {
        close() {},
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);
          harness.hub.recordHostOnlineRpcResponse({
            sessionId: session.id,
            message: hostDaemonOnlineRpcResponseMessageSchema.parse({
              type: "host-rpc.response",
              requestId: request.requestId,
              commandType: request.command.type,
              ok: true,
              result: { models: [], selectedOnlyModels: [] },
            }),
          });
        },
      };

      harness.hub.registerDaemon(session.id, host.id, socket);
      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1000 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await expect(
        callHostRetryableOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toEqual({ models: [], selectedOnlyModels: [] });

      const updatedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();

      expect(updatedSession?.status).toBe("active");
      expect(requests.map((request) => request.command.type)).toEqual([
        "provider.list_models",
      ]);
    });
  });

  it("waits briefly for retryable work when the session is active before the daemon websocket registers", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-registration-race",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      harness.hub.unregisterDaemon(session.id);

      setTimeout(() => {
        const socket: TestHostRpcSocket = {
          close() {},
          send(data) {
            const request = parseHostRpcRequest(data);

            if (request === null) return;
            requests.push(request);
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: session.id,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response",
                requestId: request.requestId,
                commandType: request.command.type,
                ok: true,
                result: { models: [], selectedOnlyModels: [] },
              }),
            });
          },
        };

        harness.hub.registerDaemon(session.id, host.id, socket);
      }, 10);

      await expect(
        callHostRetryableOnlineRpcForWork(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toEqual({ models: [], selectedOnlyModels: [] });
      expect(requests.map((request) => request.command.type)).toEqual([
        "provider.list_models",
      ]);
    });
  });

  it("waits for a daemon reconnecting after its socket dropped before sending an RPC", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-reconnect-wait",
      });

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];

      setTimeout(() => {
        const reconnected = openSession(harness.db, {
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          dataDir: session.dataDir,
          protocolVersion: session.protocolVersion,
          heartbeatIntervalMs: session.heartbeatIntervalMs,
          leaseTimeoutMs: session.leaseTimeoutMs,
        });

        const socket: TestHostRpcSocket = {
          close() {},
          send(data) {
            const request = parseHostRpcRequest(data);

            if (request === null) return;
            requests.push(request);
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: reconnected.id,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response",
                requestId: request.requestId,
                commandType: request.command.type,
                ok: true,
                result: { models: [], selectedOnlyModels: [] },
              }),
            });
          },
        };

        harness.hub.registerDaemon(reconnected.id, host.id, socket);
      }, 200);

      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toEqual({ models: [], selectedOnlyModels: [] });
      expect(requests).toHaveLength(1);
      harness.hub.cancelPendingDaemonDisconnect(session.id);
    });
  });

  it("fails fast for a host whose session the server expired for silence", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-silent-fail-fast",
      });

      harness.hub.recordDaemonSessionRuntimeUpdate(session.id, {
        runtimeVersion: "1.0.70",
        automaticUpdates: true,
      });

      const socket = createMockHubSocket();
      const lastHeardAt = session.updatedAt + 2 * HEARTBEAT_INTERVAL_MS;
      const silentAt = lastHeardAt + LEASE_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS;
      const now = vi.spyOn(Date, "now").mockReturnValue(session.updatedAt);
      const warn = vi.spyOn(harness.deps.logger, "warn");

      try {
        harness.hub.registerDaemon(session.id, host.id, socket);
        now.mockReturnValue(lastHeardAt);
        feedRawDaemonWebSocketMessage({
          harness,
          hostId: host.id,
          rawMessage: { type: "heartbeat" },
          sessionId: session.id,
          socket,
        });
        now.mockReturnValue(silentAt);
        handleDaemonSessionSilent(harness.deps, { sessionId: session.id });
      } finally {
        now.mockRestore();
      }

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          hostId: host.id,
          instanceId: session.instanceId,
          runtimeVersion: "1.0.70",
          automaticUpdates: true,
          lastSessionActivityAt: lastHeardAt,
          sessionActivityAgeMs: silentAt - lastHeardAt,
          leaseExpiresAt: session.leaseExpiresAt,
          leaseStaleByMs: silentAt - session.leaseExpiresAt,
          reason: "no-session-traffic",
        }),
        "Daemon sent nothing within its lease; closing its socket",
      );
      const waitForDaemon = vi.spyOn(harness.hub, "waitForDaemonForHost");

      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).rejects.toMatchObject({ body: { code: "host_unavailable" } });
      expect(waitForDaemon).not.toHaveBeenCalled();
      harness.hub.cancelPendingDaemonDisconnect(session.id);
    });
  });

  it("retries admitted work when the current websocket session disappears", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-read-retry",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerDropThenReplaceSocket({
        hostId: host.id,
        hub: harness.hub,
        requests,
        sessionId: session.id,
        successResult: { models: [], selectedOnlyModels: [] },
      });

      await expect(
        callHostRetryableOnlineRpcForWork(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toEqual({ models: [], selectedOnlyModels: [] });
      expect(requests.map((request) => request.command.type)).toEqual([
        "provider.list_models",
        "provider.list_models",
      ]);
    });
  });

  it("retries read-only online RPCs when the first response times out", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-timeout-retry",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];

      const socket: TestHostRpcSocket = {
        close() {},
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);

          if (requests.length === 1) return;
          const firstRequest = requests[0];

          if (firstRequest === undefined) {
            throw new Error("Expected the timed-out first host RPC request");
          }

          expect(
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: session.id,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response",
                requestId: firstRequest.requestId,
                commandType: firstRequest.command.type,
                ok: true,
                result: { models: [], selectedOnlyModels: [] },
              }),
            }),
          ).toEqual({ handled: true });
          expect(harness.hub.countPendingHostRpcs()).toBe(1);
          expect(
            harness.hub.recordHostOnlineRpcResponse({
              sessionId: session.id,
              message: hostDaemonOnlineRpcResponseMessageSchema.parse({
                type: "host-rpc.response",
                requestId: request.requestId,
                commandType: request.command.type,
                ok: true,
                result: { models: [], selectedOnlyModels: [] },
              }),
            }),
          ).toEqual({ handled: true });
        },
      };

      harness.hub.registerDaemon(session.id, host.id, socket);

      vi.useFakeTimers();

      try {
        const result = expect(
          callHostRetryableOnlineRpc(harness.deps, {
            hostId: host.id,
            timeoutMs: 10,
            command: {
              type: "provider.list_models",
              providerId: "codex",
              bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
              contributedEnv: [],
            },
          }),
        ).resolves.toEqual({ models: [], selectedOnlyModels: [] });

        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5);
        await result;
      } finally {
        vi.useRealTimers();
      }

      expect(requests.map((request) => request.command.type)).toEqual([
        "provider.list_models",
        "provider.list_models",
      ]);
      expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    });
  });

  it("does not retry ordinary online RPCs when the response times out", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-timeout-no-retry",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];

      const socket: TestHostRpcSocket = {
        close() {},
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);
        },
      };

      harness.hub.registerDaemon(session.id, host.id, socket);

      vi.useFakeTimers();

      try {
        const result = expect(
          callHostOnlineRpc(harness.deps, {
            hostId: host.id,
            timeoutMs: 10,
            command: {
              type: "provider.list_models",
              providerId: "codex",
              bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
              contributedEnv: [],
            },
          }),
        ).rejects.toMatchObject({
          status: 504,
          body: { code: "command_timeout" },
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10);
        await result;
      } finally {
        vi.useRealTimers();
      }

      expect(requests).toHaveLength(1);
    });
  });

  it("spends one timeout budget across both response attempts", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-timeout-budget",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];

      const socket: TestHostRpcSocket = {
        close() {},
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);
        },
      };

      harness.hub.registerDaemon(session.id, host.id, socket);

      vi.useFakeTimers();

      try {
        let outcome:
          | "pending"
          | "resolved"
          | "command_timeout"
          | "other_error" = "pending";

        void callHostRetryableOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 10,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }).then(
          () => {
            outcome = "resolved";
          },
          (error) => {
            outcome =
              error instanceof ApiError &&
              error.status === 504 &&
              error.body.code === "command_timeout"
                ? "command_timeout"
                : "other_error";
          },
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4);
        expect(requests).toHaveLength(1);
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(requests).toHaveLength(2);
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(4);
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBe("command_timeout");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not retry non-retry host RPC calls after websocket unavailability", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-no-retry",
      });

      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerDropThenReplaceSocket({
        hostId: host.id,
        hub: harness.hub,
        requests,
        sessionId: session.id,
        successResult: { models: [], selectedOnlyModels: [] },
      });

      try {
        await callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: TRANSPORT_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        });
        throw new Error("Expected host RPC to fail");
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }

        expect(error.status).toBe(502);
        expect(error.body.code).toBe("host_unavailable");
      }

      expect(requests.map((request) => request.command.type)).toEqual([
        "provider.list_models",
      ]);
    });
  });

  it("rejects malformed host RPC responses at the daemon websocket boundary without resolving the waiter", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-boundary-rejects-malformed-response",
      });

      const filePath = "/tmp/report.html";
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      const closes: DaemonSocketCloseRecord[] = [];

      const socket: TestHostRpcSocket = {
        close(code, reason) {
          closes.push({ code, reason });
        },
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);
          feedRawDaemonWebSocketMessage({
            harness,
            hostId: host.id,
            sessionId: session.id,
            socket,
            rawMessage: {
              type: "host-rpc.response",
              requestId: request.requestId,
              commandType: "host.read_file",
              ok: true,
              result: {
                files: [],
                truncated: false,
              },
            },
          });
        },
      };

      harness.hub.unregisterDaemon(session.id);
      harness.hub.registerDaemon(session.id, host.id, socket);

      try {
        await callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 25,
          command: {
            type: "host.read_file",
            path: filePath,
          },
        });
        throw new Error("Expected malformed daemon response to time out");
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }

        expect(error.status).toBe(504);
        expect(error.body.code).toBe("command_timeout");
      }

      expect(requests.map((request) => request.command)).toEqual([
        {
          type: "host.read_file",
          path: filePath,
        },
      ]);
      expect(closes).toEqual([{ code: 1008, reason: "invalid-message" }]);
    });
  });

  it("rejects schema-valid host RPC responses whose commandType does not match the pending request", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-online-rpc-rejects-pending-command-type-mismatch",
      });

      const filePath = "/tmp/report.html";
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      const closes: DaemonSocketCloseRecord[] = [];

      const socket: TestHostRpcSocket = {
        close(code, reason) {
          closes.push({ code, reason });
        },
        send(data) {
          const request = parseHostRpcRequest(data);

          if (request === null) return;
          requests.push(request);
          feedRawDaemonWebSocketMessage({
            harness,
            hostId: host.id,
            sessionId: session.id,
            socket,
            rawMessage: {
              type: "host-rpc.response",
              requestId: request.requestId,
              commandType: "host.list_files",
              ok: true,
              result: {
                files: [],
                truncated: false,
              },
            },
          });
        },
      };

      harness.hub.unregisterDaemon(session.id);
      harness.hub.registerDaemon(session.id, host.id, socket);

      try {
        await callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          timeoutMs: 1_000,
          command: {
            type: "host.read_file",
            path: filePath,
          },
        });
        throw new Error("Expected mismatched host RPC response to fail");
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }

        expect(error.status).toBe(500);
        expect(error.body.code).toBe("command_result_type_mismatch");
        expect(error.body.message).toContain(
          "completed with unexpected type host.list_files",
        );
        expect(harness.hub.countPendingHostRpcs()).toBe(1);
      }

      expect(requests.map((request) => request.command)).toEqual([
        {
          type: "host.read_file",
          path: filePath,
        },
      ]);
      expect(closes).toEqual([]);
    });
  });
});
