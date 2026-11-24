import { Buffer } from "node:buffer";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  buildHostDaemonWebSocketAuthorizationHeader,
  buildHostDaemonWebSocketProtocols,
  encodeDaemonWirePayload,
  isDaemonBulkPayload,
  type DaemonWirePayload,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonRpcCommandTypeSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonSessionCloseReason,
  type HostDaemonSessionOpenResponse,
  type HostDaemonDaemonWsMessage,
} from "@omnyo/host-daemon-contract";
import { z } from "zod";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECTION_DELAY,
  DEFAULT_MIN_RECONNECTION_DELAY,
  DEFAULT_RECONNECTION_DELAY_GROW_FACTOR,
  DEFAULT_STARTUP_TIMEOUT_MS,
  OPEN_READY_STATE,
  createDefaultReconnectingWebSocket,
  decodeWebSocketMessageData,
  type CreateReconnectingWebSocket,
  type ReconnectingWebSocketLike,
  type ServerConnectionOptions,
} from "./server-connection-support.js";
import { isLikelySystemSuspensionDelay } from "@omnyo/process-utils";
import { sliceUtf16Head } from "@omnyo/text-utils";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import { ServerResponseError } from "./server-client.js";
import {
  SessionSendQueue,
  sessionSendStreamKey,
} from "./session-send-queue.js";
import { StreamSendWindow } from "./stream-send-window.js";

export type { CreateReconnectingWebSocket } from "./server-connection-support.js";

interface InvalidServerMessageArgs {
  data: unknown;
  error: Error;
}

const invalidHostRpcRequestEnvelopeSchema = z
  .object({
    type: z.literal("host-rpc.request"),
    requestId: z.string().min(1),
    command: z.object({ type: hostDaemonRpcCommandTypeSchema }).passthrough(),
  })
  .passthrough();

interface ServerMessagePayloadSummary {
  payloadLength: number;
  payloadPreview: string;
  payloadTruncated: boolean;
}

export type ServerSessionInvalidationSource =
  | "callTool"
  | "fetchProjectAttachment"
  | "fetchSkillTree"
  | "fetchPluginHostArtifact"
  | "interruptInteractiveRequests"
  | "postEvents"
  | "registerInteractiveRequest";

export interface HandleServerSessionInvalidatedArgs {
  code: "inactive_session";
  observedSessionId: string;
  source: ServerSessionInvalidationSource;
}

type SessionCloseHandler = (
  reason: HostDaemonSessionCloseReason,
) => void | Promise<void>;

const SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS = 512;

const BULK_SOCKET_HIGH_WATER_BYTES = 64 * 1024;

const REPLAY_FRAME_TARGET_BYTES = 96 * 1024;

const BULK_SOCKET_MAX_QUEUE_BYTES = 32 * 1024 * 1024;

interface PendingSocketPayload {
  bulk: boolean;
  bytes: number;
  frame: DaemonWirePayload;
  message: HostDaemonDaemonWsMessage;
  recoverableKey: string | null;
}

function recoverableMessageKey(
  message: HostDaemonDaemonWsMessage,
): string | null {
  switch (message.type) {
    case "connect-tunnel.identity":
      return "connect-tunnel.identity";
    case "environment-change":
      return `environment-change\u0000${message.environmentId}\u0000${message.change}`;
    case "environment-metadata-change":
      return `environment-metadata-change\u0000${message.environmentId}`;
    case "terminal.exited":
      return `terminal.exited\u0000${message.terminalId}`;
    case "host-rpc.response":
      return `host-rpc.response\u0000${message.requestId}`;
    default:
      return null;
  }
}

function summarizeServerMessagePayload(
  data: unknown,
): ServerMessagePayloadSummary {
  const text = decodeWebSocketMessageData(data);

  return {
    payloadLength: text.length,
    payloadPreview: sliceUtf16Head(text, SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS),
    payloadTruncated: text.length > SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS,
  };
}

export class ServerConnection {
  private readonly createWebSocket: CreateReconnectingWebSocket;
  private readonly startupTimeoutMs: number;

