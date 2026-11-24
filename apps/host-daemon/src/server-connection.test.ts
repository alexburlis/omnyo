import { Buffer } from "node:buffer";
import { decodeDaemonWirePayload } from "@omnyo/host-daemon-contract";
import type {
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResponseMessage,
  HostDaemonSessionOpenResponse,
} from "@omnyo/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "./logger.js";
import { ServerResponseError, type ServerClient } from "./server-client.js";
import type { ProtocolSelfUpdater } from "./protocol-self-update.js";
import { ServerConnection } from "./server-connection.js";
import type {
  CreateReconnectingWebSocket,
  ReconnectingWebSocketLike,
  ServerConnectionOptions,
  ServerMovedNotice,
} from "./server-connection-support.js";

interface CreateServerClientFixtureArgs {
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
  sessionIds?: string[];
  openSessionError?: Error;
}

interface CreateWebSocketFixtureArgs {
  autoReconnect?: boolean;
}

interface ConnectionFixtureArgs extends CreateServerClientFixtureArgs {
  autoReconnect?: boolean;
  serverHeaders?: Record<string, string>;
  protocolSelfUpdater?: ProtocolSelfUpdater;
  onSelfUpdateInstalled?: () => void | Promise<void>;
  onMachineShutdown?: () => void | Promise<void>;
  onCatalogRetain?: ServerConnectionOptions["onCatalogRetain"];
  onDiagnosticsPolicy?: ServerConnectionOptions["onDiagnosticsPolicy"];
  onInteractiveRequestsEnded?: ServerConnectionOptions["onInteractiveRequestsEnded"];
  onServerMoved?: (notice: ServerMovedNotice) => Promise<void>;
  onMachineEnvironment?: (
    environment: HostDaemonSessionOpenResponse["machineEnvironment"],
  ) => void;
  onHostRpcRequest?: (
    message: HostDaemonOnlineRpcRequestMessage,
  ) => void | Promise<void>;
  onTerminalMessage?: ServerConnectionOptions["onTerminalMessage"];
  startupTimeoutMs?: number;
}

interface CreateSessionArgs {
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  sessionId: string;
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies HostDaemonLogger;
}

function createSession(args: CreateSessionArgs): HostDaemonSessionOpenResponse {
  return {
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    machineEnvironment: { revision: 0, entries: [] },
    diagnosticsPolicy: { revision: 1, crashReportsEnabled: true },
    leaseTimeoutMs: args.leaseTimeoutMs,
    retiredEnvironmentIds: [],
    endedInteractiveRequests: [],
    connectShares: { generation: 0, ports: [] },
    pluginHostGenerations: [],
    sessionId: args.sessionId,
    watchSet: {
      generation: 0,
      threadStorageTargets: [],
      workspaceTargets: [],
    },
  };
}

function createServerClientFixture(args: CreateServerClientFixtureArgs = {}) {
  const sessionIds = args.sessionIds ?? ["session-1"];
  let sessionIndex = 0;

  const openSession = vi.fn(async () => {
    if (args.openSessionError) {
      throw args.openSessionError;
    }

    const sessionId = sessionIds[sessionIndex] ?? sessionIds.at(-1);
    sessionIndex += 1;

    if (!sessionId) {
      throw new Error("Expected at least one test session ID");
    }

    return createSession({
      heartbeatIntervalMs: args.heartbeatIntervalMs ?? 5_000,
      leaseTimeoutMs: args.leaseTimeoutMs ?? 30_000,
      sessionId,
    });
  });

  const unused = async () => {
    throw new Error("Unexpected server client call");
  };

  const serverClient = {
    openSession,
    fetchProjectAttachment: unused,
    fetchSkillTree: unused,
    fetchPluginHostArtifact: unused,
    postEvents: unused,
    callTool: unused,
    registerInteractiveRequest: unused,
    interruptInteractiveRequests: unused,
  } satisfies ServerClient;

  return {
    openSession,
    serverClient,
  };
}

