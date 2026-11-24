import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { clientAddressKey, clientSiteKey } from "./client-ip.js";

export interface ConnectionBounds {
  tlsHandshakeTimeoutMs: number;
  requestHeadersTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
  maxConnectionsPerClient: number;
}

export const DEFAULT_CONNECTION_BOUNDS: Readonly<ConnectionBounds> = {
  tlsHandshakeTimeoutMs: 10_000,
  requestHeadersTimeoutMs: 30_000,
  requestTimeoutMs: 300_000,
  idleTimeoutMs: 120_000,
  maxConnections: 2_048,
  maxConnectionsPerClient: 128,
};

interface HeaderDeadline {
  timer: NodeJS.Timeout | null;
  inFlight: number;
  upgraded: boolean;
}

export interface ConnectionActivity {
  idle(socket: Duplex): boolean;
}

export function boundHttpConnections(
  server: HttpServer,
  bounds: Pick<
    ConnectionBounds,
    "requestHeadersTimeoutMs" | "requestTimeoutMs" | "idleTimeoutMs"
  >,
): ConnectionActivity {
  server.timeout = bounds.idleTimeoutMs;
  const deadlines = new WeakMap<Duplex, HeaderDeadline>();

  server.on("timeout", (socket: Socket) => {
    const deadline = deadlines.get(socket);

    if (
      deadline !== undefined &&
      !deadline.upgraded &&
      deadline.inFlight > 0 &&
      !socket.writableNeedDrain &&
      socket.writableLength === 0
    )
      return;

    socket.destroy();
  });

  function arm(socket: Duplex, deadline: HeaderDeadline): void {
    deadline.timer = setTimeout(
      () => socket.destroy(),
      bounds.requestHeadersTimeoutMs,
    );
    deadline.timer.unref();
  }

  function disarm(deadline: HeaderDeadline): void {
    if (deadline.timer !== null) clearTimeout(deadline.timer);
    deadline.timer = null;
  }

  server.on("connection", (socket: Socket) => {
    const deadline: HeaderDeadline = {
      timer: null,
      inFlight: 0,
      upgraded: false,
    };

    deadlines.set(socket, deadline);
    arm(socket, deadline);
    socket.once("close", () => disarm(deadline));
  });

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    const deadline = deadlines.get(socket);

    if (deadline === undefined) return;
    disarm(deadline);
    deadline.inFlight += 1;

    const requestTimer = setTimeout(() => {
      if (!request.complete) socket.destroy();
    }, bounds.requestTimeoutMs);

    requestTimer.unref();
    const clearRequestTimer = () => clearTimeout(requestTimer);
    request.once("end", clearRequestTimer);
    response.once("close", clearRequestTimer);
    response.once("close", () => {
      deadline.inFlight -= 1;

      if (deadline.inFlight === 0 && !deadline.upgraded && !socket.destroyed)
        arm(socket, deadline);
    });
  });

  server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
    const deadline = deadlines.get(socket);

    if (deadline === undefined) return;
    deadline.upgraded = true;
    disarm(deadline);
  });

  return {
    idle(socket) {
      const deadline = deadlines.get(socket);

      return (
        deadline === undefined ||
        (deadline.inFlight === 0 && !deadline.upgraded)
      );
    },
  };
}

export function boundTlsHandshake(socket: TLSSocket, timeoutMs: number): void {
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  timer.unref();
  const clear = () => clearTimeout(timer);
  socket.once("secure", clear);
  socket.once("close", clear);
}

export type ConnectionAdmission =
  | "admitted"
  | "client-limit"
  | "connection-limit";

export interface ClientConnectionLimit {
  admit(
    socket: Socket,
    clientAddress: string,
    idle?: () => boolean,
  ): ConnectionAdmission;
}

const SITE_CONNECTION_FACTOR = 8;

interface TrackedConnection {
  socket: Socket;
  idle: () => boolean;
  release(): void;
}

export function createClientConnectionLimit(
  maxPerClient: number,
  maxTotal = Number.POSITIVE_INFINITY,
): ClientConnectionLimit {
  const open = new Map<string, number>();
  const openSites = new Map<string, number>();
  const groups = new Map<string, Set<TrackedConnection>>();
  let total = 0;

  function release(counts: Map<string, number>, key: string): void {
    const remaining = (counts.get(key) ?? 1) - 1;

    if (remaining === 0) counts.delete(key);
    else counts.set(key, remaining);
  }

  function heaviestGroup(): Set<TrackedConnection> | undefined {
    let heaviest: Set<TrackedConnection> | undefined;

    for (const members of groups.values()) {
      if (heaviest === undefined || members.size > heaviest.size) {
        heaviest = members;
      }
    }

    return heaviest;
  }

  function evictFor(groupKey: string): boolean {
    const heaviest = heaviestGroup();
    const own = groups.get(groupKey)?.size ?? 0;

    if (heaviest === undefined || heaviest.size <= own + 1) return false;
    let victim: TrackedConnection | undefined;

    for (const connection of heaviest) {
      if (connection.idle()) {
        victim = connection;
        break;
      }
    }

    victim ??= heaviest.values().next().value;

    if (victim === undefined) return false;
    victim.release();
    victim.socket.destroy();

    return true;
  }

  return {
    admit(socket, clientAddress, idle = () => true) {
      const key = clientAddressKey(clientAddress);
      const siteKey = clientSiteKey(clientAddress);

      if ((open.get(key) ?? 0) >= maxPerClient) return "client-limit";

      if (
        siteKey !== null &&
        (openSites.get(siteKey) ?? 0) >= maxPerClient * SITE_CONNECTION_FACTOR
      ) {
        return "client-limit";
      }

      const groupKey = siteKey ?? key;

      if (total >= maxTotal && !evictFor(groupKey)) return "connection-limit";
      total += 1;
      open.set(key, (open.get(key) ?? 0) + 1);

      if (siteKey !== null) {
        openSites.set(siteKey, (openSites.get(siteKey) ?? 0) + 1);
      }

      const members = groups.get(groupKey) ?? new Set<TrackedConnection>();
      groups.set(groupKey, members);
      let released = false;

      const connection: TrackedConnection = {
        socket,
        idle,
        release() {
          if (released) return;
          released = true;
          total -= 1;
          release(open, key);

          if (siteKey !== null) release(openSites, siteKey);
          members.delete(connection);

          if (members.size === 0 && groups.get(groupKey) === members) {
            groups.delete(groupKey);
          }
        },
      };

      members.add(connection);
      socket.once("close", () => connection.release());

      return "admitted";
    },
  };
}

export function throttledCount(input: {
  now: () => number;
  intervalMs: number;
  report(count: number): void;
}): () => void {
  let pending = 0;
  let reportedAt = Number.NEGATIVE_INFINITY;

  return () => {
    pending += 1;
    const at = input.now();

    if (at - reportedAt < input.intervalMs) return;
    reportedAt = at;
    input.report(pending);
    pending = 0;
  };
}