  private session: HostDaemonSessionOpenResponse | null = null;
  private machineEnvironmentRevision = -1;
  private diagnosticsPolicyRevision = -1;
  private connectionGeneration = 0;
  private websocket: ReconnectingWebSocketLike | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAcknowledgedAt: number | null = null;
  private lastHeartbeatTickAt: number | null = null;
  private privateUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private privateUpdateCheck: Promise<void> | null = null;
  private stopped = false;
  private sessionCloseHandler: SessionCloseHandler | undefined;
  private fatalConnectError: ServerResponseError | null = null;
  private protocolMismatchObserved = false;
  private sessionInvalidationInProgress = false;
  private readonly pendingSocketPayloads =
    new SessionSendQueue<PendingSocketPayload>();
  private readonly streamSendWindow = new StreamSendWindow();
  private readonly pendingRecoverableMessages = new Map<
    string,
    HostDaemonDaemonWsMessage
  >();

  constructor(private readonly options: ServerConnectionOptions) {
    this.createWebSocket =
      options.createWebSocket ?? createDefaultReconnectingWebSocket;
    options.onDiagnosticsPolicy?.(false);
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  async start(): Promise<HostDaemonSessionOpenResponse> {
    this.stopped = false;
    this.startPrivateUpdateChecks();

    return this.connectWebSocket(null);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.sessionInvalidationInProgress = false;

    if (this.privateUpdateInterval !== null) {
      clearInterval(this.privateUpdateInterval);
      this.privateUpdateInterval = null;
    }

    this.clearHeartbeat();
    this.clearSession();
    this.pendingRecoverableMessages.clear();

    if (this.websocket) {
      const websocket = this.websocket;
      this.websocket = null;
      websocket.onmessage = null;
      websocket.onclose = null;
      websocket.close();
    }
  }

  sendMessage(message: HostDaemonDaemonWsMessage): boolean {
    const parsed = hostDaemonDaemonWsMessageSchema.parse(message);

    if (parsed.type !== "terminal.replay")
      return this.sendParsedMessage(parsed);

    let start = 0;
    let bytes = 0;

    for (const [index, chunk] of parsed.chunks.entries()) {
      const chunkBytes = chunk.dataBase64.length + 48;

      if (index > start && bytes + chunkBytes > REPLAY_FRAME_TARGET_BYTES) {
        if (
          !this.sendParsedMessage({
            ...parsed,
            chunks: parsed.chunks.slice(start, index),
            more: true,
          })
        )
          return false;
        start = index;
        bytes = 0;
      }

      bytes += chunkBytes;
    }

    return this.sendParsedMessage(
      start === 0 ? parsed : { ...parsed, chunks: parsed.chunks.slice(start) },
    );
  }

  private sendParsedMessage(parsed: HostDaemonDaemonWsMessage): boolean {
    const recoverableKey = recoverableMessageKey(parsed);
    const websocket = this.websocket;

    if (!websocket || websocket.readyState !== OPEN_READY_STATE) {
      if (recoverableKey !== null)
        this.pendingRecoverableMessages.set(recoverableKey, parsed);

      return false;
    }

    const frame = encodeDaemonWirePayload(parsed);

    const bytes =
      typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;

    const bulk = isDaemonBulkPayload(parsed, bytes);
    const stream = sessionSendStreamKey(parsed);
    const pending = { bulk, bytes, frame, message: parsed, recoverableKey };

    if (
      stream !== null &&
      (this.pendingSocketPayloads.hasStream(stream) ||
        (bulk &&
          (this.pendingSocketPayloads.bytes > 0 ||
            !this.canWriteBulk(websocket))))
    ) {
      if (
        this.pendingSocketPayloads.bytes + bytes >
        BULK_SOCKET_MAX_QUEUE_BYTES
      ) {
        this.retainRecoverablePayload(pending);
        this.options.logger.warn(
          {
            maxQueueBytes: BULK_SOCKET_MAX_QUEUE_BYTES,
            pendingBytes: this.pendingSocketPayloads.bytes,
          },
          "Daemon WebSocket bulk queue exceeded its limit",
        );
        this.clearSocketPayloads();
        websocket.reconnect(1013, "terminal-backpressure");

        return false;
      }

      this.pendingSocketPayloads.push(stream, pending);
      this.drainSocketPayloads(websocket);

      return true;
    }

    return this.writeSocketPayload(websocket, pending);
  }

  private canWriteBulk(websocket: ReconnectingWebSocketLike): boolean {
    return (
      this.streamSendWindow.open &&
      (websocket.bufferedAmount ?? 0) <= BULK_SOCKET_HIGH_WATER_BYTES
    );
  }

  private retainRecoverablePayload(pending: PendingSocketPayload): void {
    if (pending.recoverableKey !== null)
      this.pendingRecoverableMessages.set(
        pending.recoverableKey,
        pending.message,
      );
  }

  private writeSocketPayload(
    websocket: ReconnectingWebSocketLike,
    pending: PendingSocketPayload,
  ): boolean {
    const generation = this.connectionGeneration;

    const fail = (error: unknown) => {
      this.retainRecoverablePayload(pending);
      this.options.logger.warn(
        { ...runtimeErrorLogFields(error), type: pending.message.type },
        "Failed to send websocket message",
      );
      this.clearSocketPayloads();
      websocket.reconnect(1013, "send-failed");
    };

    if (pending.bulk)
      this.streamSendWindow.recordWrite(pending.bytes, performance.now());

    try {
      websocket.send(pending.frame, (error) => {
        if (
          this.websocket !== websocket ||
          generation !== this.connectionGeneration ||
          websocket.readyState !== OPEN_READY_STATE
        )
          return;

        if (error) fail(error);
        else this.drainSocketPayloads(websocket);
      });
    } catch (error) {
      fail(error);

      return false;
    }

    if (pending.recoverableKey !== null)
      this.pendingRecoverableMessages.delete(pending.recoverableKey);

    return true;
  }

  private drainSocketPayloads(websocket: ReconnectingWebSocketLike): void {
    while (
      websocket.readyState === OPEN_READY_STATE &&
      this.canWriteBulk(websocket)
    ) {
      const pending = this.pendingSocketPayloads.takeNextStreamPayload();

      if (pending === undefined || !this.writeSocketPayload(websocket, pending))
        return;
    }
  }

  private clearSocketPayloads(): void {
    for (const pending of this.pendingSocketPayloads.clear())
      this.retainRecoverablePayload(pending);
    this.streamSendWindow.reset();
  }

  setSessionCloseHandler(handler: SessionCloseHandler | undefined): void {
    this.sessionCloseHandler = handler;
  }

  handleSessionInvalidated(args: HandleServerSessionInvalidatedArgs): void {
    if (this.stopped || this.sessionInvalidationInProgress) {
      return;
    }

    const session = this.session;

    if (!session || session.sessionId !== args.observedSessionId) {
      return;
    }

    this.sessionInvalidationInProgress = true;
    this.options.logger.info(
      {
        code: args.code,
        sessionId: args.observedSessionId,
        source: args.source,
      },
      "Server reported inactive daemon session; reconnecting",
    );
    this.clearHeartbeat();
    this.clearSession();
    this.websocket?.reconnect(1000, "inactive-session");
  }

  private async openSession(
    generation: number,
  ): Promise<HostDaemonSessionOpenResponse> {
    this.fatalConnectError = null;

    try {
      const session = await this.options.serverClient.openSession({
        hostId: this.options.hostId,
        instanceId: this.options.instanceId,
        hostName: this.options.hostName,
        dataDir: this.options.dataDir,
        localApiPort: this.options.localApiPort,
        activeThreads: this.options.getActiveThreads?.() ?? [],
        openThreadWork: this.options.getOpenThreadWork?.() ?? [],
        undeliveredEventThreadIds:
          this.options.getUndeliveredEventThreadIds?.() ?? [],
        loadedEnvironments: this.options.getLoadedEnvironments?.() ?? [],
      });

      if (generation !== this.connectionGeneration || this.stopped) {
        throw new Error("Discarded obsolete host session");
      }

      this.session = session;
      this.machineEnvironmentRevision = session.machineEnvironment.revision;
      this.options.onMachineEnvironment?.(session.machineEnvironment);

      return session;
    } catch (error) {
      if (
        error instanceof ServerResponseError &&
        error.serverMoved !== null &&
        this.options.onServerMoved !== undefined
      ) {
        const moved = error.serverMoved;
        this.options.logger.info(
          { serverUrl: moved.serverUrl, toHostName: moved.toHostName },
          "The Omnyo server moved; switching this daemon to the new address",
        );

        const switched = await this.options
          .onServerMoved({
            source: "session-open",
            serverUrl: moved.serverUrl,
            headers: moved.headers ?? null,
            toHostName: moved.toHostName,
            movedAt: moved.movedAt,
          })
          .then(
            () => true,
            (handlerError: unknown) => {
              this.options.logger.error(
                { ...runtimeErrorLogFields(handlerError) },
                "Failed to switch this daemon to the moved Omnyo server",
              );

              return false;
            },
          );

        if (switched) {
          throw error;
        }
      }

      if (
        error instanceof ServerResponseError &&
        error.code === "protocol_version_mismatch"
      ) {
        this.protocolMismatchObserved = true;

        const result =
          await this.options.protocolSelfUpdater?.handleProtocolMismatch({
            force: error.protocolUpdateRetryRequested,
          });

        if (result === "updated") {
          await this.options.onSelfUpdateInstalled?.();
        }
      }

      if (
        error instanceof ServerResponseError &&
        !error.retryable &&
        error.code !== "protocol_version_mismatch"
      ) {
        this.fatalConnectError = error;
        this.logFatalConnectError(error);
      }

      throw error;
    }
  }

  private logFatalConnectError(error: ServerResponseError): void {
    const base = {
      hostId: this.options.hostId,
      serverUrl: this.options.serverUrl,
      status: error.status,
      code: error.code,
      detail: error.bodyMessage,
    };

    if (error.status === 401 || error.status === 403) {
      this.options.logger.error(
        base,
        "Server rejected host credentials — this host is not registered with the server.",
      );

      return;
    }

    this.options.logger.error(
      { ...base, daemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION },
      "Server rejected the daemon session. This usually means the server is running an incompatible protocol version — restart it (e.g. `pnpm dev:restart`).",
    );
  }

  private async connectWebSocket(
    initialSessionId: string | null,
  ): Promise<HostDaemonSessionOpenResponse> {
    let nextSessionId: string | null = initialSessionId;

    const websocket = this.createWebSocket(
      async () => {
        this.clearSession();
        const generation = this.connectionGeneration;

        if (!nextSessionId) {
          nextSessionId = (await this.openSession(generation)).sessionId;
        }

        const sessionId = nextSessionId;
        nextSessionId = null;

        return this.buildWebSocketUrl(sessionId);
      },
      {
        minReconnectionDelay: DEFAULT_MIN_RECONNECTION_DELAY,
        maxReconnectionDelay: DEFAULT_MAX_RECONNECTION_DELAY,
        reconnectionDelayGrowFactor: DEFAULT_RECONNECTION_DELAY_GROW_FACTOR,
        connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
        headers: {
          authorization: buildHostDaemonWebSocketAuthorizationHeader(
            this.options.hostKey,
          ),
          ...this.options.serverHeaders,
        },
        maxRetries: Number.POSITIVE_INFINITY,
        protocols: buildHostDaemonWebSocketProtocols(),
      },
    );

    this.websocket = websocket;

    return new Promise<HostDaemonSessionOpenResponse>((resolve, reject) => {
      let settled = false;
      let hasOpened = false;

      const startupTimer = setTimeout(() => {
        if (this.protocolMismatchObserved) {
          return;
        }

        fail(
          new Error(
            `Server connection timed out after ${this.startupTimeoutMs}ms`,
          ),
        );
      }, this.startupTimeoutMs);

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(startupTimer);
        void this.shutdown();
        reject(normalizeCaughtError(error));
      };

      websocket.onopen = () => {
        if (this.websocket !== websocket || this.stopped) return;
        const generation = this.connectionGeneration;
        websocket.onclose = (event) => {
          if (generation === this.connectionGeneration) handleClose(event);
        };

        websocket.onerror = (event) => {
          if (generation === this.connectionGeneration) handleError(event);
        };

        websocket.onmessage = (event) => {
          if (
            this.websocket !== websocket ||
            generation !== this.connectionGeneration ||
            this.stopped
          )
            return;
          this.handleWebSocketMessage(event.data);
        };

        this.protocolMismatchObserved = false;
        const session = this.session;

        if (!session) {
          fail(new Error("WebSocket opened before session was available"));

          return;
        }

        const handleOpen = async () => {
          hasOpened = true;
          this.sessionInvalidationInProgress = false;
          clearTimeout(startupTimer);
          this.resetHeartbeat();
          this.options.setSession?.(session);
          this.options.logger.info(
            { sessionId: session.sessionId },
            "Connected to server",
          );
          await this.options.onSessionOpened?.(session);

          if (generation !== this.connectionGeneration || this.stopped) return;
          this.flushPendingRecoverableMessages();

          if (!settled) {
            settled = true;
            resolve(session);
          }
        };

        void handleOpen().catch((error) => {
          if (generation !== this.connectionGeneration || this.stopped) return;

          if (!settled) {
            fail(error);

            return;
          }

          this.options.logger.error(
            { err: error, sessionId: session.sessionId },
            "Failed to finish websocket open handling",
          );
        });
      };

      const handleClose = (event: { code: number; reason: string }) => {
        if (this.websocket !== websocket || this.stopped) return;
        this.clearHeartbeat();
        this.clearSession();

        if (!hasOpened) {
          this.options.logger.warn(
            { code: event.code, reason: event.reason },
            "Waiting for server connection...",
          );

          return;
        }

        this.options.logger.info(
          { code: event.code, reason: event.reason },
          "Disconnected from server",
        );

        if (this.stopped) {
          return;
        }
      };

      websocket.onclose = handleClose;

      const handleError = (error: unknown) => {
        if (hasOpened) {
          this.options.logger.warn({ err: error }, "WebSocket error");

          return;
        }

        if (this.fatalConnectError) {
          fail(this.fatalConnectError);

          return;
        }

        this.options.logger.info(
          { serverUrl: this.options.serverUrl },
          "Waiting for server...",
        );
      };

      websocket.onerror = handleError;
    });
  }

