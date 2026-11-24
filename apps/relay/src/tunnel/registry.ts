import { and, eq, isNull } from "drizzle-orm";
import { WebSocket, type RawData } from "ws";
import { machine, server } from "@omnyo/connect-db";
import {
  ControlFrameTooLargeError,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  InvalidFrameError,
  MAX_CHUNK_BYTES,
  TUNNEL_REPLACED_CLOSE_REASON,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HeaderPair,
} from "@omnyo/tunnel-contract";
import {
  MAX_STREAMS_PER_TUNNEL,
  RETURN_GRACE_MS,
  STREAM_BUFFER_LIMIT_BYTES,
  USER_BUFFER_LIMIT_BYTES,
  TUNNEL_SILENCE_LIMIT_MS,
  type RelayLogger,
  type TunnelAttachment,
  type TunnelHttpRequest,
  type TunnelOwner,
  type TunnelRegistry,
  type TunnelWsOpenResult,
  type TunnelWsRequest,
  type VisitorGrant,
  type VisitorStreamHandle,
} from "../contracts.js";
import type { RelayDatabase } from "../db.js";
import { relayTextResponse, tunnelOfflineResponse } from "./offline.js";
import { withoutHopHeaders } from "./protocol-headers.js";
import {
  RESP_HEAD_TIMEOUT_MS,
  responseHeadTimeoutMs,
} from "./response-head-timeout.js";

export const TUNNEL_REVOKED_CLOSE_REASON = "revoked by owner";

export const STREAM_OVERFLOW_MESSAGE = "relay buffer limit exceeded";

export const STREAM_OVERFLOW_CLOSE_CODE = 1009;

export const INVALID_FRAME_MESSAGE = "the server sent an invalid tunnel frame";

export const TUNNEL_BACKLOG_LIMIT_BYTES = 4 * STREAM_BUFFER_LIMIT_BYTES;

export const GRACEFUL_RETIRE_BACKLOG_BYTES = 64 * 1024;

export const MAX_INVALID_FRAMES_PER_TUNNEL = 50;

export const REQUEST_HEADERS_TOO_LARGE_MESSAGE =
  "the request headers are too large for this address";

export const PORT_SHARE_TOO_OLD =
  "this Omnyo connect plugin is too old for port sharing; update Omnyo and reconnect";

const CLEAN_CLOSE_CODE = 1000;

const GOING_AWAY_CLOSE_CODE = 1001;

const ABNORMAL_CLOSE_CODE = 1006;

const POLICY_CLOSE_CODE = 1008;

const INTERNAL_ERROR_CLOSE_CODE = 1011;

const VISITOR_CANCELED_STATUS = 499;

const SILENCE_SWEEP_INTERVAL_MS = 5_000;

const PRESENCE_INTERVAL_MIN_MS = 25 * 60_000;

const PRESENCE_INTERVAL_JITTER_MS = 10 * 60_000;

const OVERFLOW_TERMINATE_AFTER_MS = 5_000;

const MAX_CLOSE_REASON_BYTES = 123;

const MAX_STREAM_ID = 0xffffffff;

const REQUEST_HEADERS_TOO_LARGE_STATUS = 431;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export interface TunnelRegistryOptions {
  database: RelayDatabase;
  log: RelayLogger;
  maxBufferedBytes: number;
  now?: () => number;
  random?: () => number;
  streamBufferLimitBytes?: number;
  returnGraceMs?: number;
  silenceLimitMs?: number;
  tunnelBacklogLimitBytes?: number;
  userBufferLimitBytes?: number;
}

interface TunnelEntry {
  routingKey: string;
  owner: TunnelOwner;
  protocolVersion: number;
  socket: WebSocket;
  nextStreamId: number;
  streams: Map<number, Stream>;
  lastInboundAt: number;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  backlogBytes: number;
  backlogByUser: Map<string, number>;
  backlogReleased: boolean;
  pausedUploads: Set<WsStream>;
  invalidFrames: number;
  heartbeatPending: boolean;
}

interface StreamEnd {
  message: string;
  status: number;
  wsCode: number;
  tellTunnel: boolean;
  tunnelCode?: number;
  offline?: boolean;
}

interface StreamBase {
  id: number;
  entry: TunnelEntry;
  ownerUserId: string;
  grant: VisitorGrant;
  requestHeaders: HeaderPair[];
  bufferedBytes: number;
  done: boolean;
  ended: StreamEnd | null;
  detachSignal: () => void;
}

interface HttpStream extends StreamBase {
  kind: "http";
  resolve: ((response: Response) => void) | null;
  headTimer: ReturnType<typeof setTimeout> | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  queue: Uint8Array[];
  handedBytes: number;
  bodyEnded: boolean;
  bodyClosed: boolean;
  wantsData: boolean;
}

interface PendingWsMessage {
  data: Uint8Array;
  isBinary: boolean;
}

interface WsStream extends StreamBase {
  kind: "ws";
  settle: ((result: TunnelWsOpenResult) => void) | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  visitor: WebSocket | null;
  preBind: PendingWsMessage[];
  uploadPendingBytes: number;
  visitorPendingBytes: number;
}

type Stream = HttpStream | WsStream;

type Admission =
  | { kind: "admitted"; entry: TunnelEntry }
  | { kind: "refused"; response: Response };

