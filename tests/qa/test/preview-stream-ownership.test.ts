import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { WebSocket, type RawData } from "ws";
import { expect, it } from "vitest";
import { z } from "zod";
import { ManagedPreviewManager } from "../../../apps/host-daemon/src/previews/managed-preview-manager.js";
import { PreviewHostTransport } from "../../../apps/host-daemon/src/previews/preview-transport.js";
import { registerPreviewTransport } from "../../../apps/server/src/services/previews/preview-transport.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import type {
  ManagedPreviewLaunch,
  PreviewTransportCommand,
} from "@omnyo/host-daemon-contract";

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return address.port;
}

async function echo(
  socket: WebSocket,
  data: string | Buffer,
  binary: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", received);
      reject(new Error("Echo deadline"));
    }, 3000);

    const received = (bytes: RawData, wasBinary: boolean) => {
      const value = Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : Buffer.from(
            bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes,
          );

      if (wasBinary !== binary || !value.equals(Buffer.from(data))) return;
      clearTimeout(timer);
      socket.off("message", received);
      resolve();
    };

    socket.on("message", received);
    socket.send(data, { binary });
  });
}

it("forwards owned streams without readiness requests and keeps new access fail closed", async () => {
  const port = await availablePort();
  const require = createRequire(import.meta.url);
  const wsModule = require.resolve("ws");

  const source = `
const {createServer} = require('node:http');
const {WebSocketServer} = require(${JSON.stringify(wsModule)});
let count=0, ready=true;
const server=createServer((req,res)=>{
  if(req.url==='/__count'){res.end(JSON.stringify(count));return;}
  if(req.url==='/__reset'){count=0;res.end('reset');return;}
  if(req.url==='/__unready'){ready=false;res.end('changed');return;}
  count++;
  sockets.clients.forEach(socket=>socket.send(JSON.stringify({action:'built'})));
  res.statusCode=ready?200:503;
  res.end('owned fixture');
});
const sockets=new WebSocketServer({server});
sockets.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
server.listen(${port},'127.0.0.1');
`;

  const preview: ManagedPreviewLaunch = {
    id: "prv_stream_fixture",
    projectId: "proj_stream_fixture",
    environmentId: "env_stream_fixture",
    cwd: realpathSync(tmpdir()),
    argv: [process.execPath, "-e", source],
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
    readinessPath: "/ready",
  };

  const manager = new ManagedPreviewManager({
    shellEnv: () => ({ PATH: process.env.PATH }),
    markActive: () => {},
    markInactive: () => {},
  });

  const started = await manager.ensure(preview, []);
  expect(started.state).toBe("online");

  if (started.runId === null) throw new Error("No owned run");
  const runId = started.runId;

  const binding = {
    id: preview.id,
    hostId: "host_stream_fixture",
    sessionId: "hses_stream_fixture",
    runId,
    localUrl: `http://127.0.0.1:${port}/ready`,
  };

  const host = new PreviewHostTransport({
    getTarget: (id, run) => manager.resolveTarget(id, run),
    validateRun: (id, run) => manager.validateSocketOwner(id, run),
  });

  const app = new Hono();
  app.onError((error) =>
    error instanceof ApiError
      ? error.toResponse()
      : new Response("Unexpected fixture error", { status: 500 }),
  );
  const ws = createNodeWebSocket({ app });

  const relay = registerPreviewTransport(
    app,
    {
      resolveBinding: async () => {
        const state = await manager.status(preview);

        if (state.state !== "online")
          throw new ApiError(503, "preview_not_ready", "Not ready");

        return binding;
      },
      validateBinding: async (expected) => {
        if (
          expected.runId !== runId ||
          expected.sessionId !== binding.sessionId
        )
          throw new Error("Changed binding");
      },
      call: async (_binding, command: PreviewTransportCommand) => {
        switch (command.type) {
          case "preview.http":
            return host.http(command);
          case "preview.socket.open":
            return host.open(command);
          case "preview.socket.read":
            return host.read(command);
          case "preview.socket.write":
            return host.write(command);
          case "preview.socket.close":
            return host.close(command);
        }
      },
      browserProblem: () => null,
    },
    ws.upgradeWebSocket,
  );

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  ws.injectWebSocket(server);
  let client: WebSocket | null = null;

  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("No relay port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { origin: base, "content-type": "application/json" };

    const grantResponse = await fetch(`${base}/preview/${preview.id}/access`, {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(grantResponse.status).toBe(200);

    const grant = z
      .object({ contentBase: z.string() })
      .parse(await grantResponse.json());

    client = new WebSocket(
      base.replace("http:", "ws:") + grant.contentBase + "/hmr",
      { headers: { origin: "null" } },
    );
    await once(client, "open");
    await fetch(`http://127.0.0.1:${port}/__reset`);
    await echo(client, "text-frame", false);
    expect(await (await fetch(`http://127.0.0.1:${port}/__count`)).json()).toBe(
      0,
    );
    await echo(client, Buffer.from([3, 1, 4]), true);
    const response = await fetch(`http://127.0.0.1:${port}/__count`);
    expect(await response.json()).toBe(0);
    await fetch(`http://127.0.0.1:${port}/__unready`);
    await echo(client, "still-owned", false);
    expect((await manager.status(preview)).state).not.toBe("online");
    expect(
      (
        await fetch(`${base}/preview/${preview.id}/access`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(503);
  } finally {
    client?.terminate();
    await relay.dispose();
    host.dispose();
    await manager.shutdown();

    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