function createWebSocketFixture(args: CreateWebSocketFixtureArgs = {}) {
  const sockets: ReconnectingWebSocketLike[] = [];
  const bufferedAmounts = new Map<ReconnectingWebSocketLike, number>();
  const headers: Array<Record<string, string> | undefined> = [];

  const createWebSocket: CreateReconnectingWebSocket = (
    urlProvider,
    options,
  ) => {
    headers.push(options.headers);
    let readyState = 0;

    const socket: ReconnectingWebSocketLike = {
      get bufferedAmount() {
        return bufferedAmounts.get(socket) ?? 0;
      },
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(() => {
        readyState = 3;
      }),
      reconnect: vi.fn(() => {
        if (args.autoReconnect === false) {
          return;
        }

        readyState = 3;
        socket.onclose?.({ code: 1000, reason: "test-reconnect" });
        void openSocket().catch((error) => socket.onerror?.(error));
      }),
    };

    async function openSocket(): Promise<void> {
      await urlProvider();
      queueMicrotask(() => {
        readyState = 1;
        socket.onopen?.({ type: "open" });
      });
    }

    bufferedAmounts.set(socket, 0);
    sockets.push(socket);
    void openSocket().catch((error) => socket.onerror?.(error));

    return socket;
  };

  return {
    createWebSocket,
    headers,
    setBufferedAmount(socket: ReconnectingWebSocketLike, bytes: number) {
      bufferedAmounts.set(socket, bytes);
    },
    sockets,
  };
}