interface LostTunnel {
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

function closeReason(reason: string): string {
  const encoder = new TextEncoder();
  let end = Math.min(reason.length, MAX_CLOSE_REASON_BYTES);

  while (
    end > 0 &&
    encoder.encode(reason.slice(0, end)).length > MAX_CLOSE_REASON_BYTES
  ) {
    end -= 1;
  }

  return reason.slice(0, end);
}

function safeCloseCode(code: number): number {
  return code === CLEAN_CLOSE_CODE || (code >= 3000 && code <= 4999)
    ? code
    : CLEAN_CLOSE_CODE;
}

function ownerKey(owner: TunnelOwner): string {
  return owner.kind === "server"
    ? `server:${owner.serverId}`
    : `machine:${owner.machineId}`;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);

  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState !== WebSocket.OPEN &&
    socket.readyState !== WebSocket.CONNECTING
  ) {
    return;
  }

  try {
    socket.close(code, closeReason(reason));
  } catch {
    socket.terminate();
  }
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export function createTunnelRegistry(
  options: TunnelRegistryOptions,
): TunnelRegistry {
  const { database, log, maxBufferedBytes } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  const streamLimit =
    options.streamBufferLimitBytes ?? STREAM_BUFFER_LIMIT_BYTES;

  const returnGraceMs = options.returnGraceMs ?? RETURN_GRACE_MS;
  const silenceLimitMs = options.silenceLimitMs ?? TUNNEL_SILENCE_LIMIT_MS;

  const tunnelBacklogLimit =
    options.tunnelBacklogLimitBytes ?? TUNNEL_BACKLOG_LIMIT_BYTES;

  const userBufferLimit =
    options.userBufferLimitBytes ?? USER_BUFFER_LIMIT_BYTES;

  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new Error("The tunnel buffer budget must be a positive byte count");
  }

  const entries = new Map<string, TunnelEntry>();
  const lost = new Map<string, LostTunnel>();
  let bufferedTotal = 0;
  let backlogTotal = 0;
  let sheddingOverBudget = false;
  const bufferedByUser = new Map<string, number>();
  const backlogByUser = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function addBuffered(stream: Stream, delta: number): void {
    stream.bufferedBytes += delta;
    bufferedTotal += delta;
    addUserBuffered(stream.ownerUserId, delta);
  }

  function addUserBuffered(userId: string, delta: number): void {
    addToUser(bufferedByUser, userId, delta);
  }

  function addToUser(
    counts: Map<string, number>,
    userId: string,
    delta: number,
  ): void {
    const next = (counts.get(userId) ?? 0) + delta;

    if (next > 0) counts.set(userId, next);
    else counts.delete(userId);
  }

  function ownerLoad(userId: string): number {
    return (bufferedByUser.get(userId) ?? 0) + (backlogByUser.get(userId) ?? 0);
  }

  function markPresence(owner: TunnelOwner): void {
    const at = new Date(now());

    try {
      if (owner.kind === "machine") {
        database.db
          .update(machine)
          .set({ lastSeenAt: at })
          .where(
            and(eq(machine.id, owner.machineId), isNull(machine.revokedAt)),
          )
          .run();
      } else {
        database.db
          .update(server)
          .set({ lastSeenAt: at })
          .where(eq(server.id, owner.serverId))
          .run();
      }
    } catch (error) {
      log.warn("tunnel.presence_failed", {
        ownerKind: owner.kind,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  function schedulePresence(entry: TunnelEntry): void {
    const delay =
      PRESENCE_INTERVAL_MIN_MS +
      Math.floor(random() * PRESENCE_INTERVAL_JITTER_MS);

    entry.presenceTimer = setTimeout(() => {
      if (entries.get(entry.routingKey) !== entry) return;
      markPresence(entry.owner);
      schedulePresence(entry);
    }, delay);
    unref(entry.presenceTimer);
  }

  function stopPresence(entry: TunnelEntry): void {
    if (entry.presenceTimer !== null) clearTimeout(entry.presenceTimer);
    entry.presenceTimer = null;
  }

  function ensureSweep(): void {
    if (sweepTimer !== null) return;
    sweepTimer = setInterval(
      sweepSilentTunnels,
      Math.min(SILENCE_SWEEP_INTERVAL_MS, silenceLimitMs),
    );
    unref(sweepTimer);
  }

  function stopSweepWhenIdle(): void {
    if (entries.size > 0 || sweepTimer === null) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function sweepSilentTunnels(): void {
    const at = now();

    for (const entry of entries.values()) {
      if (at - entry.lastInboundAt <= silenceLimitMs) continue;
      log.warn("tunnel.silent", {
        routingKey: entry.routingKey,
        silentMs: at - entry.lastInboundAt,
      });
      entry.socket.terminate();
    }
  }

  function wakeWaiters(routingKey: string): void {
    const record = lost.get(routingKey);

    if (record === undefined) return;
    lost.delete(routingKey);
    clearTimeout(record.timer);

    for (const waiter of [...record.waiters]) waiter();
  }

  function recordLoss(routingKey: string): void {
    wakeWaiters(routingKey);
    const timer = setTimeout(() => wakeWaiters(routingKey), returnGraceMs);
    unref(timer);
    lost.set(routingKey, { timer, waiters: new Set() });
  }

  function awaitReturn(
    routingKey: string,
    signal: AbortSignal,
  ): Promise<TunnelEntry | null> {
    const record = lost.get(routingKey);

    if (record === undefined || signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      const settle = () => {
        record.waiters.delete(settle);
        signal.removeEventListener("abort", settle);
        resolve(signal.aborted ? null : (entries.get(routingKey) ?? null));
      };

      record.waiters.add(settle);
      signal.addEventListener("abort", settle, { once: true });
    });
  }

  function sendHeartbeatResponse(entry: TunnelEntry): void {
    if (entry.socket.readyState !== WebSocket.OPEN) return;

    if (entry.socket.bufferedAmount > tunnelBacklogLimit) {
      dropStalledTunnel(entry, "tunnel");

      return;
    }

    if (entry.heartbeatPending) return;
    entry.heartbeatPending = true;
    entry.socket.send(HEARTBEAT_RESPONSE, () => {
      entry.heartbeatPending = false;
    });
  }

  function sendCounted(
    entry: TunnelEntry,
    userId: string,
    data: Uint8Array,
    onWritten?: (error?: Error) => void,
  ): boolean {
    if (entry.socket.readyState !== WebSocket.OPEN) return false;
    const bytes = data.byteLength;
    entry.backlogBytes += bytes;
    backlogTotal += bytes;
    addToUser(entry.backlogByUser, userId, bytes);
    addToUser(backlogByUser, userId, bytes);

    entry.socket.send(data, (error) => {
      if (!entry.backlogReleased) {
        entry.backlogBytes -= bytes;
        backlogTotal -= bytes;
        addToUser(entry.backlogByUser, userId, -bytes);
        addToUser(backlogByUser, userId, -bytes);
      }

      onWritten?.(error);
    });
    enforceBacklog(entry);

    return true;
  }

  function sendControl(stream: Stream, data: Uint8Array): boolean {
    return sendCounted(stream.entry, stream.ownerUserId, data);
  }

  function releaseBacklog(entry: TunnelEntry): void {
    if (entry.backlogReleased) return;
    entry.backlogReleased = true;
    backlogTotal -= entry.backlogBytes;
    entry.backlogBytes = 0;

    for (const [userId, bytes] of entry.backlogByUser) {
      addToUser(backlogByUser, userId, -bytes);
    }

    entry.backlogByUser.clear();
    entry.pausedUploads.clear();
  }

  function dropStalledTunnel(
    entry: TunnelEntry,
    cause: "tunnel" | "budget" | "share" | "retired",
  ) {
    log.warn("tunnel.write_backlog", {
      routingKey: entry.routingKey,
      cause,
      backlogBytes: entry.backlogBytes,
    });
    releaseBacklog(entry);
    entry.socket.terminate();
  }

  function enforceBacklog(entry: TunnelEntry): void {
    if (entry.backlogReleased) return;

    if (entry.backlogBytes > tunnelBacklogLimit) {
      dropStalledTunnel(entry, "tunnel");

      return;
    }

    if (bufferedTotal + backlogTotal <= maxBufferedBytes) return;
    let largest = entry;

    for (const candidate of entries.values()) {
      if (candidate.backlogBytes > largest.backlogBytes) largest = candidate;
    }

    if (largest.backlogBytes > streamLimit)
      dropStalledTunnel(largest, "budget");

    if (sheddingOverBudget) return;
    sheddingOverBudget = true;

    try {
      while (bufferedTotal + backlogTotal > maxBufferedBytes) {
        if (loadedOwnerCount() < 2) return;
        const heaviest = heaviestLoadedOwner();

        if (heaviest === null || !shedLoadOf(heaviest)) return;
      }
    } finally {
      sheddingOverBudget = false;
    }
  }

  function resumeUploads(entry: TunnelEntry): void {
    if (entry.backlogBytes > streamLimit / 2) return;

    for (const stream of [...entry.pausedUploads]) {
      if (stream.done) {
        entry.pausedUploads.delete(stream);
      } else if (stream.uploadPendingBytes <= streamLimit / 2) {
        entry.pausedUploads.delete(stream);
        stream.visitor?.resume();
      }
    }
  }

  function sendUpload(
    stream: Stream,
    data: Uint8Array,
    onWritten: (written: boolean) => void,
  ): boolean {
    return sendCounted(stream.entry, stream.ownerUserId, data, (error) =>
      onWritten(error === undefined || error === null),
    );
  }

  function sendAndWait(stream: Stream, data: Uint8Array): Promise<boolean> {
    return new Promise((resolve) => {
      if (!sendUpload(stream, data, resolve)) resolve(false);
    });
  }

  function release(stream: Stream): void {
    if (stream.done) return;
    stream.done = true;
    stream.entry.streams.delete(stream.id);
    const held = stream.kind === "ws" ? stream.visitorPendingBytes : 0;
    bufferedTotal -= stream.bufferedBytes - held;
    addUserBuffered(stream.ownerUserId, held - stream.bufferedBytes);
    stream.bufferedBytes = 0;
    stream.detachSignal();

    if (stream.kind === "http") {
      if (stream.headTimer !== null) clearTimeout(stream.headTimer);
      stream.headTimer = null;
      stream.queue = [];
    } else {
      if (stream.ackTimer !== null) clearTimeout(stream.ackTimer);
      stream.ackTimer = null;
      stream.preBind = [];
      stream.entry.pausedUploads.delete(stream);
    }
  }

  function endStream(stream: Stream, end: StreamEnd): void {
    if (stream.done) return;
    release(stream);
    stream.ended = end;

    if (end.tellTunnel) {
      sendControl(
        stream,
        encodeFrame({
          type: "close-stream",
          streamId: stream.id,
          code: end.tunnelCode ?? CLEAN_CLOSE_CODE,
          reason: closeReason(end.message),
        }),
      );
    }

    if (stream.kind === "http") {
      if (stream.resolve !== null) {
        const resolve = stream.resolve;
        stream.resolve = null;
        resolve(
          end.offline === true
            ? tunnelOfflineResponse(stream.requestHeaders)
            : relayTextResponse(end.message, end.status),
        );
      } else if (stream.controller !== null && !stream.bodyClosed) {
        stream.bodyClosed = true;

        try {
          stream.controller.error(new Error(end.message));
        } catch {}
      }

      return;
    }

    if (stream.settle !== null) {
      const settle = stream.settle;
      stream.settle = null;
      settle({
        kind: "refused",
        response:
          end.offline === true
            ? tunnelOfflineResponse(stream.requestHeaders)
            : relayTextResponse(end.message, end.status),
      });
    } else if (stream.visitor !== null) {
      closeSocket(stream.visitor, end.wsCode, end.message);
    }
  }

  function overflow(
    stream: Stream,
    cause: "stream" | "budget" | "user" | "share",
  ): void {
    log.warn("tunnel.stream_overflow", {
      routingKey: stream.entry.routingKey,
      kind: stream.kind,
      cause,
      bufferedBytes: stream.bufferedBytes,
    });
    const visitor = stream.kind === "ws" ? stream.visitor : null;
    endStream(stream, {
      message: STREAM_OVERFLOW_MESSAGE,
      status: 502,
      wsCode: STREAM_OVERFLOW_CLOSE_CODE,
      tellTunnel: true,
      tunnelCode:
        stream.kind === "ws" ? STREAM_OVERFLOW_CLOSE_CODE : CLEAN_CLOSE_CODE,
    });

    if (visitor !== null) {
      const timer = setTimeout(
        () => visitor.terminate(),
        OVERFLOW_TERMINATE_AFTER_MS,
      );

      unref(timer);
      visitor.once("close", () => clearTimeout(timer));
    }
  }

  function allStreams(): Stream[] {
    const streams: Stream[] = [];

    for (const entry of entries.values())
      streams.push(...entry.streams.values());

    return streams;
  }

  function enforceLimits(stream: Stream): void {
    if (!stream.done && stream.bufferedBytes > streamLimit) {
      overflow(stream, "stream");
    }

    if ((bufferedByUser.get(stream.ownerUserId) ?? 0) > userBufferLimit) {
      const ownLargestFirst = allStreams()
        .filter((candidate) => candidate.ownerUserId === stream.ownerUserId)
        .sort((a, b) => b.bufferedBytes - a.bufferedBytes);

      for (const candidate of ownLargestFirst) {
        if (
          (bufferedByUser.get(stream.ownerUserId) ?? 0) <= userBufferLimit ||
          candidate.bufferedBytes === 0
        ) {
          break;
        }

        overflow(candidate, "user");
      }
    }

    if (bufferedTotal <= maxBufferedBytes) return;
    log.warn("tunnel.buffer_budget_exceeded", {
      bufferedBytes: bufferedTotal,
      budgetBytes: maxBufferedBytes,
    });

    while (bufferedTotal > maxBufferedBytes) {
      const candidate = heaviestOwnersLargestStream();

      if (candidate === null) break;
      overflow(candidate, "budget");
    }
  }

  function heaviestOwnersLargestStream(): Stream | null {
    let heaviestUserId: string | null = null;
    let heaviestBytes = 0;

    for (const [userId, bytes] of bufferedByUser) {
      if (bytes > heaviestBytes) {
        heaviestUserId = userId;
        heaviestBytes = bytes;
      }
    }

    return heaviestUserId === null ? null : largestStreamOf(heaviestUserId);
  }

  function largestStreamOf(userId: string): Stream | null {
    let largest: Stream | null = null;

    for (const candidate of allStreams()) {
      if (
        candidate.ownerUserId === userId &&
        candidate.bufferedBytes > (largest?.bufferedBytes ?? 0)
      ) {
        largest = candidate;
      }
    }

    return largest;
  }

  function largestBacklogTunnelOf(userId: string): TunnelEntry | null {
    let largest: TunnelEntry | null = null;
    let largestBytes = 0;

    for (const candidate of entries.values()) {
      const bytes = candidate.backlogByUser.get(userId) ?? 0;

      if (bytes > largestBytes) {
        largest = candidate;
        largestBytes = bytes;
      }
    }

    return largest;
  }

  function loadedOwnerCount(): number {
    return new Set([...bufferedByUser.keys(), ...backlogByUser.keys()]).size;
  }

  function heaviestLoadedOwner(): string | null {
    let heaviestUserId: string | null = null;
    let heaviestBytes = 0;

    for (const userId of new Set([
      ...bufferedByUser.keys(),
      ...backlogByUser.keys(),
    ])) {
      const bytes = ownerLoad(userId);

      if (bytes > heaviestBytes) {
        heaviestUserId = userId;
        heaviestBytes = bytes;
      }
    }

    return heaviestUserId;
  }

  function shedLoadOf(userId: string): boolean {
    if ((backlogByUser.get(userId) ?? 0) > (bufferedByUser.get(userId) ?? 0)) {
      const tunnel = largestBacklogTunnelOf(userId);

      if (tunnel !== null) {
        dropStalledTunnel(tunnel, "share");

        return true;
      }
    }

    const stream = largestStreamOf(userId);

    if (stream === null) return false;
    overflow(stream, "share");

    return true;
  }

  function makeRoomFor(userId: string): boolean {
    const loaded = new Set([...bufferedByUser.keys(), ...backlogByUser.keys()]);
    const owners = loaded.size + (loaded.has(userId) ? 0 : 1);
    const fairShare = maxBufferedBytes / owners;

    if (ownerLoad(userId) >= fairShare) return false;

    while (bufferedTotal + backlogTotal >= maxBufferedBytes) {
      const heaviest = heaviestLoadedOwner();

      if (
        heaviest === null ||
        ownerLoad(heaviest) <= fairShare ||
        !shedLoadOf(heaviest)
      ) {
        return false;
      }
    }

    return true;
  }

  function abandonStreams(
    entry: TunnelEntry,
    message: string,
    wsCode: number,
    offline: boolean,
  ): void {
    for (const stream of [...entry.streams.values()]) {
      endStream(stream, {
        message,
        status: 502,
        wsCode,
        tellTunnel: false,
        offline,
      });
    }
  }

  function allocateStreamId(entry: TunnelEntry): number {
    for (;;) {
      const id = entry.nextStreamId;
      entry.nextStreamId = id >= MAX_STREAM_ID ? 1 : id + 1;

      if (!entry.streams.has(id)) return id;
    }
  }

  function makeHandle(stream: Stream): VisitorStreamHandle {
    return {
      routingKey: stream.entry.routingKey,
      grant: stream.grant,
      close: (reason) =>
        endStream(stream, {
          message: reason,
          status: 403,
          wsCode: POLICY_CLOSE_CODE,
          tellTunnel: true,
        }),
    };
  }

  function bindSignal(stream: Stream, signal: AbortSignal): void {
    const onAbort = () =>
      endStream(stream, {
        message: "visitor canceled the request",
        status: VISITOR_CANCELED_STATUS,
        wsCode: GOING_AWAY_CLOSE_CODE,
        tellTunnel: true,
      });

    signal.addEventListener("abort", onAbort, { once: true });
    stream.detachSignal = () => signal.removeEventListener("abort", onAbort);
  }

  async function admit(
    request: TunnelHttpRequest | TunnelWsRequest,
  ): Promise<Admission> {
    const entry =
      entries.get(request.routingKey) ??
      (await awaitReturn(request.routingKey, request.signal));

    if (request.signal.aborted) {
      return {
        kind: "refused",
        response: relayTextResponse(
          "visitor canceled the request",
          VISITOR_CANCELED_STATUS,
        ),
      };
    }

    if (
      entry === null ||
      (request.expectedOwner !== null &&
        ownerKey(request.expectedOwner) !== ownerKey(entry.owner))
    ) {
      return {
        kind: "refused",
        response: tunnelOfflineResponse(request.headers),
      };
    }

    if (request.target !== null && entry.protocolVersion < 1) {
      return {
        kind: "refused",
        response: relayTextResponse(PORT_SHARE_TOO_OLD, 502),
      };
    }

    if (entry.streams.size >= MAX_STREAMS_PER_TUNNEL) {
      return {
        kind: "refused",
        response: relayTextResponse(
          "too many open requests to this server",
          503,
        ),
      };
    }

    if ((bufferedByUser.get(request.ownerUserId) ?? 0) >= userBufferLimit) {
      return {
        kind: "refused",
        response: relayTextResponse(
          "this address has too many unread responses; try again shortly",
          503,
        ),
      };
    }

    if (
      bufferedTotal + backlogTotal >= maxBufferedBytes &&
      !makeRoomFor(request.ownerUserId)
    ) {
      return {
        kind: "refused",
        response: relayTextResponse(
          "the relay is busy; try again shortly",
          503,
        ),
      };
    }

    return { kind: "admitted", entry };
  }

  function deliverChunk(stream: HttpStream, data: Uint8Array): void {
    if (stream.controller === null || stream.bodyClosed) return;
    addBuffered(stream, data.byteLength);

    if (stream.wantsData && stream.queue.length === 0) {
      stream.wantsData = false;
      stream.handedBytes = data.byteLength;
      stream.controller.enqueue(data);
    } else {
      stream.queue.push(data);
    }

    enforceLimits(stream);
  }

  function closeBodyIfDrained(stream: HttpStream): void {
    if (
      !stream.bodyEnded ||
      stream.queue.length > 0 ||
      stream.handedBytes > 0 ||
      stream.bodyClosed
    ) {
      return;
    }

    stream.bodyClosed = true;
    release(stream);

    try {
      stream.controller?.close();
    } catch {}
  }

  function pullBody(stream: HttpStream): void {
    if (stream.done) return;
    addBuffered(stream, -stream.handedBytes);
    stream.handedBytes = 0;
    const next = stream.queue.shift();

    if (next !== undefined) {
      stream.handedBytes = next.byteLength;
      stream.controller?.enqueue(next);
      closeBodyIfDrained(stream);

      return;
    }

    if (stream.bodyEnded) {
      closeBodyIfDrained(stream);

      return;
    }

    stream.wantsData = true;
  }

  function onResponseHead(
    stream: HttpStream,
    status: number,
    headers: HeaderPair[],
  ): void {
    if (stream.resolve === null) return;

    if (stream.headTimer !== null) clearTimeout(stream.headTimer);
    stream.headTimer = null;
    const resolve = stream.resolve;
    const relayed = withoutHopHeaders(headers);
    const nullBody = NULL_BODY_STATUSES.has(status);
    let response: Response;

    try {
      response = new Response(
        nullBody
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start: (controller) => {
                  stream.controller = controller;
                },
                pull: () => pullBody(stream),
                cancel: () =>
                  endStream(stream, {
                    message: "visitor canceled response body",
                    status: 502,
                    wsCode: GOING_AWAY_CLOSE_CODE,
                    tellTunnel: true,
                  }),
              },
              { highWaterMark: 0 },
            ),
        { status, headers: relayed },
      );
    } catch {
      endStream(stream, {
        message: `unrelayable origin response (status ${status})`,
        status: 502,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: true,
      });

      return;
    }

    stream.resolve = null;

    if (nullBody) release(stream);
    resolve(response);
  }

  function sendToVisitor(stream: WsStream, message: PendingWsMessage): void {
    const visitor = stream.visitor;

    if (visitor === null || visitor.readyState !== WebSocket.OPEN) return;
    const bytes = message.data.byteLength;

    if (stream.bufferedBytes + bytes > streamLimit) {
      overflow(stream, "stream");

      return;
    }

    addBuffered(stream, bytes);
    stream.visitorPendingBytes += bytes;
    visitor.send(message.data, { binary: message.isBinary }, () =>
      settleVisitorBytes(stream, bytes),
    );
    enforceLimits(stream);
  }

  function settleVisitorBytes(stream: WsStream, bytes: number): void {
    const settled = Math.min(bytes, stream.visitorPendingBytes);

    if (settled <= 0) return;
    stream.visitorPendingBytes -= settled;

    if (stream.done) {
      bufferedTotal -= settled;
      addUserBuffered(stream.ownerUserId, -settled);
    } else {
      addBuffered(stream, -settled);
    }
  }

  function onTunnelFrame(entry: TunnelEntry, frame: Frame): void {
    const stream = entry.streams.get(frame.streamId);

    if (stream === undefined) return;

    switch (frame.type) {
      case "resp-head":
        if (stream.kind === "http") {
          onResponseHead(stream, frame.status, frame.headers);
        }

        return;
      case "body-chunk":
        if (stream.kind === "http") deliverChunk(stream, frame.data);

        return;
      case "body-end":
        if (stream.kind === "http" && stream.controller !== null) {
          stream.bodyEnded = true;
          closeBodyIfDrained(stream);
        }

        return;
      case "close-stream":
        if (stream.kind === "http") {
          endStream(stream, {
            message: `tunnel client aborted: ${frame.reason}`,
            status: 502,
            wsCode: INTERNAL_ERROR_CLOSE_CODE,
            tellTunnel: false,
          });
        } else if (stream.settle !== null) {
          endStream(stream, {
            message: `the origin refused the WebSocket: ${frame.reason}`,
            status: 502,
            wsCode: INTERNAL_ERROR_CLOSE_CODE,
            tellTunnel: false,
          });
        } else {
          const visitor = stream.visitor;
          release(stream);

          if (visitor !== null) {
            closeSocket(visitor, safeCloseCode(frame.code), frame.reason);
          } else {
            stream.ended = {
              message: frame.reason,
              status: 502,
              wsCode: safeCloseCode(frame.code),
              tellTunnel: false,
            };
          }
        }

        return;
      case "ws-open-ack":
        if (stream.kind === "ws" && stream.settle !== null) {
          if (stream.ackTimer !== null) clearTimeout(stream.ackTimer);
          stream.ackTimer = null;
          const settle = stream.settle;
          stream.settle = null;
          settle(acceptedWs(stream, frame.protocol));
        }

        return;
      case "ws-data":
        if (stream.kind !== "ws") return;

        if (stream.visitor === null) {
          stream.preBind.push({ data: frame.data, isBinary: frame.isBinary });
          addBuffered(stream, frame.data.byteLength);
          enforceLimits(stream);
        } else {
          sendToVisitor(stream, { data: frame.data, isBinary: frame.isBinary });
        }

        return;
      case "open-http":
      case "open-ws":
        return;
    }
  }

  function forwardVisitorMessage(
    stream: WsStream,
    visitor: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (stream.done) return;

    const frame = encodeFrame({
      type: "ws-data",
      streamId: stream.id,
      isBinary,
      data: toBytes(data),
    });

    const bytes = frame.byteLength;
    const entry = stream.entry;
    stream.uploadPendingBytes += bytes;

    const sent = sendUpload(stream, frame, () => {
      stream.uploadPendingBytes -= bytes;
      resumeUploads(entry);
    });

    if (!sent) {
      endStream(stream, {
        message: "tunnel disconnected",
        status: 502,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: false,
      });

      return;
    }

    if (
      !stream.done &&
      !entry.backlogReleased &&
      (stream.uploadPendingBytes > streamLimit ||
        entry.backlogBytes > streamLimit)
    ) {
      entry.pausedUploads.add(stream);

      if (!visitor.isPaused) visitor.pause();
    }
  }

  function bindVisitor(stream: WsStream, visitor: WebSocket): void {
    visitor.on("error", () => {
      log.warn("tunnel.visitor_ws_error", {
        routingKey: stream.entry.routingKey,
      });
    });

    if (stream.done) {
      const end = stream.ended;
      closeSocket(
        visitor,
        end?.wsCode ?? GOING_AWAY_CLOSE_CODE,
        end?.message ?? "tunnel disconnected",
      );

      return;
    }

    stream.visitor = visitor;
    let pongPending = false;
    visitor.on("ping", (data) => {
      if (pongPending || visitor.readyState !== WebSocket.OPEN) return;
      pongPending = true;
      visitor.pong(data, false, () => {
        pongPending = false;
      });
    });
    visitor.on("message", (data, isBinary) =>
      forwardVisitorMessage(stream, visitor, data, isBinary),
    );
    visitor.on("close", (code, reason) => {
      const done = stream.done;
      release(stream);
      settleVisitorBytes(stream, stream.visitorPendingBytes);

      if (done) return;
      sendControl(
        stream,
        encodeFrame({
          type: "close-stream",
          streamId: stream.id,
          code: safeCloseCode(code),
          reason: closeReason(reason.toString()),
        }),
      );
    });

    const pending = stream.preBind;
    stream.preBind = [];

    for (const message of pending) {
      if (stream.done) return;
      addBuffered(stream, -message.data.byteLength);
      sendToVisitor(stream, message);
    }
  }

  function acceptedWs(
    stream: WsStream,
    protocol: string | null,
  ): TunnelWsOpenResult {
    let bound = false;

    return {
      kind: "accepted",
      protocol,
      bind: (visitor) => {
        if (bound) throw new Error("A tunnel WebSocket stream binds once");
        bound = true;
        bindVisitor(stream, visitor);
      },
      cancel: (reason) =>
        endStream(stream, {
          message: reason,
          status: 502,
          wsCode: INTERNAL_ERROR_CLOSE_CODE,
          tellTunnel: true,
        }),
    };
  }

  async function pumpRequestBody(
    stream: HttpStream,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    try {
      const reader = body.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        for (
          let offset = 0;
          offset < value.byteLength;
          offset += MAX_CHUNK_BYTES
        ) {
          if (stream.done) {
            await reader.cancel();

            return;
          }

          const written = await sendAndWait(
            stream,
            encodeFrame({
              type: "body-chunk",
              streamId: stream.id,
              data: value.subarray(offset, offset + MAX_CHUNK_BYTES),
            }),
          );

          if (!written) {
            await reader.cancel();

            return;
          }
        }
      }

      if (!stream.done) {
        sendControl(
          stream,
          encodeFrame({ type: "body-end", streamId: stream.id }),
        );
      }
    } catch (error) {
      log.warn("tunnel.request_body_failed", {
        routingKey: stream.entry.routingKey,
        error: error instanceof Error ? error.name : "unknown",
      });
      endStream(stream, {
        message: "request body error",
        status: 502,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: true,
        tunnelCode: INTERNAL_ERROR_CLOSE_CODE,
      });
    }
  }

  function noSignal(): void {}

  function encodeOpenFrame(frame: Frame): Uint8Array | null {
    try {
      return encodeFrame(frame);
    } catch (error) {
      if (error instanceof ControlFrameTooLargeError) return null;
      throw error;
    }
  }

  function headersTooLargeResponse(): Response {
    return relayTextResponse(
      REQUEST_HEADERS_TOO_LARGE_MESSAGE,
      REQUEST_HEADERS_TOO_LARGE_STATUS,
    );
  }

  async function openHttpStream(request: TunnelHttpRequest): Promise<Response> {
    const admission = await admit(request);

    if (admission.kind === "refused") return admission.response;
    const { entry } = admission;
    const headers = withoutHopHeaders(request.headers);

    const headTimeoutMs = responseHeadTimeoutMs(
      request.method,
      request.path,
      request.target,
    );

    const id = allocateStreamId(entry);

    const openFrame = encodeOpenFrame({
      type: "open-http",
      streamId: id,
      method: request.method,
      path: request.path,
      headers,
      hasBody: request.body !== null,
      ...(request.target !== null ? { target: request.target } : {}),
    });

    if (openFrame === null) return headersTooLargeResponse();

    const stream: HttpStream = {
      kind: "http",
      id,
      entry,
      ownerUserId: request.ownerUserId,
      grant: request.grant,
      requestHeaders: headers,
      bufferedBytes: 0,
      done: false,
      ended: null,
      detachSignal: noSignal,
      resolve: null,
      headTimer: null,
      controller: null,
      queue: [],
      handedBytes: 0,
      bodyEnded: false,
      bodyClosed: false,
      wantsData: false,
    };

    const response = new Promise<Response>((resolve) => {
      stream.resolve = resolve;
    });

    entry.streams.set(stream.id, stream);
    stream.headTimer = setTimeout(
      () =>
        endStream(stream, {
          message: "timed out waiting for the tunnel client",
          status: 504,
          wsCode: INTERNAL_ERROR_CLOSE_CODE,
          tellTunnel: true,
        }),
      headTimeoutMs,
    );
    bindSignal(stream, request.signal);

    const opened = sendControl(stream, openFrame);

    if (!opened) {
      endStream(stream, {
        message: "tunnel disconnected",
        status: 503,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: false,
        offline: true,
      });
    } else if (request.body !== null) {
      void pumpRequestBody(stream, request.body);
    }

    return response;
  }

  async function openWsStream(
    request: TunnelWsRequest,
  ): Promise<TunnelWsOpenResult> {
    const admission = await admit(request);

    if (admission.kind === "refused") return admission;
    const { entry } = admission;
    const headers = withoutHopHeaders(request.headers);

    const id = allocateStreamId(entry);

    const openFrame = encodeOpenFrame({
      type: "open-ws",
      streamId: id,
      path: request.path,
      headers,
      protocols: request.protocols,
      ...(request.target !== null ? { target: request.target } : {}),
    });

    if (openFrame === null) {
      return { kind: "refused", response: headersTooLargeResponse() };
    }

    const stream: WsStream = {
      kind: "ws",
      id,
      entry,
      ownerUserId: request.ownerUserId,
      grant: request.grant,
      requestHeaders: headers,
      bufferedBytes: 0,
      done: false,
      ended: null,
      detachSignal: noSignal,
      settle: null,
      ackTimer: null,
      visitor: null,
      preBind: [],
      uploadPendingBytes: 0,
      visitorPendingBytes: 0,
    };

    const result = new Promise<TunnelWsOpenResult>((resolve) => {
      stream.settle = resolve;
    });

    entry.streams.set(stream.id, stream);
    stream.ackTimer = setTimeout(
      () =>
        endStream(stream, {
          message: "timed out waiting for the tunnel client",
          status: 504,
          wsCode: INTERNAL_ERROR_CLOSE_CODE,
          tellTunnel: true,
        }),
      RESP_HEAD_TIMEOUT_MS,
    );
    bindSignal(stream, request.signal);

    const opened = sendControl(stream, openFrame);

    if (!opened) {
      endStream(stream, {
        message: "tunnel disconnected",
        status: 503,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: false,
        offline: true,
      });
    }

    return result;
  }

  function onTunnelClosed(entry: TunnelEntry, code: number): void {
    if (entries.get(entry.routingKey) !== entry) return;
    entries.delete(entry.routingKey);
    stopPresence(entry);
    markPresence(entry.owner);
    const clean = entry.closing || code === CLEAN_CLOSE_CODE;
    abandonStreams(
      entry,
      "tunnel disconnected mid-request",
      GOING_AWAY_CLOSE_CODE,
      false,
    );

    if (!clean) recordLoss(entry.routingKey);
    log.info("tunnel.closed", {
      routingKey: entry.routingKey,
      ownerKind: entry.owner.kind,
      code,
      clean,
    });
    stopSweepWhenIdle();
  }

  function rejectFrame(entry: TunnelEntry, error: InvalidFrameError): void {
    const stream =
      error.streamId === null ? undefined : entry.streams.get(error.streamId);

    entry.invalidFrames += 1;

    log.warn("tunnel.bad_frame", {
      routingKey: entry.routingKey,
      stream: stream !== undefined,
    });

    if (stream !== undefined) {
      endStream(stream, {
        message: INVALID_FRAME_MESSAGE,
        status: 502,
        wsCode: INTERNAL_ERROR_CLOSE_CODE,
        tellTunnel: true,
        tunnelCode: INTERNAL_ERROR_CLOSE_CODE,
      });
    }

    if (entry.invalidFrames >= MAX_INVALID_FRAMES_PER_TUNNEL) {
      log.warn("tunnel.bad_frame_limit", { routingKey: entry.routingKey });
      releaseBacklog(entry);
      entry.socket.terminate();
    }
  }

  function failTunnel(entry: TunnelEntry, error: unknown): void {
    log.error("tunnel.frame_failed", {
      routingKey: entry.routingKey,
      error: error instanceof Error ? error.name : "unknown",
    });
    releaseBacklog(entry);
    entry.socket.terminate();
    onTunnelClosed(entry, ABNORMAL_CLOSE_CODE);
  }

  function detach(entry: TunnelEntry): void {
    entry.closing = true;
    entries.delete(entry.routingKey);
    stopPresence(entry);
  }

  function retireSocket(
    entry: TunnelEntry,
    code: number,
    reason: string,
  ): void {
    if (entry.backlogBytes > GRACEFUL_RETIRE_BACKLOG_BYTES) {
      dropStalledTunnel(entry, "retired");

      return;
    }

    releaseBacklog(entry);
    closeSocket(entry.socket, code, reason);
  }

  function attach(attachment: TunnelAttachment): void {
    const { routingKey, owner, protocolVersion, socket } = attachment;

    if (!Number.isInteger(protocolVersion) || protocolVersion < 0) {
      throw new Error("A tunnel protocol version is a non-negative integer");
    }

    if (socket.readyState !== WebSocket.OPEN) {
      log.warn("tunnel.attach_not_open", { routingKey });

      return;
    }

    const existing = entries.get(routingKey);

    if (existing !== undefined) {
      detach(existing);
      abandonStreams(
        existing,
        "tunnel reconnected mid-request",
        GOING_AWAY_CLOSE_CODE,
        false,
      );
      retireSocket(existing, CLEAN_CLOSE_CODE, TUNNEL_REPLACED_CLOSE_REASON);
      log.info("tunnel.replaced", { routingKey });
    }

    const entry: TunnelEntry = {
      routingKey,
      owner,
      protocolVersion,
      socket,
      nextStreamId: 1,
      streams: new Map(),
      lastInboundAt: now(),
      presenceTimer: null,
      closing: false,
      backlogBytes: 0,
      backlogByUser: new Map(),
      backlogReleased: false,
      pausedUploads: new Set(),
      invalidFrames: 0,
      heartbeatPending: false,
    };

    entries.set(routingKey, entry);

    socket.on("message", (data, isBinary) => {
      entry.lastInboundAt = now();

      if (entries.get(routingKey) !== entry) return;

      if (!isBinary) {
        if (toBytes(data).toString() === HEARTBEAT_REQUEST) {
          sendHeartbeatResponse(entry);
        }

        return;
      }

      let frame: Frame;

      try {
        frame = decodeFrame(toBytes(data));
      } catch (error) {
        if (error instanceof InvalidFrameError) rejectFrame(entry, error);
        else failTunnel(entry, error);

        return;
      }

      try {
        onTunnelFrame(entry, frame);
      } catch (error) {
        failTunnel(entry, error);
      }
    });
    socket.on("pong", () => {
      entry.lastInboundAt = now();
    });
    socket.on("error", () => {
      log.warn("tunnel.socket_error", { routingKey });
    });
    socket.on("close", (code) => {
      releaseBacklog(entry);
      onTunnelClosed(entry, code);
    });

    markPresence(owner);
    schedulePresence(entry);
    ensureSweep();
    wakeWaiters(routingKey);
    log.info("tunnel.attached", {
      routingKey,
      ownerKind: owner.kind,
      protocolVersion,
    });
  }

  function close(routingKey: string, reason: string): void {
    const entry = entries.get(routingKey);

    if (entry !== undefined) {
      detach(entry);
      abandonStreams(
        entry,
        "tunnel closed by the relay",
        GOING_AWAY_CLOSE_CODE,
        false,
      );
      retireSocket(entry, CLEAN_CLOSE_CODE, reason);
      markPresence(entry.owner);
      log.info("tunnel.closed_by_relay", { routingKey });
    }

    wakeWaiters(routingKey);
    stopSweepWhenIdle();
  }

  function closeAll(code: number, reason: string): void {
    for (const entry of [...entries.values()]) {
      detach(entry);
      abandonStreams(entry, reason, code, true);
      retireSocket(entry, code, reason);
    }

    for (const routingKey of [...lost.keys()]) wakeWaiters(routingKey);
    stopSweepWhenIdle();
  }

  return {
    attach,
    has: (routingKey) => entries.has(routingKey),
    openHttpStream,
    openWsStream,
    close,
    visitorStreams: () => allStreams().map(makeHandle),
    closeAll,
    stats: () => ({
      tunnels: entries.size,
      visitorStreams: allStreams().length,
      bufferedBytes: bufferedTotal,
      tunnelBacklogBytes: backlogTotal,
    }),
  };
}
