import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createStatusArea } from "../src/areas/status.js";
import { createHttpTransport } from "../src/transport-http.js";

function deferred<T>() {
  let resolveValue: ((value: T | PromiseLike<T>) => void) | undefined;

  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });

  if (!resolveValue) throw new Error("Deferred promise resolver is missing");

  return { promise, resolve: resolveValue };
}

describe("status reads", () => {
  it("requests child threads while the timeline response is pending", async () => {
    const timeline = deferred<Response>();
    const timelineRequested = deferred<void>();
    const requests: string[] = [];

    const status = createStatusArea({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "node",
        fetch: async (input) => {
          const url = new URL(String(input));
          requests.push(url.pathname);

          if (url.pathname.endsWith("/timeline")) {
            timelineRequested.resolve();

            return timeline.promise;
          }

          return Response.json(
            url.pathname === "/api/v1/threads/thread-1"
              ? {
                  id: "thread-1",
                  projectId: "project-1",
                  status: "idle",
                  pinnedAt: null,
                  shelvedAt: null,
                }
              : { threads: [] },
          );
        },
      }),
    });

    const reading = status.get({ threadId: "thread-1" });

    try {
      await timelineRequested.promise;
      await setImmediate();
      expect(requests).toContain("/api/v1/threads");
    } finally {
      timeline.resolve(Response.json({ pendingTodos: null }));
      await reading;
    }

    expect(await reading).toMatchObject({
      childThreads: { threads: [] },
      pendingTodos: null,
      thread: { id: "thread-1" },
    });
  });

  it("keeps successful child threads when the timeline request fails", async () => {
    const status = createStatusArea({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "node",
        fetch: async (input) => {
          const url = new URL(String(input));

          if (url.pathname.endsWith("/timeline"))
            return new Response(null, { status: 503 });

          return Response.json(
            url.pathname === "/api/v1/threads/thread-1"
              ? { id: "thread-1", projectId: "project-1", status: "idle" }
              : { threads: [] },
          );
        },
      }),
    });

    expect(await status.get({ threadId: "thread-1" })).toMatchObject({
      childThreads: { threads: [] },
      pendingTodos: null,
      thread: { id: "thread-1" },
    });
  });
});
