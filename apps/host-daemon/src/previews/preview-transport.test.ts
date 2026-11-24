import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { PreviewHostTransport } from "./preview-transport.js";
import type { PreviewTransportCommandByType } from "@omnyo/host-daemon-contract";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const received: Record<string, string | undefined>[] = [];

  const server = createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      previewToken: request.headers["x-omnyo-key"]?.toString(),
      segment: request.headers["next-router-segment-prefetch"]?.toString(),
      origin: request.headers.origin,
    });

    if (request.url === "/cookie")
      response.setHeader("Set-Cookie", "preview=owned; Path=/; HttpOnly");

    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("Location", "../next?x=1");
    }

    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        path: request.url,
        cookie: request.headers.cookie ?? null,
      }),
    );
  });

  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (data: RawData, binary: boolean) =>
      socket.send(data, { binary }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("Fixture did not listen");
  let running = true;

  const transport = new PreviewHostTransport({
    validateRun: async (id, runId) => {
      if (id !== "prv_test" || runId !== "run_test" || !running)
        throw new Error("Stale run");
    },
    getTarget: async (id, runId) => {
      if (id !== "prv_test" || runId !== "run_test" || !running)
        throw new Error("Stale run");

      return { hostname: "127.0.0.1", port: address.port, protocol: "http:" };
    },
  });

  cleanup.push(async () => {
    transport.dispose();
    sockets.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  const target = {
    previewId: "prv_test",
    runId: "run_test",
    accessId: "access_test",
  };

  const command: PreviewTransportCommandByType["preview.http"] = {
    type: "preview.http",
    ...target,
    path: "/cookie",
    method: "GET",
    headers: [
      ["Authorization", "Bearer foreign"],
      ["Cookie", "omnyo=private"],
      ["X-Omnyo-Key", "private"],
    ],
    bodyBase64: "",
  };

  return {
    transport,
    received,
    command,
    target,
    offline() {
      running = false;
    },
  };
}

describe("registered preview host transport", () => {
  it("forwards only to the saved loopback server and keeps cookies isolated by preview access", async () => {
    const f = await fixture();
    const first = await f.transport.http(f.command);
    expect(first.headers.some(([name]) => name === "set-cookie")).toBe(false);

    const second = await f.transport.http({
      ...f.command,
      path: "/assets/app.js?q=1",
    });

    expect(
      JSON.parse(Buffer.from(second.bodyBase64, "base64").toString()),
    ).toEqual({ path: "/assets/app.js?q=1", cookie: "preview=owned" });
    await f.transport.http({
      ...f.command,
      path: "/other",
      accessId: "another_browser",
    });
    expect(f.received[0]).toEqual({
      authorization: undefined,
      cookie: undefined,
      previewToken: undefined,
      origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u),
    });
    expect(f.received[2]?.cookie).toBeUndefined();

    const redirect = await f.transport.http({
      ...f.command,
      path: "/redirect",
    });

    expect(redirect.status).toBe(302);
    expect(redirect.headers).toContainEqual(["location", "../next?x=1"]);
    await expect(
      f.transport.http({ ...f.command, path: "//example.com/" }),
    ).rejects.toThrow("Invalid preview request path");
    f.offline();
    await expect(f.transport.http(f.command)).rejects.toThrow("Stale run");
  });
  it("relays real text and binary WebSocket frames and refuses another access session", async () => {
    const f = await fixture();
    const socket = { ...f.target, connectionId: "connection_test" };
    await expect(
      f.transport.open({
        type: "preview.socket.open",
        ...socket,
        path: "/hmr?token=fixture",
        protocols: [],
      }),
    ).resolves.toEqual({ protocol: "" });
    await f.transport.write({
      type: "preview.socket.write",
      ...socket,
      binary: false,
      dataBase64: Buffer.from("update").toString("base64"),
    });

    const text = await f.transport.read({
      type: "preview.socket.read",
      ...socket,
    });

    expect(
      text.messages.map((message) => [
        Buffer.from(message.dataBase64, "base64").toString(),
        message.binary,
      ]),
    ).toEqual([["update", false]]);
    await f.transport.write({
      type: "preview.socket.write",
      ...socket,
      binary: true,
      dataBase64: Buffer.from([0, 255]).toString("base64"),
    });
    expect(
      (await f.transport.read({ type: "preview.socket.read", ...socket }))
        .messages[0]?.binary,
    ).toBe(true);
    await expect(
      f.transport.read({
        type: "preview.socket.read",
        ...socket,
        accessId: "different",
      }),
    ).rejects.toThrow("unavailable");
    f.offline();
    await expect(
      f.transport.read({ type: "preview.socket.read", ...socket }),
    ).rejects.toThrow("Stale run");
  });
});

describe("preview segment prefetch forwarding", () => {
  it("keeps the requested segment header on the target request", async () => {
    const f = await fixture();
    await f.transport.http({
      ...f.command,
      headers: [["next-router-segment-prefetch", "/_tree"]],
    });
    expect(f.received[0]?.segment).toBe("/_tree");
  });
});
