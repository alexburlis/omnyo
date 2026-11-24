import { once } from "node:events";
import { connect, constants, createServer } from "node:http2";
import { getRequestListener } from "@hono/node-server";
import { expect, it } from "vitest";
import { RelayHttp2ServerResponse } from "./edge-responses.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

it("cancels pending upstream work on HTTP/2 reset and keeps completed requests successful", async () => {
  const pending = deferred<AbortSignal>();
  const completed = deferred<AbortSignal>();
  const release = deferred<void>();
  const responseClosed = deferred<void>();
  const handlerFinished = deferred<void>();

  const listener = getRequestListener(
    async (request) => {
      if (new URL(request.url).pathname === "/complete") {
        completed.resolve(request.signal);

        return new Response("complete");
      }

      pending.resolve(request.signal);
      await release.promise;

      return new Response(null, { status: 204 });
    },
    { overrideGlobalObjects: false },
  );

  const server = createServer(
    { Http2ServerResponse: RelayHttp2ServerResponse },
    (request, response) => {
      if (request.url === "/pending")
        response.once("close", () => responseClosed.resolve());
      void listener(request, response).finally(() => {
        if (request.url === "/pending") handlerFinished.resolve();
      });
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (address === null || typeof address === "string")
    throw new Error("HTTP/2 listener did not bind a port");
  const client = connect(`http://127.0.0.1:${address.port}`);

  try {
    const complete = client.request({ ":path": "/complete" });
    const completeEnd = once(complete, "end");
    const completeClose = once(complete, "close");
    let body = "";
    complete.setEncoding("utf8");
    complete.on("data", (chunk: string) => {
      body += chunk;
    });
    await completeEnd;
    await completeClose;
    expect(body).toBe("complete");
    expect((await completed.promise).aborted).toBe(false);

    const request = client.request({ ":path": "/pending" });
    const signal = await pending.promise;
    const closed = once(request, "close");
    request.close(constants.NGHTTP2_CANCEL);
    await closed;
    await responseClosed.promise;
    expect(signal.aborted).toBe(true);
  } finally {
    release.resolve();
    await handlerFinished.promise;
    client.destroy();
    server.close();
    await once(server, "close");
  }
});
