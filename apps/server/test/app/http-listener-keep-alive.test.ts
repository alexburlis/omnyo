import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startHttpListener } from "../../src/http-listener.js";

function blockEventLoop(durationMs: number): void {
  const end = Date.now() + durationMs;

  while (Date.now() < end);
}

describe("HTTP listener keep-alive", () => {
  it("answers a request on an idle keep-alive connection after the event loop stalls past Node's idle timeout", async () => {
    const server = startHttpListener({
      fetch: () => new Response("ok"),
      logger: { info: vi.fn() },
      serverConfig: {
        OMNYO_SERVER_BIND_HOST: "127.0.0.1",
        OMNYO_SERVER_PORT: 0,
      },
    });

    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();

      if (address === null || typeof address === "string") {
        throw new Error("The listener has no TCP address");
      }

      const url = `http://127.0.0.1:${address.port}/`;

      await (await fetch(url)).text();

      const answer = await new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          fetch(url)
            .then((response) => response.text())
            .then(resolve, reject);
        }, 10);
        setTimeout(() => blockEventLoop(6_500), 10);
      });

      expect(answer).toBe("ok");
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
  }, 15_000);
});