function createConnectionFixture(args: ConnectionFixtureArgs = {}) {
  const logger = createLogger();
  const serverClient = createServerClientFixture(args);

  const webSocket = createWebSocketFixture({
    autoReconnect: args.autoReconnect,
  });

  const setSession = vi.fn();

  const connection = new ServerConnection({
    dataDir: "/tmp/omnyo-server-connection-test",
    hostId: "host-server-connection-test",
    hostKey: "host-key-server-connection-test",
    hostName: "Server Connection Test Host",
    instanceId: "instance-server-connection-test",
    localApiPort: 38_887,
    logger,
    serverHeaders: args.serverHeaders,
    serverClient: serverClient.serverClient,
    serverUrl: "http://127.0.0.1:3334",
    protocolSelfUpdater: args.protocolSelfUpdater,
    onSelfUpdateInstalled: args.onSelfUpdateInstalled,
    onMachineShutdown: args.onMachineShutdown,
    onCatalogRetain: args.onCatalogRetain,
    onDiagnosticsPolicy: args.onDiagnosticsPolicy,
    onInteractiveRequestsEnded: args.onInteractiveRequestsEnded,
    onServerMoved: args.onServerMoved,
    onMachineEnvironment: args.onMachineEnvironment,
    onHostRpcRequest: args.onHostRpcRequest,
    onTerminalMessage: args.onTerminalMessage,
    startupTimeoutMs: args.startupTimeoutMs,
    setSession,
    createWebSocket: webSocket.createWebSocket,
  });

  return {
    connection,
    logger,
    openSession: serverClient.openSession,
    setSession,
    webSocket,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ServerConnection", () => {
  it("delivers the coordinator's retained catalog scopes to the watch owner", async () => {
    const onCatalogRetain = vi.fn(async () => undefined);

    const { connection, webSocket } = createConnectionFixture({
      onCatalogRetain,
    });

    try {
      await connection.start();
      const scopes = [{ cwd: "/workspace", providerId: "provider" }];
      webSocket.sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "command-catalog-retain", scopes }),
      });
      expect(onCatalogRetain).toHaveBeenCalledWith(scopes);
    } finally {
      await connection.shutdown();
    }
  });

  it("requires fresh socket policy after an enabled HTTP snapshot and ignores old connection callbacks", async () => {
    const onDiagnosticsPolicy = vi.fn();

    const { connection, webSocket } = createConnectionFixture({
      onDiagnosticsPolicy,
      sessionIds: ["first", "second"],
    });

    try {
      const session = await connection.start();
      expect(session.diagnosticsPolicy.crashReportsEnabled).toBe(true);
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected socket");
      const firstConnectionMessage = socket.onmessage;
      const firstConnectionClose = socket.onclose;

      const send = (revision: number, crashReportsEnabled: boolean) =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "diagnostics-policy.replace",
            policy: { revision, crashReportsEnabled },
          }),
        });

      send(2, false);
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
      send(1, true);
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
      send(3, true);
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(true);
      socket.reconnect();
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
      await vi.waitFor(() => expect(connection.sessionId).toBe("second"));
      firstConnectionMessage?.({
        data: JSON.stringify({
          type: "diagnostics-policy.replace",
          policy: { revision: 99, crashReportsEnabled: true },
        }),
      });
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
      send(0, true);
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(true);
      firstConnectionClose?.({ code: 1000, reason: "stale-close" });
      expect(connection.sessionId).toBe("second");
      expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(true);
    } finally {
      await connection.shutdown();
    }

    expect(onDiagnosticsPolicy).toHaveBeenLastCalledWith(false);
  });

  it("logs an unexpected synchronous terminal callback failure without throwing from the socket", async () => {
    const error = new Error("Unexpected terminal handler failure");

    const { connection, logger, webSocket } = createConnectionFixture({
      onTerminalMessage: () => {
        throw error;
      },
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected test socket");
      expect(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "terminal.close",
            terminalId: "term-unexpected",
            reason: "user",
          }),
        }),
      ).not.toThrow();
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ type: "terminal.close", err: error }),
          "Terminal websocket message handler failed",
        ),
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("applies initial and replacement machine environments, ignores stale updates and resets revisions after reconnect", async () => {
    const onMachineEnvironment = vi.fn();

    const { connection, webSocket } = createConnectionFixture({
      onMachineEnvironment,
      sessionIds: ["first", "second"],
    });

    try {
      await connection.start();
      expect(onMachineEnvironment).toHaveBeenLastCalledWith({
        revision: 0,
        entries: [],
      });
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected test socket");

      const send = (revision: number) =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "machine-environment.replace",
            environment: { revision, entries: [] },
          }),
        });

      send(3);
      send(2);
      expect(onMachineEnvironment).toHaveBeenCalledTimes(2);
      expect(onMachineEnvironment).toHaveBeenLastCalledWith({
        revision: 3,
        entries: [],
      });
      socket.reconnect();
      await vi.waitFor(() => expect(connection.sessionId).toBe("second"));
      send(1);
      expect(onMachineEnvironment).toHaveBeenLastCalledWith({
        revision: 1,
        entries: [],
      });
    } finally {
      await connection.shutdown();
    }
  });

  it("dispatches the machine shutdown command", async () => {
    const onMachineShutdown = vi.fn(async () => undefined);

    const { connection, webSocket } = createConnectionFixture({
      onMachineShutdown,
    });

    await connection.start();
    const socket = webSocket.sockets[0];

    if (!socket) throw new Error("Expected test socket");

    socket.onmessage?.({
      data: JSON.stringify({
        type: "machine.shutdown",
      }),
    });

    await vi.waitFor(() => {
      expect(onMachineShutdown).toHaveBeenCalledOnce();
    });
    await connection.shutdown();
  });

  it("hands ended provider questions to the registry", async () => {
    const onInteractiveRequestsEnded = vi.fn();

    const { connection, webSocket } = createConnectionFixture({
      onInteractiveRequestsEnded,
    });

    await connection.start();
    const socket = webSocket.sockets[0];

    if (!socket) throw new Error("Expected test socket");

    const request = {
      threadId: "thr_ended",
      providerId: "claude-code",
      providerThreadId: "provider-thr-ended",
      providerRequestId: "request-ended",
    };

    socket.onmessage?.({
      data: JSON.stringify({
        type: "interactive-requests.end",
        requests: [request],
        reason: "closed on the server",
      }),
    });

    await vi.waitFor(() => {
      expect(onInteractiveRequestsEnded).toHaveBeenCalledWith({
        reason: "closed on the server",
        requests: [request],
      });
    });
    await connection.shutdown();
  });

  it("hands a server.moved message to the move handler", async () => {
    const onServerMoved = vi.fn(async () => undefined);

    const { connection, webSocket } = createConnectionFixture({
      onServerMoved,
    });

    await connection.start();
    const socket = webSocket.sockets[0];

    if (!socket) throw new Error("Expected test socket");

    socket.onmessage?.({
      data: JSON.stringify({
        type: "server.moved",
        serverUrl: "https://new-server.example.test",
        headers: { "x-omnyo-connect-machine": "bbcm_new" },
      }),
    });

    await vi.waitFor(() => {
      expect(onServerMoved).toHaveBeenCalledWith({
        serverUrl: "https://new-server.example.test",
        headers: { "x-omnyo-connect-machine": "bbcm_new" },
        source: "message",
      });
    });
    await connection.shutdown();
  });

  it("switches servers instead of failing startup when session open answers 410 server_moved", async () => {
    const onServerMoved = vi.fn(async () => undefined);

    const movedError = new ServerResponseError({
      action: "open session",
      bodyMessage: "This Omnyo server moved to studio",
      code: "server_moved",
      retryable: false,
      serverMoved: {
        serverUrl: "http://studio.local:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
      status: 410,
      statusText: "Gone",
    });

    const { connection, logger, webSocket } = createConnectionFixture({
      onServerMoved,
      openSessionError: movedError,
    });

    const started = connection.start();
    started.catch(() => undefined);
    await vi.waitFor(() => {
      expect(onServerMoved).toHaveBeenCalledWith({
        source: "session-open",
        serverUrl: "http://studio.local:38886",
        headers: null,
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      });
      expect(logger.info).toHaveBeenCalledWith(
        { serverUrl: "http://127.0.0.1:3334" },
        "Waiting for server...",
      );
    });

    expect(webSocket.sockets[0]?.close).not.toHaveBeenCalled();
    await connection.shutdown();
  });

  it("fails startup on 410 server_moved when switching servers fails", async () => {
    const onServerMoved = vi.fn(async () => {
      throw new Error("config.json is invalid");
    });

    const movedError = new ServerResponseError({
      action: "open session",
      bodyMessage: "This Omnyo server moved to studio",
      code: "server_moved",
      retryable: false,
      serverMoved: {
        serverUrl: "http://studio.local:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
      status: 410,
      statusText: "Gone",
    });

    const { connection } = createConnectionFixture({
      onServerMoved,
      openSessionError: movedError,
    });

    await expect(connection.start()).rejects.toBe(movedError);
    expect(onServerMoved).toHaveBeenCalledOnce();
  });

  it("runs protocol self-update handling only for protocol mismatch rejection", async () => {
    const handleProtocolMismatch = vi.fn(async () => "updated" as const);
    const onSelfUpdateInstalled = vi.fn();

    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });

    const { connection } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch },
      onSelfUpdateInstalled,
    });

    void connection.start();
    await vi.waitFor(() => {
      expect(handleProtocolMismatch).toHaveBeenCalledOnce();
      expect(handleProtocolMismatch).toHaveBeenCalledWith({ force: false });
      expect(onSelfUpdateInstalled).toHaveBeenCalledOnce();
    });
    await connection.shutdown();
  });

  it("forces a self-update attempt when the server accepted a user retry", async () => {
    const handleProtocolMismatch = vi.fn(async () => "failed" as const);

    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      protocolUpdateRetryRequested: true,
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });

    const { connection } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch },
    });

    void connection.start();
    await vi.waitFor(() => {
      expect(handleProtocolMismatch).toHaveBeenCalledWith({ force: true });
    });
    await connection.shutdown();
  });

  it("keeps retrying after a protocol update failure instead of timing out startup", async () => {
    vi.useFakeTimers();
    const handleProtocolMismatch = vi.fn(async () => "failed" as const);
    const checkForUpdates = vi.fn(async () => "skipped" as const);

    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });

    const { connection, webSocket } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch, checkForUpdates },
      startupTimeoutMs: 100,
    });

    void connection.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(handleProtocolMismatch).toHaveBeenCalledOnce();
    expect(webSocket.sockets[0]?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledOnce();
    await connection.shutdown();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledOnce();
  });

  it("adds the machine credential to WS dial headers only when configured", async () => {
    const configured = createConnectionFixture({
      serverHeaders: {
        "x-omnyo-connect-machine": "bbcm_machine",
        "x-test-access": "opaque",
      },
    });

    const plain = createConnectionFixture();

    try {
      await configured.connection.start();
      await plain.connection.start();
      expect(configured.webSocket.headers[0]).toEqual({
        authorization: "Bearer host-key-server-connection-test",
        "x-omnyo-connect-machine": "bbcm_machine",
        "x-test-access": "opaque",
      });
      expect(plain.webSocket.headers[0]).toEqual({
        authorization: "Bearer host-key-server-connection-test",
      });
    } finally {
      await configured.connection.shutdown();
      await plain.connection.shutdown();
    }
  });

  it("logs delayed heartbeat timer ticks without logging normal heartbeats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "heartbeat" }),
        expect.any(Function),
      );
      expect(logger.warn).not.toHaveBeenCalled();

      vi.setSystemTime(25_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          heartbeatIntervalMs: 5_000,
          leaseTimeoutMs: 30_000,
          sessionId: "session-1",
          websocketReadyState: 1,
        }),
        "Host daemon heartbeat timer delayed",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("reports a system-suspension gap without calling it a heartbeat stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });

    try {
      await connection.start();
      await vi.advanceTimersByTimeAsync(5_000);

      vi.setSystemTime(300_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "Host daemon heartbeat timer delayed",
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ gapMs: 300_000 }),
        "Host daemon resumed after likely system suspension",
      );
      expect(webSocket.sockets[0]?.reconnect).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("grants a fresh acknowledgement lease after a shorter heartbeat delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(5_000);
      vi.setSystemTime(35_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ gapMs: 35_000 }),
        "Host daemon heartbeat timer delayed",
      );
      expect(socket.reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.reconnect).toHaveBeenCalledWith(
        1013,
        "heartbeat-ack-timeout",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("reconnects when server heartbeat acknowledgements stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(25_000);
      socket.onmessage?.({ data: JSON.stringify({ type: "heartbeat-ack" }) });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.reconnect).toHaveBeenCalledWith(
        1013,
        "heartbeat-ack-timeout",
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          lastAcknowledgedAt: 25_000,
          leaseTimeoutMs: 30_000,
          sessionId: "session-1",
        }),
        "Server heartbeat acknowledgements stopped; reconnecting",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("lets control and echo bypass queued bulk while preserving each terminal's order", async () => {
    const { connection, webSocket } = createConnectionFixture();

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected test socket");
      webSocket.setBufferedAmount(socket, 2 * 1024 * 1024);

      const output = {
        type: "terminal.output" as const,
        terminalId: "term-1",
        chunk: {
          seq: 0,
          dataBase64: Buffer.alloc(64 * 1024).toString("base64"),
        },
      };

      const exited = {
        type: "terminal.exited" as const,
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "user" as const,
      };

      const otherOutput = { ...output, terminalId: "term-2" };

      const echo = {
        ...output,
        terminalId: "term-3",
        chunk: { seq: 0, dataBase64: "YQ==" },
      };

      expect(connection.sendMessage(output)).toBe(true);
      expect(connection.sendMessage(exited)).toBe(true);
      expect(connection.sendMessage(otherOutput)).toBe(true);
      expect(socket.send).not.toHaveBeenCalled();
      connection.sendMessage({ type: "heartbeat" });
      connection.sendMessage(echo);
      const firstSend = vi.mocked(socket.send).mock.calls[0];
      webSocket.setBufferedAmount(socket, 0);
      firstSend?.[1]?.();
      expect(
        vi
          .mocked(socket.send)
          .mock.calls.map(([frame]) => decodeDaemonWirePayload(frame)?.message),
      ).toEqual([{ type: "heartbeat" }, echo, output, otherOutput, exited]);
    } finally {
      await connection.shutdown();
    }
  });

  it("delivers interactive control during a full 4 MiB replay and drains every chunk in order", async () => {
    const { connection, webSocket } = createConnectionFixture();

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected test socket");

      const chunks = Array.from({ length: 64 }, (_, seq) => ({
        seq,
        dataBase64: Buffer.alloc(64 * 1024, seq).toString("base64"),
      }));

      expect(
        connection.sendMessage({
          type: "terminal.replay",
          terminalId: "term-1",
          requestId: "replay",
          chunks,
          replayStartSeq: 0,
          nextSeq: 64,
        }),
      ).toBe(true);
      expect(connection.sendMessage({ type: "heartbeat" })).toBe(true);
      const sends = vi.mocked(socket.send).mock.calls;
      const beforeControl = sends.slice(0, -1);

      const wireBytes = (frame: string | Uint8Array) =>
        typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;

      expect(decodeDaemonWirePayload(sends.at(-1)![0])?.message).toEqual({
        type: "heartbeat",
      });
      expect(
        beforeControl.reduce((sum, [frame]) => sum + wireBytes(frame), 0),
      ).toBeLessThan(384 * 1024);
      const received = [];

      for (const [frame] of sends) {
        const message = decodeDaemonWirePayload(frame)?.message;

        if (message?.type !== "terminal.replay") continue;
        received.push(...message.chunks);
        expect(message.more).toBe(
          received.length < chunks.length ? true : undefined,
        );
        socket.onmessage?.({
          data: JSON.stringify({
            type: "transport.bulk-ack",
            bytes: wireBytes(frame),
          }),
        });
      }

      expect(received).toEqual(chunks);
      expect(socket.reconnect).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("waits for a bulk acknowledgement and sends file bytes as a binary frame", async () => {
    const { connection, webSocket } = createConnectionFixture();

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) throw new Error("Expected test socket");

      const content = new Uint8Array(64 * 1024).fill(129);

      const reply = {
        type: "host-rpc.response" as const,
        ok: true as const,
        commandType: "host.read_file_chunk" as const,
        requestId: "chunk-0",
        result: {
          path: "/test",
          sizeBytes: content.length,
          offset: 0,
          modifiedAtMs: 42,
          mimeType: null,
          revision: "a".repeat(64),
          content,
        },
      };

      for (let index = 0; index < 6; index++)
        expect(
          connection.sendMessage({ ...reply, requestId: `chunk-${index}` }),
        ).toBe(true);

      expect(socket.send).toHaveBeenCalledTimes(4);
      const first = vi.mocked(socket.send).mock.calls[0]?.[0];

      if (!(first instanceof Uint8Array))
        throw new Error("Expected file bytes");
      expect(decodeDaemonWirePayload(first)?.message).toEqual(reply);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "transport.bulk-ack",
          bytes: first.byteLength,
        }),
      });
      expect(socket.send).toHaveBeenCalledTimes(6);
      socket.onmessage?.({
        data: JSON.stringify({ type: "transport.bulk-ack", bytes: 1 }),
      });
      expect(socket.reconnect).toHaveBeenCalledWith(1013, "invalid-bulk-ack");
    } finally {
      await connection.shutdown();
    }
  });

  it("delivers a terminal exit that happened while disconnected once the socket reopens", async () => {
    const { connection, webSocket } = createConnectionFixture({
      sessionIds: ["first", "second"],
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      const exited = {
        type: "terminal.exited" as const,
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "process-exit" as const,
      };

      socket.reconnect();
      expect(connection.sendMessage(exited)).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(connection.sessionId).toBe("second"));
      await vi.waitFor(() =>
        expect(socket.send).toHaveBeenCalledWith(
          JSON.stringify(exited),
          expect.any(Function),
        ),
      );
    } finally {
      await connection.shutdown();
    }
  });

  it.each(["disconnected", "send-failure"])(
    "replays only the completed RPC response after %s without executing its command again",
    async (interruption) => {
      let finish: (() => void) | undefined;

      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });

      let sendResponse:
        | ((response: HostDaemonOnlineRpcResponseMessage) => boolean)
        | undefined;

      const sent: boolean[] = [];

      const onHostRpcRequest = vi.fn(
        async (request: HostDaemonOnlineRpcRequestMessage) => {
          await completed;

          if (!sendResponse)
            throw new Error("Response sender is not initialized");
          sent.push(
            sendResponse({
              type: "host-rpc.response",
              requestId: request.requestId,
              commandType: "environment.hook.run",
              ok: true,
              result: {},
            }),
          );
        },
      );

      const { connection, webSocket } = createConnectionFixture({
        sessionIds: ["first", "second", "third"],
        onHostRpcRequest,
      });

      sendResponse = (response) => connection.sendMessage(response);

      try {
        await connection.start();
        const socket = webSocket.sockets[0];

        if (!socket || !finish)
          throw new Error("Expected initialized RPC fixture");
        socket.onmessage?.({
          data: JSON.stringify({
            type: "host-rpc.request",
            requestId: "completed-rpc",
            command: {
              type: "environment.hook.run",
              operationId: "operation-1",
              path: "/fixture/workspace",
              kind: "teardown",
              timeoutMs: 1_000,
            },
          }),
        });
        expect(onHostRpcRequest).toHaveBeenCalledTimes(1);

        if (interruption === "disconnected") {
          socket.close();
          socket.onclose?.({ code: 1006, reason: "fixture-disconnected" });
        } else {
          vi.mocked(socket.send).mockImplementationOnce(() => {
            throw new Error("send failed");
          });
        }

        finish();
        await vi.waitFor(() => expect(sent).toEqual([false]));

        if (interruption === "disconnected") {
          socket.reconnect();
        }

        await vi.waitFor(() => expect(connection.sessionId).toBe("second"));

        const response = {
          type: "host-rpc.response",
          requestId: "completed-rpc",
          commandType: "environment.hook.run",
          ok: true,
          result: {},
        };

        await vi.waitFor(() =>
          expect(socket.send).toHaveBeenCalledTimes(
            interruption === "send-failure" ? 2 : 1,
          ),
        );
        expect(
          JSON.parse(
            String(vi.mocked(socket.send).mock.calls.at(-1)?.[0] ?? "null"),
          ),
        ).toEqual(response);
        const sends = vi.mocked(socket.send).mock.calls.length;
        expect(sends).toBe(interruption === "send-failure" ? 2 : 1);
        socket.reconnect();
        await vi.waitFor(() => expect(connection.sessionId).toBe("third"));
        expect(socket.send).toHaveBeenCalledTimes(sends);
        expect(onHostRpcRequest).toHaveBeenCalledTimes(1);
      } finally {
        await connection.shutdown();
      }
    },
  );

  it("reconnects when a terminal websocket send throws", async () => {
    const { connection, webSocket } = createConnectionFixture({
      autoReconnect: false,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      vi.mocked(socket.send).mockImplementation(() => {
        throw new Error("send failed");
      });

      expect(
        connection.sendMessage({
          type: "terminal.output",
          terminalId: "term-1",
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("hello").toString("base64"),
          },
        }),
      ).toBe(false);
      expect(socket.reconnect).toHaveBeenCalledWith(1013, "send-failed");
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("reconnects when queued terminal output exceeds its limit", async () => {
    const { connection, webSocket } = createConnectionFixture({
      autoReconnect: false,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      webSocket.setBufferedAmount(socket, 2 * 1024 * 1024);

      const dataBase64 = Buffer.alloc(64 * 1024).toString("base64");
      let accepted = true;

      for (let seq = 0; accepted && seq < 600; seq += 1) {
        accepted = connection.sendMessage({
          type: "terminal.output",
          terminalId: "term-1",
          chunk: { seq, dataBase64 },
        });
      }

      expect(accepted).toBe(false);
      expect(socket.reconnect).toHaveBeenCalledWith(
        1013,
        "terminal-backpressure",
      );
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("reconnects when draining queued terminal output throws", async () => {
    const { connection, webSocket } = createConnectionFixture({
      autoReconnect: false,
    });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      connection.sendMessage({ type: "heartbeat" });
      const written = vi.mocked(socket.send).mock.calls[0]?.[1];
      webSocket.setBufferedAmount(socket, 2 * 1024 * 1024);

      expect(
        connection.sendMessage({
          type: "terminal.output",
          terminalId: "term-1",
          chunk: {
            seq: 0,
            dataBase64: Buffer.alloc(64 * 1024).toString("base64"),
          },
        }),
      ).toBe(true);

      vi.mocked(socket.send).mockImplementation(() => {
        throw new Error("send failed");
      });
      webSocket.setBufferedAmount(socket, 0);
      written?.();

      expect(socket.reconnect).toHaveBeenCalledWith(1013, "send-failed");
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("rejects a malformed host RPC command without disconnecting", async () => {
    const { connection, logger, setSession, webSocket } =
      createConnectionFixture();

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      socket.onmessage?.({
        data: JSON.stringify({
          type: "host-rpc.request",
          requestId: "invalid-transcription",
          command: {
            type: "thread.stop",
            intent: "interrupt",
            environmentId: "",
            threadId: "",
          },
        }),
      });

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "host-rpc.response",
          requestId: "invalid-transcription",
          commandType: "thread.stop",
          ok: false,
          errorCode: "invalid_command",
          errorMessage: "Invalid host RPC command",
        }),
        expect.any(Function),
      );
      expect(socket.close).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenLastCalledWith(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          commandType: "thread.stop",
          requestId: "invalid-transcription",
        }),
        "Rejected invalid host RPC command",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("deduplicates inactive-session invalidation and reconnects only the current session", async () => {
    const { connection, logger, setSession, webSocket } =
      createConnectionFixture({
        autoReconnect: false,
      });

    try {
      await connection.start();
      const socket = webSocket.sockets[0];

      if (!socket) {
        throw new Error("Expected test socket");
      }

      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "stale-session",
        source: "postEvents",
      });
      expect(socket.reconnect).not.toHaveBeenCalled();

      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "session-1",
        source: "postEvents",
      });
      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "session-1",
        source: "postEvents",
      });

      expect(socket.reconnect).toHaveBeenCalledTimes(1);
      expect(socket.reconnect).toHaveBeenCalledWith(1000, "inactive-session");
      expect(setSession).toHaveBeenLastCalledWith(null);
      expect(logger.info).toHaveBeenCalledWith(
        {
          code: "inactive_session",
          sessionId: "session-1",
          source: "postEvents",
        },
        "Server reported inactive daemon session; reconnecting",
      );
    } finally {
      await connection.shutdown();
    }
  });
});
