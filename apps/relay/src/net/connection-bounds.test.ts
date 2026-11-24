import { once } from "node:events";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { type AddressInfo, Socket, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  type ConnectionBounds,
  boundHttpConnections,
  DEFAULT_CONNECTION_BOUNDS,
  createClientConnectionLimit,
  throttledCount,
} from "./connection-bounds.js";

const LONG_MS = 10_000;

const OBSERVE_MS = 2_000;

const servers: Server[] = [];

const sockets: Socket[] = [];

const timers: NodeJS.Timeout[] = [];

afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);

  for (const socket of sockets.splice(0)) socket.destroy();

  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }),
  );
});

async function serve(
  bounds: Pick<ConnectionBounds, "requestHeadersTimeoutMs" | "idleTimeoutMs"> &
    Partial<Pick<ConnectionBounds, "requestTimeoutMs">>,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  boundHttpConnections(server, { requestTimeoutMs: LONG_MS, ...bounds });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return { server, port: (server.address() as AddressInfo).port };
}

async function open(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  sockets.push(socket);
  await once(socket, "connect");

  return socket;
}

function closedWithin(socket: Socket, ms: number): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };

    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve(false);
    }, ms);

    socket.once("close", onClose);
  });
}

function collect(socket: Socket): () => string {
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString()));

  return () => received;
}

function trickle(socket: Socket, everyMs: number): void {
  timers.push(
    setInterval(() => {
      if (socket.writable) socket.write("a");
    }, everyMs),
  );
}

const ok = (_request: IncomingMessage, response: ServerResponse) => {
  response.end("ok");
};

