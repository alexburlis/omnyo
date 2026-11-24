import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import type { HeaderPair } from "@omnyo/tunnel-contract";
import type { WebSocket } from "ws";
import type { ClientIpSourceMode, RelayConfig } from "./config.js";
import type { RelayDatabase } from "./db.js";

export const CLIENT_IP_HEADER = "x-omnyo-client-ip";

export const INBOUND_CLIENT_IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  CLIENT_IP_HEADER,
] as const;

export const RETURN_GRACE_MS = 15_000;

export const TUNNEL_SILENCE_LIMIT_MS = 60_000;

export const STREAM_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

export const USER_BUFFER_LIMIT_BYTES = 32 * 1024 * 1024;

export const MAX_STREAMS_PER_TUNNEL = 256;

export const MAX_SERVERS_PER_USER = 5;

export const MAX_MACHINES_PER_USER = 20;

export const TUNNEL_MAX_PAYLOAD_BYTES = STREAM_BUFFER_LIMIT_BYTES + 1024 * 1024;

export const TUNNEL_SOCKET_SERVER_OPTIONS = {
  noServer: true,
  perMessageDeflate: false,
  maxPayload: TUNNEL_MAX_PAYLOAD_BYTES,
  autoPong: false,
} as const;

export const VISITOR_SOCKET_SERVER_OPTIONS = {
  noServer: true,
  perMessageDeflate: false,
  maxPayload: STREAM_BUFFER_LIMIT_BYTES,
  autoPong: false,
} as const;

export const REVOCATION_SWEEP_INTERVAL_MS = 15_000;

export const RELAY_STRICT_TRANSPORT_SECURITY =
  "max-age=31536000; includeSubDomains";

export const RELAY_RESTART_CLOSE_CODE = 1012;

export const RELAY_RESTART_CLOSE_REASON = "relay restarting";

export type TunnelOwner =
  | { kind: "server"; serverId: string }
  | { kind: "machine"; machineId: string };

export type VisitorGrant =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "machine"; userId: string; machineId: string }
  | { kind: "server"; userId: string; serverId: string }
  | { kind: "anonymous" };

export interface TunnelAttachment {
  routingKey: string;
  owner: TunnelOwner;
  protocolVersion: number;
  socket: WebSocket;
}

interface TunnelStreamTarget {
  routingKey: string;
  ownerUserId: string;
  expectedOwner: TunnelOwner | null;
  target: string | null;
  grant: VisitorGrant;
  signal: AbortSignal;
}

export interface TunnelHttpRequest extends TunnelStreamTarget {
  method: string;
  path: string;
  headers: HeaderPair[];
  body: ReadableStream<Uint8Array> | null;
}

export interface TunnelWsRequest extends TunnelStreamTarget {
  path: string;
  headers: HeaderPair[];
  protocols: string[];
}

export type TunnelWsOpenResult =
  | {
      kind: "accepted";
      protocol: string | null;
      bind(visitor: WebSocket): void;
      cancel(reason: string): void;
    }
  | { kind: "refused"; response: Response };

export interface VisitorStreamHandle {
  routingKey: string;
  grant: VisitorGrant;
  close(reason: string): void;
}

export interface TunnelRegistryStats {
  tunnels: number;
  visitorStreams: number;
  bufferedBytes: number;
  tunnelBacklogBytes: number;
}

export interface TunnelRegistry {
  attach(attachment: TunnelAttachment): void;
  has(routingKey: string): boolean;
  openHttpStream(request: TunnelHttpRequest): Promise<Response>;
  openWsStream(request: TunnelWsRequest): Promise<TunnelWsOpenResult>;
  close(routingKey: string, reason: string): void;
  visitorStreams(): readonly VisitorStreamHandle[];
  closeAll(code: number, reason: string): void;
  stats(): TunnelRegistryStats;
}

export interface ClientConnection {
  socket: Socket;
  headers: IncomingHttpHeaders;
}

export interface ClientIpSource {
  readonly mode: ClientIpSourceMode;
  deriveClientIp(connection: ClientConnection): string | null;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitRule {
  limit: number;
  periodMs: number;
}

const MINUTE_MS = 60_000;

export const RELAY_RATE_LIMITS = {
  signInStart: { limit: 20, periodMs: MINUTE_MS },
  gateHandshake: { limit: 30, periodMs: MINUTE_MS },
  linkStart: { limit: 10, periodMs: MINUTE_MS },
  codeRedeem: { limit: 10, periodMs: MINUTE_MS },
  tunnelDialPerLabel: { limit: 12, periodMs: MINUTE_MS },
  tunnelDialPerIp: { limit: 60, periodMs: MINUTE_MS },
  failedBearer: { limit: 10, periodMs: MINUTE_MS },
  installerPerIp: { limit: 30, periodMs: MINUTE_MS },
  previewPerIp: { limit: 300, periodMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

export type RelayRateLimitName = keyof typeof RELAY_RATE_LIMITS;

export type RelayRateLimiters = Readonly<
  Record<RelayRateLimitName, RateLimiter>
>;

export interface EgressUsage {
  userId: string;
  month: string;
  bytes: number;
  capBytes: number;
  resetsAt: Date;
}

export interface EgressCounter {
  add(userId: string, bytes: number): void;
  isOverCap(userId: string): boolean;
  usage(userId: string): EgressUsage;
  flush(): void;
}

export interface RelaySession {
  id: string;
  userId: string;
  expiresAt: Date;
  updatedAt: Date;
}

export interface RelayUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  githubLogin: string | null;
}

export interface AuthenticatedSession {
  session: RelaySession;
  user: RelayUser;
}

export interface AuthService {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthenticatedSession | null>;
  findLiveSession(sessionId: string, now: number): RelaySession | null;
  findUser(userId: string): RelayUser | null;
  renewSession(sessionId: string, now: number): RelaySession | null;
}

export type LogFieldValue = string | number | boolean | null;

export interface RelayLogger {
  info(event: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  warn(event: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
  error(event: string, fields?: Readonly<Record<string, LogFieldValue>>): void;
}

export interface RelayDeps {
  config: RelayConfig;
  database: RelayDatabase;
  tunnels: TunnelRegistry;
  clientIp: ClientIpSource;
  rateLimits: RelayRateLimiters;
  egress: EgressCounter;
  auth: AuthService;
  log: RelayLogger;
  now: () => number;
}