  private flushPendingRecoverableMessages(): void {
    for (const message of Array.from(
      this.pendingRecoverableMessages.values(),
    )) {
      if (!this.sendMessage(message)) {
        return;
      }
    }
  }

  private handleWebSocketMessage(data: unknown): void {
    const text = decodeWebSocketMessageData(data);
    let decoded: unknown;

    try {
      decoded = JSON.parse(text);
    } catch (error) {
      this.handleInvalidServerMessage({
        data,
        error: normalizeCaughtError(error),
      });

      return;
    }

    const message = hostDaemonServerWsMessageSchema.safeParse(decoded);

    if (!message.success) {
      const invalidRpcRequest =
        invalidHostRpcRequestEnvelopeSchema.safeParse(decoded);

      if (invalidRpcRequest.success) {
        this.options.logger.warn(
          {
            commandType: invalidRpcRequest.data.command.type,
            err: message.error,
            requestId: invalidRpcRequest.data.requestId,
          },
          "Rejected invalid host RPC command",
        );
        this.sendMessage({
          type: "host-rpc.response",
          requestId: invalidRpcRequest.data.requestId,
          commandType: invalidRpcRequest.data.command.type,
          ok: false,
          errorCode: "invalid_command",
          errorMessage: "Invalid host RPC command",
        });

        return;
      }

      this.handleInvalidServerMessage({ data, error: message.error });

      return;
    }

    if (message.data.type === "session-close") {
      this.handleSessionCloseMessage(message.data.reason);

      return;
    }

    if (message.data.type === "interactive-requests.end") {
      this.options.onInteractiveRequestsEnded?.({
        reason: message.data.reason,
        requests: message.data.requests,
      });

      return;
    }

    if (message.data.type === "machine.shutdown") {
      void Promise.resolve(this.options.onMachineShutdown?.()).catch(
        (error) => {
          this.options.logger.error(
            { ...runtimeErrorLogFields(error) },
            "Machine shutdown failed",
          );
        },
      );

      return;
    }

    if (message.data.type === "server.moved") {
      this.clearSession();
      const move = message.data;
      void Promise.resolve(
        this.options.onServerMoved?.({
          serverUrl: move.serverUrl,
          headers: move.headers,
          source: "message",
        }),
      ).catch((error) => {
        this.options.logger.error(
          { ...runtimeErrorLogFields(error), serverUrl: move.serverUrl },
          "Failed to switch this daemon to the moved Omnyo server",
        );
      });

      return;
    }

    if (message.data.type === "diagnostics-policy.replace") {
      if (message.data.policy.revision > this.diagnosticsPolicyRevision) {
        this.diagnosticsPolicyRevision = message.data.policy.revision;
        this.options.onDiagnosticsPolicy?.(
          message.data.policy.crashReportsEnabled,
        );
      }

      return;
    }

    if (message.data.type === "machine-environment.replace") {
      if (message.data.environment.revision > this.machineEnvironmentRevision) {
        this.machineEnvironmentRevision = message.data.environment.revision;
        this.options.onMachineEnvironment?.(message.data.environment);
      }

      return;
    }

    if (message.data.type === "heartbeat-ack") {
      if (this.session !== null) {
        this.lastHeartbeatAcknowledgedAt = Date.now();
      }

      return;
    }

    if (message.data.type === "host-rpc.request") {
      const rpcRequest = message.data;
      void Promise.resolve(this.options.onHostRpcRequest?.(rpcRequest)).catch(
        (error) => {
          this.options.logger.warn(
            {
              commandType: rpcRequest.command.type,
              ...runtimeErrorLogFields(error),
            },
            "Online host RPC handler failed",
          );
        },
      );

      return;
    }

    if (message.data.type === "transport.bulk-ack") {
      const websocket = this.websocket;

      if (websocket === null) return;

      if (
        this.streamSendWindow.acknowledge(message.data.bytes, performance.now())
      ) {
        this.drainSocketPayloads(websocket);
      } else {
        websocket.reconnect(1013, "invalid-bulk-ack");
      }

      return;
    }

    if (message.data.type === "command-catalog-retain") {
      void this.options
        .onCatalogRetain?.(message.data.scopes)
        .catch((error: unknown) => {
          this.options.logger.warn(
            runtimeErrorLogFields(error),
            "Command catalog watch release failed",
          );
        });

      return;
    }

    if (message.data.type === "watch-set.replace") {
      const watchSetMessage = message.data;
      void Promise.resolve(
        this.options.onWatchSetReplace?.(watchSetMessage),
      ).catch((error) => {
        this.options.logger.warn(
          {
            generation: watchSetMessage.generation,
            ...runtimeErrorLogFields(error),
          },
          "Watch set handler failed",
        );
      });

      return;
    }

    if (message.data.type === "connect-shares.replace") {
      const sharesMessage = message.data;
      void Promise.resolve(
        this.options.onConnectSharesReplace?.(sharesMessage),
      ).catch((error) => {
        this.options.logger.warn(
          {
            generation: sharesMessage.generation,
            ...runtimeErrorLogFields(error),
          },
          "Connect shares handler failed",
        );
      });

      return;
    }

    const terminalMessage = message.data;

    void Promise.resolve()
      .then(() => this.options.onTerminalMessage?.(terminalMessage))
      .catch((error) => {
        this.options.logger.warn(
          {
            type: terminalMessage.type,
            ...runtimeErrorLogFields(error),
          },
          "Terminal websocket message handler failed",
        );
      });
  }

