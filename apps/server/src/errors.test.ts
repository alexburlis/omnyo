import { Hono } from "hono";
import { QueuedMessageThreadUnavailableError } from "@omnyo/db";
import { once } from "node:events";
import { request, Server } from "node:http";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createServerErrorHandler } from "./errors.js";
import { startHttpListener } from "./http-listener.js";

function createApp(error: Error | ((signal: AbortSignal) => Promise<never>)) {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  const app = new Hono();
  app.onError(createServerErrorHandler(logger));
  app.post("/api/v1/threads/:threadId/messages", async (context) => {
    if (typeof error === "function") return await error(context.req.raw.signal);
    throw error;
  });

  return { app, logger };
}

it("records at most 120 correlated asset attempts a minute while serving every request", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-22T12:00:10Z"), toFake: ["Date"] });

  const { app, logger } = createApp(new Error("Unused route"));

  const headers = {
    "x-omnyo-asset-attempt": "638e6779-928d-4543-a55f-59e31050b30e",
  };

  app.get("/assets/ready-AbCd1234.js", (context) => context.text("ready"));

  const server = startHttpListener({
    fetch: app.fetch,
    logger,
    serverConfig: {
      OMNYO_SERVER_BIND_HOST: "127.0.0.1",
      OMNYO_SERVER_PORT: 0,
    },
  });

  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener");
    const asset = `http://127.0.0.1:${address.port}/assets/ready-AbCd1234.js`;

    for (let attempt = 0; attempt < 121; attempt += 1) {
      const response = await fetch(asset, { headers });

      expect(await response.text()).toBe("ready");
    }

    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(120));
    vi.setSystemTime(new Date("2026-11-22T12:01:10Z"));
    const renewed = await fetch(asset, { headers });

    expect(await renewed.text()).toBe("ready");
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(121));
  } finally {
    vi.useRealTimers();

    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("reports whether a correlated asset request closed before sending headers", async () => {
  const started = createDeferredPromise<void>();
  const observed = createDeferredPromise<void>();
  const { app, logger } = createApp(new Error("Unused route"));
  const assetAttemptId = "638e6779-928d-4543-a55f-59e31050b30e";
  const headers = { "x-omnyo-asset-attempt": assetAttemptId };

  app.get("/assets/stalled-AbCd1234.js", async (context) => {
    const signal = context.req.raw.signal;

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      started.resolve();
    });

    return new Response(null, { status: 499 });
  });
  app.get("/assets/ready-AbCd1234.js", (context) => context.text("ready"));
  logger.info.mockImplementationOnce(() => observed.resolve());

  const server = startHttpListener({
    fetch: app.fetch,
    logger,
    serverConfig: {
      OMNYO_SERVER_BIND_HOST: "127.0.0.1",
      OMNYO_SERVER_PORT: 0,
    },
  });

  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();

    const stalled = fetch(`${origin}/assets/stalled-AbCd1234.js`, {
      headers,
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    await expect(stalled).rejects.toMatchObject({ name: "AbortError" });
    await observed.promise;
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      {
        assetAttemptId,
        elapsedMs: expect.any(Number),
        headersSent: false,
        responseFinished: false,
      },
      "Split asset attempt",
    );

    for (const attempt of [
      headers,
      { "x-omnyo-asset-attempt": "private/path" },
    ]) {
      const response = await fetch(`${origin}/assets/ready-AbCd1234.js`, {
        headers: attempt,
      });

      expect(await response.text()).toBe("ready");
    }

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenLastCalledWith(
      {
        assetAttemptId,
        elapsedMs: expect.any(Number),
        headersSent: true,
        responseFinished: true,
      },
      "Split asset attempt",
    );
  } finally {
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("createServerErrorHandler", () => {
  it.each(["archived", "deleted"] as const)(
    "returns a quiet conflict for a %s queue target",
    async (reason) => {
      const error = new QueuedMessageThreadUnavailableError("thread-1", reason);
      const { app, logger } = createApp(error);

      const response = await app.request("/api/v1/threads/thread-1/messages", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "thread_not_writable",
        message: error.message,
      });
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
  it("does not report a client disconnect while reading its request body", async () => {
    const entered = createDeferredPromise<void>();
    const handled = createDeferredPromise<void>();

    const { app, logger } = createApp(async () => {
      throw new Error("Unused route");
    });

    const handleError = createServerErrorHandler(logger);
    let status: number | undefined;

    app.onError((error, context) => {
      const response = handleError(error, context);

      if (response instanceof Promise)
        throw new Error("Unexpected async error handler");
      status = response.status;
      handled.resolve();

      return response;
    });
    app.post("/upload", async (context) => {
      entered.resolve();
      await context.req.text();

      return context.text("complete");
    });

    const server = startHttpListener({
      fetch: app.fetch,
      logger,
      serverConfig: {
        OMNYO_SERVER_BIND_HOST: "127.0.0.1",
        OMNYO_SERVER_PORT: 0,
      },
    });

    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("Expected a TCP listener");

      const upload = request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/upload",
        method: "POST",
        headers: { "content-length": "100000" },
      });

      upload.on("error", () => {});
      upload.write("partial request body");
      await entered.promise;
      upload.destroy();
      await handled.promise;

      expect(status).toBe(499);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      if (server instanceof Server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("returns 499 without reporting an in-flight request cancellation", async () => {
    const started = createDeferredPromise<void>();
    const controller = new AbortController();

    const { app, logger } = createApp(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Loading canceled", "AbortError")),
            { once: true },
          );
          started.resolve();
        }),
    );

    const loading = app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const response = await loading;

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({
      code: "request_cancelled",
      message: "Request cancelled",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an AbortError on an active request",
      error: new DOMException("Loading canceled", "AbortError"),
      aborted: false,
    },
    {
      name: "a timeout on a cancelled request",
      error: new DOMException("The operation timed out", "TimeoutError"),
      aborted: true,
    },
    {
      name: "an unexpected error on a cancelled request",
      error: new Error("Timeline build failed"),
      aborted: true,
    },
    {
      name: "a deliberate 500 on a cancelled request",
      error: new ApiError(500, "internal_error", "Thread changed twice"),
      aborted: true,
    },
    {
      name: "an upstream reset on a cancelled request",
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      aborted: true,
    },
    {
      name: "a body reset on an active request",
      error: Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
      aborted: false,
    },
    {
      name: "an unmatched body reset on a cancelled request",
      error: Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
      aborted: true,
    },
  ])("keeps reporting $name", async ({ error, aborted }) => {
    const { app, logger } = createApp(error);
    const controller = new AbortController();

    if (aborted) controller.abort();

    const response = await app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
      signal: controller.signal,
    });

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("logs deliberate 5xx API errors with the failing request", async () => {
    const error = new ApiError(500, "internal_error", "Thread changed twice");
    const { app, logger } = createApp(error);

    const response = await app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal_error",
      message: "Thread changed twice",
    });
    expect(logger.error).toHaveBeenCalledWith(
      {
        err: error,
        method: "POST",
        path: "/api/v1/threads/thr_x/messages",
        status: 500,
        body: { code: "internal_error", message: "Thread changed twice" },
      },
      "Server error response",
    );
  });

  it("does not log client errors", async () => {
    const { app, logger } = createApp(
      new ApiError(404, "thread_not_found", "Thread not found"),
    );

    const response = await app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
