import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createServerClient } from "./server-client.js";

describe("daemon event delivery deadline", () => {
  it.each(["headers", "body"])(
    "releases a stalled %s response and permits the next event post",
    async (stalledPhase) => {
      let requests = 0;

      const server = createServer((request, response) => {
        request.resume();
        requests += 1;

        if (requests === 1) {
          if (stalledPhase === "body") {
            response.writeHead(200, {
              "content-type": "application/json",
            });
            response.flushHeaders();
            response.write("{");
          }

          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ acceptedEvents: [], rejectedEvents: [] }),
        );
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();

      if (address === null || typeof address === "string") {
        throw new Error("The event endpoint did not bind a TCP port");
      }

      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);

      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(() => nativeTimeout(100));

      let guard: ReturnType<typeof setTimeout> | undefined;

      try {
        const client = createServerClient({
          getSessionId: () => "event-session",
          hostKey: "test-host-key",
          logger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
          },
          serverUrl: `http://127.0.0.1:${address.port}`,
        });

        const result = await Promise.race([
          client.postEvents({ events: [], firstEventIndex: 1 }).then(
            () => ({ kind: "resolved" }) as const,
            (error: unknown) => ({ kind: "rejected", error }) as const,
          ),
          new Promise<{ kind: "stalled" }>((resolve) => {
            guard = setTimeout(() => resolve({ kind: "stalled" }), 2_000);
          }),
        ]);

        expect(result.kind).toBe("rejected");

        if (result.kind !== "rejected") return;

        expect(result.error).toBeInstanceOf(Error);

        if (!(result.error instanceof Error)) return;

        expect(["AbortError", "TimeoutError"]).toContain(result.error.name);
        await expect(
          client.postEvents({ events: [], firstEventIndex: 1 }),
        ).resolves.toEqual({
          acceptedEvents: [],
          rejectedEvents: [],
        });
        expect(requests).toBe(2);
      } finally {
        clearTimeout(guard);
        timeout.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
