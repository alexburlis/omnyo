import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  captureTrustedRemoteAddress,
  getGateAuthKind,
  getTrustedRemoteAddress,
  guardAnonymousGateRequests,
  resolveRequestAppSurface,
  TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY,
} from "../src/request-context.js";

describe("request context", () => {
  it("allows only the exact Sentry webhook POST through the anonymous gate", async () => {
    const app = new Hono();
    app.onError((_error, context) => context.text("Not found", 404));
    app.use("*", guardAnonymousGateRequests);
    app.all("*", (context) => context.text("accepted"));
    const path = "/api/v1/plugins/sentry/http/webhook";
    const headers = { "x-omnyo-gate-auth": "anonymous" };

    expect((await app.request(path, { method: "POST", headers })).status).toBe(
      200,
    );

    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect((await app.request(path, { method, headers })).status).toBe(404);

    for (const other of [
      `${path}/`,
      `${path}/more`,
      `${path}.json`,
      "/api/v1/plugins/other/http/webhook",
      "/api/v1/plugins/sentry/http/status",
      "/api/v1/plugins/sentry/http/%77ebhook",
      "/api/v1/plugins/sentry/rpc",
    ])
      expect(
        (await app.request(other, { method: "POST", headers })).status,
        other,
      ).toBe(404);

    expect((await app.request("/install.sh", { headers })).status).toBe(200);
    expect(
      (await app.request("/preview-content/id/cap/index.html", { headers }))
        .status,
    ).toBe(200);
    expect((await app.request("/api/v1/threads", { headers })).status).toBe(
      404,
    );
  });

  it("captures the trusted remote address from node connection metadata", async () => {
    const app = new Hono();
    app.use("*", async (context, next) => {
      captureTrustedRemoteAddress(context);
      await next();
    });
    app.get("/", (context) =>
      context.json({
        address: getTrustedRemoteAddress(context),
      }),
    );

    const response = await app.fetch(new Request("http://example.test/"), {
      incoming: {
        socket: {
          remoteAddress: "127.0.0.1",
        },
      },
    });

    await expect(response.json()).resolves.toEqual({
      address: "127.0.0.1",
    });
  });

  it("stores undefined when connection metadata is unavailable", async () => {
    const app = new Hono();
    app.get("/", (context) => {
      captureTrustedRemoteAddress(context);

      return context.json({
        hasAddress:
          context.get(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY) !== undefined,
      });
    });

    const response = await app.request("/");

    await expect(response.json()).resolves.toEqual({
      hasAddress: false,
    });
  });
  it("resolves the app surface from the client header and falls back to api", async () => {
    const app = new Hono();
    app.get("/", (context) =>
      context.json({ surface: resolveRequestAppSurface(context) }),
    );

    const surfaceFor = async (header: string | undefined): Promise<unknown> => {
      const response = await app.request(
        "/",
        header === undefined
          ? undefined
          : { headers: { "x-omnyo-app-surface": header } },
      );

      const body = (await response.json()) as { surface: string };

      return body.surface;
    };

    await expect(surfaceFor("desktop")).resolves.toBe("desktop");
    await expect(surfaceFor("mobile")).resolves.toBe("mobile");
    await expect(surfaceFor(undefined)).resolves.toBe("api");
    await expect(surfaceFor("tv")).resolves.toBe("api");
  });

  it("reads an absent gate header as direct access and any unknown value as anonymous", async () => {
    const app = new Hono();
    app.get("/", (context) => context.json({ kind: getGateAuthKind(context) }));

    const kindFor = async (header: string | undefined): Promise<unknown> => {
      const response = await app.request(
        "/",
        header === undefined
          ? undefined
          : { headers: { "x-omnyo-gate-auth": header } },
      );

      const body = (await response.json()) as { kind: string | null };

      return body.kind;
    };

    await expect(kindFor(undefined)).resolves.toBeNull();
    await expect(kindFor("session")).resolves.toBe("session");
    await expect(kindFor("machine")).resolves.toBe("machine");
    await expect(kindFor("anonymous")).resolves.toBe("anonymous");
    await expect(kindFor("owner")).resolves.toBe("anonymous");
    await expect(kindFor("")).resolves.toBe("anonymous");
  });
});
