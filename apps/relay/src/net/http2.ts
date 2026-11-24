import {
  type Http2ServerRequest,
  type Http2Session,
  type ServerHttp2Session,
  type ServerHttp2Stream,
  constants,
  createServer,
} from "node:http2";
import type { TLSSocket } from "node:tls";
import type { ConnectionBounds } from "./connection-bounds.js";
import { RelayHttp2ServerResponse, writeBadRequest } from "./edge-responses.js";
import { type ProxiedAddress, bindProxiedClient } from "./proxy-protocol.js";

export const EDGE_ALPN_PROTOCOLS: readonly string[] = ["h2", "http/1.1"];

export const HTTP2_MAX_CONCURRENT_STREAMS = 100;

export interface Http2Edge {
  attach(socket: TLSSocket, client: ProxiedAddress): void;
  idle(socket: TLSSocket): boolean;
  close(): void;
}

interface SessionState {
  client: ProxiedAddress;
  streams: Set<ServerHttp2Stream>;
  headerTimer: NodeJS.Timeout | null;
}

function mapAuthorityToHost(incoming: Http2ServerRequest): boolean {
  const authority: string | undefined = incoming.authority;
  const host = incoming.headers.host;

  if (authority === undefined || authority === "") return false;

  if (host !== undefined) return host.toLowerCase() === authority.toLowerCase();
  incoming.headers.host = authority;
  incoming.rawHeaders.push("host", authority);

  return true;
}

function markHandshakeComplete(socket: TLSSocket): void {
  Object.assign(socket, { secureConnecting: false });
}

function hasUnsentResponse(stream: ServerHttp2Stream): boolean {
  return stream.writableNeedDrain || stream.writableLength > 0;
}

export function createHttp2Edge(input: {
  request(
    incoming: Http2ServerRequest,
    outgoing: RelayHttp2ServerResponse,
  ): void;
  bounds: Pick<
    ConnectionBounds,
    "requestHeadersTimeoutMs" | "requestTimeoutMs" | "idleTimeoutMs"
  >;
}): Http2Edge {
  const { bounds } = input;
  const sessions = new Map<Http2Session, SessionState>();
  const bySocket = new WeakMap<TLSSocket, SessionState>();

  const server = createServer(
    {
      Http2ServerResponse: RelayHttp2ServerResponse,
      settings: {
        maxConcurrentStreams: HTTP2_MAX_CONCURRENT_STREAMS,
        enableConnectProtocol: false,
      },
    },
    (incoming, outgoing) => {
      const session = incoming.stream.session;
      const state = session === undefined ? undefined : sessions.get(session);

      if (state === undefined) {
        incoming.stream.close(constants.NGHTTP2_CANCEL);

        return;
      }

      if (!mapAuthorityToHost(incoming)) {
        writeBadRequest(outgoing);

        return;
      }

      bindProxiedClient(incoming.socket, state.client);
      input.request(incoming, outgoing);
    },
  );

  function disarm(state: SessionState): void {
    if (state.headerTimer !== null) clearTimeout(state.headerTimer);
    state.headerTimer = null;
  }

  function arm(session: ServerHttp2Session, state: SessionState): void {
    disarm(state);
    state.headerTimer = setTimeout(
      () => session.close(),
      bounds.requestHeadersTimeoutMs,
    );
    state.headerTimer.unref();
  }

  function track(
    session: ServerHttp2Session,
    state: SessionState,
    stream: ServerHttp2Stream,
  ): void {
    disarm(state);
    state.streams.add(stream);

    const requestTimer = setTimeout(() => {
      if (stream.state.remoteClose !== 1) {
        stream.close(constants.NGHTTP2_CANCEL);
      }
    }, bounds.requestTimeoutMs);

    requestTimer.unref();
    stream.setTimeout(bounds.idleTimeoutMs, () => {
      if (hasUnsentResponse(stream)) stream.close(constants.NGHTTP2_CANCEL);
    });
    stream.once("close", () => {
      clearTimeout(requestTimer);
      state.streams.delete(stream);

      if (state.streams.size === 0 && !session.closed && !session.destroyed) {
        arm(session, state);
      }
    });
  }

  return {
    attach(socket, client) {
      const created: ServerHttp2Session[] = [];
      const capture = (session: ServerHttp2Session) => created.push(session);
      server.on("session", capture);
      markHandshakeComplete(socket);
      server.emit("connection", socket);
      server.off("session", capture);
      const [session] = created;

      if (session === undefined) {
        socket.destroy();

        return;
      }

      const state: SessionState = {
        client,
        streams: new Set(),
        headerTimer: null,
      };

      sessions.set(session, state);
      bySocket.set(socket, state);
      arm(session, state);
      session.on("stream", (stream) => track(session, state, stream));
      session.once("close", () => {
        disarm(state);
        sessions.delete(session);
      });
    },
    idle(socket) {
      const state = bySocket.get(socket);

      return state === undefined || state.streams.size === 0;
    },
    close() {
      for (const session of sessions.keys()) session.close();
    },
  };
}
