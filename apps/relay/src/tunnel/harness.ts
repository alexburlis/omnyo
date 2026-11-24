import { once } from "node:events";
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  TUNNEL_PROTOCOL_QUERY_PARAM,
  type HeaderPair,
} from "@omnyo/tunnel-contract";
import {
  TUNNEL_SOCKET_SERVER_OPTIONS,
  VISITOR_SOCKET_SERVER_OPTIONS,
  type TunnelOwner,
  type TunnelRegistry,
} from "../contracts.js";

export const HARNESS_ROUTING_KEY_HEADER = "x-harness-routing-key";

export const HARNESS_OWNER_HEADER = "x-harness-owner";

export const HARNESS_EXPECTED_OWNER_HEADER = "x-harness-expected-owner";

export const HARNESS_TARGET_HEADER = "x-harness-target";

const HARNESS_HEADER_PREFIX = "x-harness-";

const TUNNEL_PATH = "/__tunnel";

export interface TunnelHarness {
  port: number;
  close(): Promise<void>;
}

export function parseClientProtocolVersion(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseOwner(raw: string | undefined): TunnelOwner | null {
  if (raw === undefined) return null;
  const separator = raw.indexOf(":");

  if (separator <= 0 || separator === raw.length - 1) return null;
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);

  if (kind === "server") return { kind: "server", serverId: id };

  if (kind === "machine") return { kind: "machine", machineId: id };

  return null;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];

  return typeof value === "string" && value !== "" ? value : undefined;
}

function forwardedHeaders(request: IncomingMessage): HeaderPair[] {
  const pairs: HeaderPair[] = [];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];

    if (name === undefined || value === undefined) continue;

    if (name.toLowerCase().startsWith(HARNESS_HEADER_PREFIX)) continue;
    pairs.push([name, value]);
  }

  return pairs;
}

interface VisitorRoute {
  routingKey: string;
  ownerUserId: string;
  expectedOwner: TunnelOwner | null;
  target: string | null;
}

function visitorRoute(request: IncomingMessage): VisitorRoute | null {
  const routingKey = singleHeader(request, HARNESS_ROUTING_KEY_HEADER);

  if (routingKey === undefined) return null;
  const expectedRaw = singleHeader(request, HARNESS_EXPECTED_OWNER_HEADER);
  const expectedOwner = parseOwner(expectedRaw);

  if (expectedRaw !== undefined && expectedOwner === null) return null;

  return {
    routingKey,
    ownerUserId: routingKey,
    expectedOwner,
    target: singleHeader(request, HARNESS_TARGET_HEADER) ?? null,
  };
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const length = request.headers["content-length"];

  return length !== undefined && length !== "0";
}

function requestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<Buffer> = request[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();

      if (next.done === true) {
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(next.value));
      }
    },
    cancel() {
      request.destroy();
    },
  });
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      response.off("drain", settle);
      response.off("close", settle);
      resolve();
    };

    response.once("drain", settle);
    response.once("close", settle);
  });
}

async function writeResponse(
  source: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => {
    if (name !== "set-cookie") target.setHeader(name, value);
  });
  const cookies = source.headers.getSetCookie();

  if (cookies.length > 0) target.setHeader("set-cookie", cookies);

  if (source.body === null) {
    target.end();

    return;
  }

  const reader = source.body.getReader();
  target.once("close", () => {
    if (!target.writableFinished) void reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      if (target.destroyed) return;

      if (!target.write(value)) await waitForDrainOrClose(target);
    }

    target.end();
  } catch {
    target.destroy();
  }
}

function writeRawResponse(
  socket: Duplex,
  response: Response,
  body: string,
): void {
  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`,
  ];

  response.headers.forEach((value, name) => {
    if (name !== "content-length") lines.push(`${name}: ${value}`);
  });
  lines.push(`content-length: ${Buffer.byteLength(body)}`, "connection: close");
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

function protocolsOf(request: IncomingMessage): string[] {
  const raw = request.headers["sec-websocket-protocol"];

  if (typeof raw !== "string") return [];

  return raw
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

export async function startTunnelHarness(
  registry: TunnelRegistry,
  port = 0,
): Promise<TunnelHarness> {
  const tunnelServer = new WebSocketServer(TUNNEL_SOCKET_SERVER_OPTIONS);

  const selectedProtocols = new WeakMap<IncomingMessage, string | null>();

  const visitorServer = new WebSocketServer({
    ...VISITOR_SOCKET_SERVER_OPTIONS,
    handleProtocols: (_offered, request) =>
      selectedProtocols.get(request) ?? false,
  });

  const httpServer = createServer((request, response) => {
    const route = visitorRoute(request);

    if (route === null) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("missing harness routing headers\n");

      return;
    }

    const abort = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    const url = new URL(request.url ?? "/", "http://harness.invalid");

    void registry
      .openHttpStream({
        ...route,
        grant: { kind: "anonymous" },
        signal: abort.signal,
        method: request.method ?? "GET",
        path: url.pathname + url.search,
        headers: forwardedHeaders(request),
        body: requestHasBody(request) ? requestBody(request) : null,
      })
      .then((relayed) => writeResponse(relayed, response))
      .catch(() => response.destroy());
  });

  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://harness.invalid");

      if (url.pathname === TUNNEL_PATH) {
        const routingKey = singleHeader(request, HARNESS_ROUTING_KEY_HEADER);
        const owner = parseOwner(singleHeader(request, HARNESS_OWNER_HEADER));

        if (routingKey === undefined || owner === null) {
          socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");

          return;
        }

        tunnelServer.handleUpgrade(request, socket, head, (tunnel) =>
          registry.attach({
            routingKey,
            owner,
            protocolVersion: parseClientProtocolVersion(
              url.searchParams.get(TUNNEL_PROTOCOL_QUERY_PARAM),
            ),
            socket: tunnel,
          }),
        );

        return;
      }

      const route = visitorRoute(request);

      if (route === null) {
        socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");

        return;
      }

      const abort = new AbortController();
      socket.once("close", () => abort.abort());

      void registry
        .openWsStream({
          ...route,
          grant: { kind: "anonymous" },
          signal: abort.signal,
          path: url.pathname + url.search,
          headers: forwardedHeaders(request),
          protocols: protocolsOf(request),
        })
        .then(async (result) => {
          if (result.kind === "refused") {
            writeRawResponse(
              socket,
              result.response,
              await result.response.text(),
            );

            return;
          }

          if (socket.destroyed) {
            result.cancel("visitor left before the upgrade");

            return;
          }

          selectedProtocols.set(request, result.protocol);
          visitorServer.handleUpgrade(request, socket, head, (visitor) =>
            result.bind(visitor),
          );
        })
        .catch(() => socket.destroy());
    },
  );

  httpServer.listen(port, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("The tunnel harness expected a TCP address");
  }

  return {
    port: address.port,
    close: async () => {
      for (const client of tunnelServer.clients) client.terminate();

      for (const client of visitorServer.clients) client.terminate();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
