import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  diagnosticRunningReadFetch,
  observeRunningRead,
} from "../../src/services/system/running-read-diagnostics.js";

describe("local running read diagnostics", () => {
  it("separates enqueue, handler DB work and response without altering the result", async () => {
    const app = new Hono();
    const logger = { info: vi.fn() };
    app.get("/api/v1/threads/running", (context) =>
      observeRunningRead(
        context.req,
        () => [{ id: "private-thread", hostId: "private-host" }],
        (rows) => context.json(rows),
      ),
    );

    const fetchImpl = diagnosticRunningReadFetch(
      async (input, init) => app.request(input, init),
      () => true,
      logger,
    );

    const response = await fetchImpl("http://localhost/api/v1/threads/running");
    expect(await response.json()).toEqual([
      { id: "private-thread", hostId: "private-host" },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "received",
        enqueueToHandlerMs: expect.any(Number),
        readElapsedMs: expect.any(Number),
        readCpuMs: expect.any(Number),
        handlerToResponseMs: expect.any(Number),
        responseHeadersMs: expect.any(Number),
      }),
      "Local running-thread read timing",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(
      /private-thread|private-host/,
    );
  });

  it("does not add diagnostic headers or logs while disabled", async () => {
    const logger = { info: vi.fn() };

    const transport = vi.fn(async (_input, init) => {
      expect(
        new Headers(init?.headers).has("x-omnyo-local-read-diagnostic"),
      ).toBe(false);

      return new Response("[]");
    });

    const fetchImpl = diagnosticRunningReadFetch(
      transport,
      () => false,
      logger,
    );

    await fetchImpl("http://localhost/api/v1/threads/running");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