describe("boundHttpConnections", () => {
  it("closes a connection whose request headers stall", async () => {
    const { port } = await serve(
      { requestHeadersTimeoutMs: 200, idleTimeoutMs: LONG_MS },
      ok,
    );

    const socket = await open(port);
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\n");

    expect(await closedWithin(socket, OBSERVE_MS)).toBe(true);
  });

  it("closes a client that trickles header bytes faster than the idle timeout", async () => {
    const { port } = await serve(
      { requestHeadersTimeoutMs: 300, idleTimeoutMs: 200 },
      ok,
    );

    const socket = await open(port);
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\nx-slow: ");
    trickle(socket, 50);

    expect(await closedWithin(socket, OBSERVE_MS)).toBe(true);
  });

  it("applies the header deadline again to the next request on a kept-alive connection", async () => {
    const { port } = await serve(
      { requestHeadersTimeoutMs: 300, idleTimeoutMs: LONG_MS },
      ok,
    );

    const socket = await open(port);
    const received = collect(socket);
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\n\r\n");
    await expect.poll(received).toMatch(/\r\n\r\nok$/u);
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\nx-slow: ");
    trickle(socket, 50);

    expect(await closedWithin(socket, OBSERVE_MS)).toBe(true);
  });

  it("does not cut a response that keeps streaming past the header deadline", async () => {
    const { port } = await serve(
      { requestHeadersTimeoutMs: 150, idleTimeoutMs: 300 },
      (_request, response) => {
        let sent = 0;
        response.writeHead(200, { "content-type": "text/plain" });

        const timer = setInterval(() => {
          sent += 1;
          response.write(`${String(sent)};`);

          if (sent === 8) {
            clearInterval(timer);
            response.end();
          }
        }, 100);
      },
    );

    const socket = await open(port);
    const received = collect(socket);
    socket.write(
      "GET / HTTP/1.1\r\nhost: relay.test\r\nconnection: close\r\n\r\n",
    );
    await once(socket, "close");

    expect(received()).toMatch(/^HTTP\/1\.1 200/u);
    expect(received()).toContain("8;");
  });

  it("closes a request whose body trickles past the whole-request deadline", async () => {
    const { port } = await serve(
      {
        requestHeadersTimeoutMs: LONG_MS,
        requestTimeoutMs: 400,
        idleTimeoutMs: LONG_MS,
      },
      (request, response) => {
        request.resume();
        request.once("end", () => response.end("ok"));
      },
    );

    const socket = await open(port);
    socket.write(
      "POST /sign-in HTTP/1.1\r\nhost: relay.test\r\ncontent-length: 60000\r\n\r\n",
    );
    trickle(socket, 50);

    expect(await closedWithin(socket, OBSERVE_MS)).toBe(true);
  });

  it("does not cut a complete request whose response streams past the whole-request deadline", async () => {
    const { port } = await serve(
      {
        requestHeadersTimeoutMs: LONG_MS,
        requestTimeoutMs: 150,
        idleTimeoutMs: LONG_MS,
      },
      (_request, response) => {
        let sent = 0;
        response.writeHead(200, { "content-type": "text/plain" });

        const timer = setInterval(() => {
          sent += 1;
          response.write(`${String(sent)};`);

          if (sent === 6) {
            clearInterval(timer);
            response.end();
          }
        }, 100);
      },
    );

    const socket = await open(port);
    const received = collect(socket);
    socket.write(
      "GET / HTTP/1.1\r\nhost: relay.test\r\nconnection: close\r\n\r\n",
    );
    await once(socket, "close");

    expect(received()).toContain("6;");
  });

  it("answers pipelined requests while an earlier response is still pending", async () => {
    let calls = 0;

    const { port } = await serve(
      { requestHeadersTimeoutMs: 150, idleTimeoutMs: LONG_MS },
      (_request, response) => {
        calls += 1;
        const body = `r${String(calls)}`;
        const delay = calls === 1 ? 500 : 0;
        setTimeout(() => response.end(body), delay);
      },
    );

    const socket = await open(port);
    const received = collect(socket);
    socket.write(
      "GET /1 HTTP/1.1\r\nhost: relay.test\r\n\r\nGET /2 HTTP/1.1\r\nhost: relay.test\r\n\r\n",
    );

    await expect.poll(received, { timeout: OBSERVE_MS }).toContain("r2");
    expect(received()).toContain("r1");
  });

  it("keeps a quiet response open past the idle timeout until it ends", async () => {
    let finish: () => void = () => {};

    const { port } = await serve(
      { requestHeadersTimeoutMs: LONG_MS, idleTimeoutMs: 200 },
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        finish = () => response.end("data: last\n\n");
      },
    );

    const socket = await open(port);
    const received = collect(socket);
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\n\r\n");

    expect(await closedWithin(socket, 1_000)).toBe(false);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received()).toContain("data: last");
  });

  it("closes a connection whose client stops reading a response past the idle timeout", async () => {
    const chunk = Buffer.alloc(64 * 1024, 97);

    let served: Socket | null = null;

    const { port } = await serve(
      { requestHeadersTimeoutMs: LONG_MS, idleTimeoutMs: 300 },
      (request, response) => {
        served = request.socket as Socket;
        response.writeHead(200);

        const pump = () => {
          while (response.write(chunk)) {}

          response.once("drain", pump);
        };

        pump();
      },
    );

    const socket = await open(port);
    socket.pause();
    socket.write("GET / HTTP/1.1\r\nhost: relay.test\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(served).not.toBeNull();
    expect(await closedWithin(served as unknown as Socket, OBSERVE_MS)).toBe(
      true,
    );
  });

  it("keeps an upgraded WebSocket open past both deadlines", async () => {
    const { server, port } = await serve(
      { requestHeadersTimeoutMs: 150, idleTimeoutMs: 150 },
      ok,
    );

    const upgrades = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      upgrades.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data: Buffer) => ws.send(data.toString()));
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/`);
    await once(client, "open");
    await new Promise((resolve) => setTimeout(resolve, 600));
    client.send("still here");
    const [reply] = (await once(client, "message")) as [Buffer];

    expect(reply.toString()).toBe("still here");
    client.close();
    await once(client, "close");
    upgrades.close();
  });
});

describe("createClientConnectionLimit", () => {
  it("admits a bounded number of connections per client and counts an IPv6 /64 as one client", async () => {
    const limit = createClientConnectionLimit(2);
    const first = new Socket();
    const second = new Socket();

    expect(limit.admit(first, "198.51.100.7")).toBe("admitted");
    expect(limit.admit(second, "198.51.100.7")).toBe("admitted");
    expect(limit.admit(new Socket(), "198.51.100.7")).toBe("client-limit");
    expect(limit.admit(new Socket(), "198.51.100.8")).toBe("admitted");

    expect(limit.admit(new Socket(), "2001:db8:1:2::1")).toBe("admitted");
    expect(limit.admit(new Socket(), "2001:db8:1:2::ffff")).toBe("admitted");
    expect(limit.admit(new Socket(), "2001:db8:1:2:abcd::1")).toBe(
      "client-limit",
    );
    expect(limit.admit(new Socket(), "2001:db8:1:3::1")).toBe("admitted");

    first.destroy();
    await once(first, "close");

    expect(limit.admit(new Socket(), "198.51.100.7")).toBe("admitted");
    expect(limit.admit(new Socket(), "198.51.100.7")).toBe("client-limit");
  });
});

describe("createClientConnectionLimit across the /64 networks of one /48", () => {
  it("stops one IPv6 /48 at 8 times the per-client limit and leaves other sites and IPv4 clients alone", async () => {
    const limit = createClientConnectionLimit(2);
    const held: Socket[] = [];

    for (let network = 0; network < 16; network += 1) {
      const socket = new Socket();
      held.push(socket);
      expect(
        limit.admit(socket, `2001:db8:77:${network.toString(16)}::1`),
      ).toBe("admitted");
    }

    expect(limit.admit(new Socket(), "2001:db8:77:ff::1")).toBe("client-limit");
    expect(limit.admit(new Socket(), "2001:db8:78::1")).toBe("admitted");
    expect(limit.admit(new Socket(), "198.51.100.9")).toBe("admitted");

    const first = held[0];

    if (first === undefined) throw new Error("no socket");
    first.destroy();
    await once(first, "close");

    expect(limit.admit(new Socket(), "2001:db8:77:ff::1")).toBe("admitted");
    expect(limit.admit(new Socket(), "2001:db8:77:fe::1")).toBe("client-limit");
  });
});

describe("createClientConnectionLimit at the overall limit", () => {
  function fill(
    limit: ReturnType<typeof createClientConnectionLimit>,
    addresses: readonly string[],
    each: number,
  ): Socket[] {
    const held: Socket[] = [];

    for (const address of addresses) {
      for (let index = 0; index < each; index += 1) {
        const socket = new Socket();
        held.push(socket);
        expect(limit.admit(socket, address)).toBe("admitted");
      }
    }

    return held;
  }

  it("admits one more source when sources at the per-client limit fill the default overall limit", () => {
    const { maxConnections, maxConnectionsPerClient } =
      DEFAULT_CONNECTION_BOUNDS;

    const limit = createClientConnectionLimit(
      maxConnectionsPerClient,
      maxConnections,
    );

    const sources = Array.from(
      { length: maxConnections / maxConnectionsPerClient },
      (_unused, index) => `203.0.113.${index + 1}`,
    );

    const held = fill(limit, sources, maxConnectionsPerClient);

    expect(limit.admit(new Socket(), "198.51.100.200")).toBe("admitted");
    expect(held.filter((socket) => socket.destroyed)).toHaveLength(1);
    expect(limit.admit(new Socket(), "198.51.100.201")).toBe("admitted");
    expect(held.filter((socket) => socket.destroyed)).toHaveLength(2);
  });

  it("treats one IPv6 /48 as one source when it sheds connections for a newcomer", () => {
    const limit = createClientConnectionLimit(2, 4);

    const held = fill(
      limit,
      ["2001:db8:5:1::1", "2001:db8:5:2::1", "2001:db8:5:3::1"],
      1,
    );

    fill(limit, ["198.51.100.70"], 1);

    expect(limit.admit(new Socket(), "198.51.100.71")).toBe("admitted");
    expect(held.filter((socket) => socket.destroyed)).toHaveLength(1);
  });

  it("sheds an idle connection before a busy one, and refuses a newcomer when every source holds a fair share", () => {
    const limit = createClientConnectionLimit(4, 4);
    const busy = new Socket();
    const idle = new Socket();

    expect(limit.admit(busy, "198.51.100.80", () => false)).toBe("admitted");
    expect(limit.admit(idle, "198.51.100.80")).toBe("admitted");
    fill(limit, ["198.51.100.81", "198.51.100.82"], 1);

    expect(limit.admit(new Socket(), "198.51.100.83")).toBe("admitted");
    expect({ busy: busy.destroyed, idle: idle.destroyed }).toEqual({
      busy: false,
      idle: true,
    });
    expect(limit.admit(new Socket(), "198.51.100.84")).toBe("connection-limit");
  });
});

describe("throttledCount", () => {
  it("reports the first event at once and then at most once per interval with the count", () => {
    let at = 0;
    const reports: number[] = [];

    const count = throttledCount({
      now: () => at,
      intervalMs: 1_000,
      report: (value) => reports.push(value),
    });

    count();
    count();
    count();
    at = 999;
    count();

    expect(reports).toEqual([1]);
    at = 1_000;
    count();

    expect(reports).toEqual([1, 4]);
  });
});