  private handleSessionCloseMessage(
    reason: HostDaemonSessionCloseReason,
  ): void {
    if (reason === "expired") {
      this.options.logger.info(
        { sessionId: this.session?.sessionId ?? null },
        "Server expired host daemon session; reconnecting",
      );
      this.clearHeartbeat();
      this.clearSession();
      this.websocket?.reconnect(1000, "expired");

      return;
    }

    void Promise.resolve(this.sessionCloseHandler?.(reason)).catch(
      () => undefined,
    );
    this.shutdownAfterServerMessage(
      "Failed to close server-requested websocket connection",
    );
  }

  private handleInvalidServerMessage(args: InvalidServerMessageArgs): void {
    this.options.logger.error(
      {
        err: args.error,
        ...summarizeServerMessagePayload(args.data),
      },
      "Invalid server websocket message; closing connection",
    );

    void Promise.resolve(this.sessionCloseHandler?.("daemon-disconnect")).catch(
      (error) => {
        this.options.logger.error(
          { err: error },
          "Failed to handle invalid server message shutdown",
        );
      },
    );
    this.shutdownAfterServerMessage(
      "Failed to close invalid server websocket connection",
    );
  }

  private shutdownAfterServerMessage(logMessage: string): void {
    void this.shutdown().catch((error) => {
      this.options.logger.error({ err: error }, logMessage);
    });
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();

    if (!this.session) {
      return;
    }

    const startedAt = Date.now();
    this.lastHeartbeatAcknowledgedAt = startedAt;
    this.lastHeartbeatTickAt = startedAt;
    this.heartbeatInterval = setInterval(() => {
      const session = this.session;

      if (!session) {
        return;
      }

      const now = Date.now();
      const lastTickAt = this.lastHeartbeatTickAt;

      if (lastTickAt !== null) {
        const gapMs = now - lastTickAt;
        const thresholdMs = session.leaseTimeoutMs / 2;

        if (gapMs > session.leaseTimeoutMs) {
          this.lastHeartbeatAcknowledgedAt = now;
        }

        const resumedAfterSuspension = isLikelySystemSuspensionDelay({
          gapMs,
          intervalMs: session.heartbeatIntervalMs,
        });

        if (resumedAfterSuspension) {
          this.options.logger.info(
            {
              gapMs,
              heartbeatIntervalMs: session.heartbeatIntervalMs,
              leaseTimeoutMs: session.leaseTimeoutMs,
              sessionId: session.sessionId,
              websocketReadyState: this.websocket?.readyState ?? null,
            },
            "Host daemon resumed after likely system suspension",
          );
        } else if (gapMs > thresholdMs) {
          this.options.logger.warn(
            {
              gapMs,
              heartbeatIntervalMs: session.heartbeatIntervalMs,
              leaseTimeoutMs: session.leaseTimeoutMs,
              sessionId: session.sessionId,
              websocketReadyState: this.websocket?.readyState ?? null,
            },
            "Host daemon heartbeat timer delayed",
          );
        }
      }

      this.lastHeartbeatTickAt = now;

      if (!this.websocket || this.websocket.readyState !== OPEN_READY_STATE) {
        return;
      }

      const lastAcknowledgedAt = this.lastHeartbeatAcknowledgedAt;

      if (
        lastAcknowledgedAt !== null &&
        now - lastAcknowledgedAt > session.leaseTimeoutMs
      ) {
        this.options.logger.warn(
          {
            lastAcknowledgedAt,
            leaseTimeoutMs: session.leaseTimeoutMs,
            sessionId: session.sessionId,
          },
          "Server heartbeat acknowledgements stopped; reconnecting",
        );
        this.clearHeartbeat();
        this.websocket.reconnect(1013, "heartbeat-ack-timeout");

        return;
      }

      this.sendMessage({ type: "heartbeat" });
    }, this.session.heartbeatIntervalMs);
  }

