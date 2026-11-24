import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { ANALYTICS_CONSENT_COOKIE, SITE_USAGE_PATH } from "./config";
import { handleAnalyticsRoute, type AnalyticsRouteOptions } from "./server";

interface Forwarded {
  url: string;
  options: RequestInit | undefined;
}

function upstream() {
  const calls: Forwarded[] = [];

  const fetch: typeof globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), options });

    return new Response(null, { status: 204 });
  };

  return {
    calls,
    options: { fetch, collectorOrigin: "https://collector.test" },
  };
}

function request(
  overrides: {
    headers?: Record<string, string | undefined>;
    body?: string;
    url?: string;
  } = {},
) {
  const headers = new Headers({
    "content-type": "application/json",
    cookie: `${ANALYTICS_CONSENT_COOKIE}=accepted:${Date.now()}; session=private-session`,
    origin: "https://omnyohq.com",
    referer: "https://omnyohq.com/explore?q=PRIVATE_QUERY",
    authorization: "Bearer PRIVATE_TOKEN",
    "user-agent": "PRIVATE_BROWSER",
    "x-forwarded-for": "198.51.100.7, 203.0.113.9",
    "x-real-ip": "198.51.100.7",
  });

  for (const [key, value] of Object.entries(overrides.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  return new Request(overrides.url ?? `https://omnyohq.com${SITE_USAGE_PATH}`, {
    method: "POST",
    headers,
    body:
      overrides.body ??
      JSON.stringify({ event: { name: "marketplace_results", count: "1-5" } }),
  });
}

describe("website usage boundary", () => {
  it("serializes only the approved fields and server-generated headers", async () => {
    const { calls, options } = upstream();
    expect((await handleAnalyticsRoute(request(), options))?.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://collector.test/metrics/site-events");
    expect(calls[0]?.options?.body).toBe(
      '{"event":{"name":"marketplace_results","count":"1-5"}}',
    );
    expect([...new Headers(calls[0]?.options?.headers)]).toEqual([
      ["content-type", "application/json"],
      ["user-agent", "Omnyo-Site-Usage/1"],
    ]);
    expect(calls[0]?.options).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
  });

  it("accepts the internal HTTP URL used behind the HTTPS ingress", async () => {
    const { calls, options } = upstream();
    expect(
      (
        await handleAnalyticsRoute(
          request({ url: `http://omnyohq.com${SITE_USAGE_PATH}` }),
          options,
        )
      )?.status,
    ).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it.each([
    { cookie: "" },
    { cookie: `omnyo_analytics_consent_v1=accepted:${Date.now()}` },
    { cookie: `${ANALYTICS_CONSENT_COOKIE}=accepted:1` },
    { cookie: `${ANALYTICS_CONSENT_COOKIE}=accepted:${Date.now() + 60000}` },
    { cookie: `${ANALYTICS_CONSENT_COOKIE}=accepted:bad` },
    { cookie: `${ANALYTICS_CONSENT_COOKIE}=rejected:${Date.now()}` },
    {
      cookie: `${ANALYTICS_CONSENT_COOKIE}=accepted:${Date.now()}; ${ANALYTICS_CONSENT_COOKIE}=rejected:${Date.now()}`,
    },
    { dnt: "1" },
    { "sec-gpc": "1" },
    { origin: "https://other.test" },
    { origin: "" },
  ])("refuses a missing, obsolete or objected grant: %j", async (headers) => {
    const { calls, options } = upstream();
    expect(
      (await handleAnalyticsRoute(request({ headers }), options))?.status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { event: { name: "pageview", route: "home" } },
    { event: { name: "route_view", route: "/private-slug" } },
    {
      event: {
        name: "marketplace_results",
        count: "1-5",
        query: "PRIVATE_QUERY",
      },
    },
    {
      event: {
        name: "listing_open",
        kind: "skill",
        catalogKey: "PRIVATE_SLUG",
      },
    },
    { event: { name: "download_click", os: "secret-os" } },
    {
      event: { name: "route_view", route: "home" },
      subject: "private-subject",
    },
  ])("rejects forbidden payload fields: %j", async (body) => {
    const { calls, options } = upstream();
    expect(
      (
        await handleAnalyticsRoute(
          request({ body: JSON.stringify(body) }),
          options,
        )
      )?.status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each(["not-json", "x".repeat(1025)])(
    "rejects invalid or oversized bodies",
    async (body) => {
      const { calls, options } = upstream();
      expect(
        (await handleAnalyticsRoute(request({ body }), options))?.status,
      ).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects query strings and foreign hostnames", async () => {
    const { calls, options } = upstream();
    expect(
      (
        await handleAnalyticsRoute(
          request({ url: `https://omnyohq.com${SITE_USAGE_PATH}?private=1` }),
          options,
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await handleAnalyticsRoute(
          request({ url: `https://other.test${SITE_USAGE_PATH}` }),
          options,
        )
      )?.status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    "/ox",
    "/ox/e/",
    "/ox/s/",
    "/ox/flags",
    "/ox/array/key/config",
    "/ox/static/array.js",
  ])("retires SDK route %s without forwarding", async (path) => {
    const { calls, options } = upstream();
    expect(
      (
        await handleAnalyticsRoute(
          new Request(`https://omnyohq.com${path}`),
          options,
        )
      )?.status,
    ).toBe(410);
    expect(calls).toHaveLength(0);
  });

  it("leaves diagnostics and normal routes to their own owners", async () => {
    const { calls, options } = upstream();
    expect(
      await handleAnalyticsRoute(
        new Request("https://omnyohq.com/privacy"),
        options,
      ),
    ).toBeNull();
    expect(
      await handleAnalyticsRoute(
        new Request("https://omnyohq.com/api/errors"),
        options,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("fails visibly without a configured collector and does not pretend to capture", async () => {
    const { calls, options } = upstream();
    expect(
      (
        await handleAnalyticsRoute(request(), {
          ...options,
          collectorOrigin: undefined,
        })
      )?.status,
    ).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("does not forward an aborted request", async () => {
    const { calls, options } = upstream();
    const controller = new AbortController();
    const original = request();
    const aborted = new Request(original, { signal: controller.signal });
    controller.abort();
    expect((await handleAnalyticsRoute(aborted, options))?.status).toBe(499);
    expect(calls).toHaveLength(0);
  });

  it("does not retry a failed collector", async () => {
    let attempts = 0;

    const options: AnalyticsRouteOptions = {
      collectorOrigin: "https://collector.test",
      fetch: async () => {
        attempts += 1;
        throw new TypeError("synthetic failure");
      },
    };

    expect((await handleAnalyticsRoute(request(), options))?.status).toBe(502);
    expect(attempts).toBe(1);
  });

  it("verifies actual bytes at a loopback HTTP recipient", async () => {
    const received: Array<{
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];

    const server = createServer(async (incoming, response) => {
      let body = "";

      for await (const chunk of incoming) body += chunk.toString();
      received.push({ headers: incoming.headers, body });
      response.writeHead(204).end();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("No loopback address");

      const result = await handleAnalyticsRoute(request(), {
        fetch: globalThis.fetch,
        collectorOrigin: `http://127.0.0.1:${address.port}`,
      });

      expect(result?.status).toBe(204);
      expect(received).toHaveLength(1);
      expect(received[0]?.body).toBe(
        '{"event":{"name":"marketplace_results","count":"1-5"}}',
      );
      const serialized = JSON.stringify(received);

      for (const secret of [
        "PRIVATE_QUERY",
        "PRIVATE_TOKEN",
        "PRIVATE_BROWSER",
        "198.51.100.7",
        "203.0.113.9",
        "private-session",
        "omnyohq.com",
      ])
        expect(serialized).not.toContain(secret);

      for (const header of [
        "cookie",
        "origin",
        "referer",
        "authorization",
        "x-forwarded-for",
        "x-real-ip",
      ])
        expect(received[0]?.headers[header]).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("consent default", () => {
  it("asks everyone first and stays private", async () => {
    const response = await handleAnalyticsRoute(
      new Request("https://omnyohq.com/api/consent-default"),
      upstream().options,
    );

    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.json()).toEqual({ choice: null });
  });
  it.each(["sec-gpc", "dnt"])("honors %s", async (header) => {
    const response = await handleAnalyticsRoute(
      new Request("https://omnyohq.com/api/consent-default", {
        headers: { [header]: "1" },
      }),
      upstream().options,
    );

    expect(await response?.json()).toEqual({ choice: "rejected" });
  });
});
