import ReconnectingWebSocket from "partysocket/ws";
import {
  type DaemonWirePayload,
  type HostDaemonActiveThread,
  type HostDaemonInteractiveRequestKey,
  type HostDaemonOpenThreadWork,
  type HostDaemonLoadedEnvironment,
  type HostDaemonConnectSharesReplaceMessage,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonServerWsMessage,
  type HostDaemonSessionOpenResponse,
  type HostDaemonWatchSetReplaceMessage,
} from "@omnyo/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import type { ServerClient } from "./server-client.js";
import type { ProtocolSelfUpdater } from "./protocol-self-update.js";
import type { WebSocket as NodeWebSocket } from "ws";
import { createNodeWebSocketConstructor } from "./websocket-constructor.js";

export interface ReconnectingWebSocketLike {
  readonly bufferedAmount?: number;
  readonly readyState: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  send(data: DaemonWirePayload, onWritten?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  reconnect(code?: number, reason?: string): void;
}

interface ReconnectingWebSocketOptions {
  minReconnectionDelay: number;
  maxReconnectionDelay: number;
  reconnectionDelayGrowFactor: number;
  connectionTimeout: number;
  headers?: Record<string, string>;
  maxRetries: number;
  protocols?: string[];
}

export type CreateReconnectingWebSocket = (
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
) => ReconnectingWebSocketLike;

export type HostDaemonServerTerminalMessage = Exclude<
  HostDaemonServerWsMessage,
  | { type: "command-catalog-retain" }
  | { type: "machine.shutdown" }
  | { type: "interactive-requests.end" }
  | { type: "server.moved" }
  | { type: "session-close" }
  | { type: "heartbeat-ack" }
  | { type: "transport.bulk-ack" }
  | { type: "machine-environment.replace" }
  | { type: "diagnostics-policy.replace" }
  | HostDaemonOnlineRpcRequestMessage
  | HostDaemonWatchSetReplaceMessage
  | HostDaemonConnectSharesReplaceMessage
>;

export type ServerMovedNotice =
  | {
      source: "message";
      serverUrl: string;
      headers: Record<string, string>;
    }
  | {
      source: "session-open";
      serverUrl: string;
      headers: Record<string, string> | null;
      toHostName: string;
      movedAt: number;
    };

export interface ServerConnectionOptions {
  serverUrl: string;
  hostKey: string;
  logger: HostDaemonLogger;
  serverHeaders?: Record<string, string>;
  serverClient: ServerClient;
  protocolSelfUpdater?: ProtocolSelfUpdater;
  onSelfUpdateInstalled?: () => void | Promise<void>;
  hostId: string;
  hostName: string;
  dataDir: string;
  instanceId: string;
  localApiPort: number | null;
  setSession?: (session: HostDaemonSessionOpenResponse | null) => void;
  getActiveThreads?: () =>
    | HostDaemonActiveThread[]
    | Promise<HostDaemonActiveThread[]>;
  getUndeliveredEventThreadIds?: () => string[];
  getOpenThreadWork?: () => HostDaemonOpenThreadWork[];
  getLoadedEnvironments?: () =>
    | HostDaemonLoadedEnvironment[]
    | Promise<HostDaemonLoadedEnvironment[]>;
  onTerminalMessage?: (
    message: HostDaemonServerTerminalMessage,
  ) => void | Promise<void>;
  onHostRpcRequest?: (
    message: HostDaemonOnlineRpcRequestMessage,
  ) => void | Promise<void>;
  onCatalogRetain?: (
    scopes: Extract<
      HostDaemonServerWsMessage,
      { type: "command-catalog-retain" }
    >["scopes"],
  ) => Promise<void>;
  onWatchSetReplace?: (
    message: HostDaemonWatchSetReplaceMessage,
  ) => void | Promise<void>;
  onConnectSharesReplace?: (
    message: HostDaemonConnectSharesReplaceMessage,
  ) => void | Promise<void>;
  onSessionOpened?: (
    session: HostDaemonSessionOpenResponse,
  ) => void | Promise<void>;
  onMachineEnvironment?: (
    environment: HostDaemonSessionOpenResponse["machineEnvironment"],
  ) => void;
  onDiagnosticsPolicy?: (enabled: boolean) => void;
  onMachineShutdown?: () => void | Promise<void>;
  onInteractiveRequestsEnded?: (args: {
    reason: string;
    requests: HostDaemonInteractiveRequestKey[];
  }) => void;
  onServerMoved?: (move: ServerMovedNotice) => Promise<void>;
  createWebSocket?: CreateReconnectingWebSocket;
  startupTimeoutMs?: number;
}

export const DEFAULT_MIN_RECONNECTION_DELAY = 1_000;

export const DEFAULT_MAX_RECONNECTION_DELAY = 10_000;

export const DEFAULT_RECONNECTION_DELAY_GROW_FACTOR = 2;

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

export const OPEN_READY_STATE = 1;

export function createDefaultReconnectingWebSocket(
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
): ReconnectingWebSocketLike {
  const { headers, protocols, ...reconnectionOptions } = options;

  let currentSocket: NodeWebSocket | undefined;

  const socket = new ReconnectingWebSocket(urlProvider, protocols ?? [], {
    ...reconnectionOptions,
    WebSocket: createNodeWebSocketConstructor(headers, (socket) => {
      currentSocket = socket;
    }),
  });

  return Object.assign(socket, {
    send(data: DaemonWirePayload, onWritten?: (error?: Error) => void) {
      if (currentSocket?.readyState !== OPEN_READY_STATE)
        throw new Error("WebSocket is not open");
      currentSocket.send(
        data,
        { compress: typeof data === "string" },
        onWritten,
      );
    },
  });
}

export function decodeWebSocketMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return String(data);
}