  private startPrivateUpdateChecks(): void {
    if (
      this.privateUpdateInterval !== null ||
      !this.options.protocolSelfUpdater?.checkForUpdates
    )
      return;

    this.privateUpdateInterval = setInterval(
      () => {
        const updater = this.options.protocolSelfUpdater;

        if (
          this.stopped ||
          this.privateUpdateCheck !== null ||
          !updater?.checkForUpdates
        )
          return;

        this.privateUpdateCheck = updater
          .checkForUpdates()
          .then(async (result) => {
            if (result === "updated" && !this.stopped)
              await this.options.onSelfUpdateInstalled?.();
          })
          .catch((error) => {
            this.options.logger.error(
              { err: error },
              "Private worker update check failed",
            );
          })
          .finally(() => {
            this.privateUpdateCheck = null;
          });
      },
      5 * 60 * 1000,
    );
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.lastHeartbeatAcknowledgedAt = null;
    this.lastHeartbeatTickAt = null;
  }

  private clearSession(): void {
    this.connectionGeneration += 1;
    this.diagnosticsPolicyRevision = -1;
    this.options.onDiagnosticsPolicy?.(false);
    this.clearSocketPayloads();

    if (!this.session) {
      return;
    }

    this.session = null;
    this.options.setSession?.(null);
  }

  private buildWebSocketUrl(sessionId: string): string {
    const serverUrl = new URL(this.options.serverUrl);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    serverUrl.pathname = "/internal/ws";
    serverUrl.searchParams.set("sessionId", sessionId);

    return serverUrl.toString();
  }
}
