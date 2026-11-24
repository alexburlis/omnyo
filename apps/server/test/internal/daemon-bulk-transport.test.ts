import { once } from "node:events";
import {
  buildHostDaemonWebSocketAuthorizationHeader,
  buildHostDaemonWebSocketProtocols,
  encodeDaemonWirePayload,
  HOST_FILE_CHUNK_MAX_BYTES,
  hostDaemonServerWsMessageSchema,
  type HostDaemonOnlineRpcResponseMessage,
} from "@omnyo/host-daemon-contract";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

it("reads binary RPC replies and acknowledges only valid bulk frames on the daemon socket", async () => {
  const server = await startTestServer();
  let socket: WebSocket | undefined;

  try {
    const { host, session } = seedHostSession(server.deps);
    const url = new URL("/internal/ws", server.baseUrl);
    url.protocol = "ws:";
    url.searchParams.set("sessionId", session.id);
    socket = new WebSocket(url, buildHostDaemonWebSocketProtocols(), {
      headers: {
        authorization: buildHostDaemonWebSocketAuthorizationHeader(
          createTestDaemonHostKey({ hostId: host.id }),
        ),
      },
    });
    const connection = socket;
    const content = new Uint8Array(HOST_FILE_CHUNK_MAX_BYTES).fill(129);
    const ackLengths: number[] = [];
    let frameBytes: number | undefined;
    socket.on("message", (raw) => {
      const message = hostDaemonServerWsMessageSchema.parse(
        JSON.parse(raw.toString()),
      );

      if (message.type === "transport.bulk-ack") ackLengths.push(message.bytes);

      if (
        message.type !== "host-rpc.request" ||
        message.command.type !== "host.read_file_chunk"
      )
        return;

      const reply = {
        type: "host-rpc.response",
        commandType: "host.read_file_chunk",
        ok: true,
        requestId: message.requestId,
        result: {
          path: "/tmp/clip.mp4",
          sizeBytes: content.length,
          mimeType: "video/mp4",
          modifiedAtMs: 1234,
          offset: 0,
          revision: "a".repeat(64),
          content,
        },
      } satisfies HostDaemonOnlineRpcResponseMessage;

      const frame = encodeDaemonWirePayload(reply);

      if (!(frame instanceof Uint8Array))
        throw new Error("Expected binary file data");
      frameBytes = frame.byteLength;
      connection.send(frame);
    });
    await once(socket, "open");

    const result = await server.hub.requestHostOnlineRpc({
      hostId: host.id,
      message: {
        type: "host-rpc.request",
        requestId: "chunk-1",
        command: {
          type: "host.read_file_chunk",
          path: "/tmp/clip.mp4",
          rootPath: "/tmp",
          offset: 0,
          length: content.length,
          revision: null,
        },
      },
      timeoutMs: 1_500,
    });

    expect(result).toMatchObject({ ok: true, result: { content } });
    await vi.waitFor(() => expect(ackLengths).toEqual([frameBytes]));

    const closed = once(socket, "close");
    socket.send(new Uint8Array([0, 0, 0, 64]));
    await expect(closed).resolves.toEqual([
      1008,
      Buffer.from("invalid-message"),
    ]);
    expect(ackLengths).toHaveLength(1);
  } finally {
    socket?.terminate();
    await server.close();
  }
});
