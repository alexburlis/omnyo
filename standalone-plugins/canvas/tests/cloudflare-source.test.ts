import { sourceMigrations } from "../lib/storage.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { sourceInputSchema, type SourceInput, type SourceJson } from "../source-contract";
import {
  SourceService,
  cloudflareVariables,
  cloudflareWindow,
  loadSource,
  type LoadedSource,
  type SourceAccess,
  type SourceLoader,
  type SourceRequest,
  type SourceTransport,
} from "../lib/sources";

const access: SourceAccess = {
  gscBroker: "",
  posthogOrigin: "https://eu.posthog.com",
  mcpOrigins: [],
};

const query =
  'query($zoneTag: String!, $start: Time!, $end: Time!) { viewer { zones(filter: {zoneTag: $zoneTag}) { series: httpRequestsAdaptiveGroups(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end, clientRequestPath: "/api/$notAVariable"}) { count dimensions { datetimeHour } } } } }';

function cloudflareSource(
  config: Record<string, SourceJson> = {},
): Extract<SourceInput, { provider: "cloudflare" }> {
  const result = sourceInputSchema.parse({
    id: "edge",
    title: "Edge requests",
    provider: "cloudflare",
    intervalSeconds: 300,
    config: {
      zoneTag: "023e105f4ecef8ad9ca31a8372d0c353",
      query,
      rollingHours: 24,
      rowsPath: ["series"],
      columns: [
        { key: "hour", label: "Hour", type: "string", path: ["dimensions", "datetimeHour"] },
        { key: "requests", label: "Requests", type: "number", path: ["count"] },
      ],
      credential: "apiToken1",
      ...config,
    },
  });

  if (result.provider !== "cloudflare") throw new Error("Expected Cloudflare source");

  return result;
}

function transportFor(reply: SourceJson, status = 200) {
  const calls: Array<{ url: string; request: SourceRequest }> = [];

  const transport: SourceTransport = {
    lookup: vi.fn(async () => [{ address: "104.16.132.229", family: 4 }]),
    request: vi.fn(async (url: URL, request: SourceRequest) => {
      calls.push({ url: url.href, request });

      return {
        status,
        headers: { "content-type": "application/json" },
        body: (async function* () {
          yield Buffer.from(JSON.stringify(reply));
        })(),
        discard() {},
      };
    }),
  };

  return { transport, calls };
}

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  vi.useRealTimers();

  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function service(loader: SourceLoader) {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  host.api.storage.migrate(host.api.storage.database(), sourceMigrations);
  host.api.storage
    .database()
    .exec(
      "CREATE TABLE canvas_threads(thread_id TEXT PRIMARY KEY,enabled INTEGER); INSERT INTO canvas_threads VALUES('thread',1);",
    );

  return { host, sources: new SourceService(host.api, loader) };
}

describe("Cloudflare analytics sources", () => {
  it("accepts only one read-only query that uses the supplied window variables", () => {
    const base = cloudflareSource();

    for (const bad of [
      "mutation { purge }",
      "query($zoneTag: String!) { viewer { zones(filter: {zoneTag: $zoneTag}) { a: x { count } } } } mutation { purge }",
      "query($zoneTag: String!, $since: Time!) { viewer { zones(filter: {zoneTag: $zoneTag}) { a: x(filter: {datetime_geq: $since}) { count } } } }",
      "fragment F on Zone { x } query { viewer { zones { ...F } } }",
    ])
      expect(
        sourceInputSchema.safeParse({ ...base, config: { ...base.config, query: bad } }).success,
      ).toBe(false);

    expect(
      sourceInputSchema.safeParse({ ...base, config: { ...base.config, zoneTag: "example.com" } })
        .success,
    ).toBe(false);
    expect(
      sourceInputSchema.safeParse({ ...base, config: { ...base.config, credential: undefined } })
        .success,
    ).toBe(false);
    expect(cloudflareSource().config.alignTo).toBe("hour");
  });

  it("rolls complete hours or minutes and sends only the declared variables", () => {
    const now = Date.parse("2026-11-21T13:47:31.250Z");
    const hourly = cloudflareSource({ rollingHours: 72 }).config;

    expect(cloudflareWindow(hourly, now)).toEqual({
      start: "2026-11-18T13:00:00Z",
      end: "2026-11-21T13:00:00Z",
      startDate: "2026-11-18",
      endDate: "2026-11-21",
    });
    expect(
      cloudflareWindow(cloudflareSource({ rollingHours: 1, alignTo: "minute" }).config, now),
    ).toMatchObject({
      start: "2026-11-21T12:47:00Z",
      end: "2026-11-21T13:47:00Z",
    });
    expect(cloudflareVariables(hourly, now)).toEqual({
      zoneTag: "023e105f4ecef8ad9ca31a8372d0c353",
      start: "2026-11-18T13:00:00Z",
      end: "2026-11-21T13:00:00Z",
    });
  });

  it("posts the query to Cloudflare's analytics endpoint and maps the zone rows", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-21T13:05:00Z"), toFake: ["Date"] });

    const { transport, calls } = transportFor({
      data: {
        viewer: {
          zones: [
            {
              series: [
                { count: 31101, dimensions: { datetimeHour: "2026-11-21T11:00:00Z" } },
                { count: 32352, dimensions: { datetimeHour: "2026-11-21T12:00:00Z" } },
              ],
            },
          ],
        },
      },
      errors: null,
    });

    const result = await loadSource(
      cloudflareSource(),
      "Bearer synthetic-test-credential",
      undefined,
      access,
      undefined,
      transport,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(calls[0]?.request.method).toBe("POST");
    expect(calls[0]?.request.headers.Authorization).toBe("Bearer synthetic-test-credential");
    expect(JSON.parse(calls[0]?.request.body ?? "null")).toEqual({
      query,
      variables: {
        zoneTag: "023e105f4ecef8ad9ca31a8372d0c353",
        start: "2026-11-20T13:00:00Z",
        end: "2026-11-21T13:00:00Z",
      },
    });
    expect(result.rows).toEqual([
      { hour: "2026-11-21T11:00:00Z", requests: 31101 },
      { hour: "2026-11-21T12:00:00Z", requests: 32352 },
    ]);
    expect(result.provenance).toMatchObject({
      timezone: "UTC",
      windowLabel: "2026-11-20 13:00–2026-11-21 13:00 UTC",
    });
  });

  it("reports GraphQL errors, empty zones and a missing token without calling or exposing the token", async () => {
    const rejected = transportFor({
      data: null,
      errors: [{ message: "zone does not have access to the field 'clientAsn'" }],
    });

    await expect(
      loadSource(
        cloudflareSource(),
        "Bearer synthetic-test-credential",
        undefined,
        access,
        undefined,
        rejected.transport,
      ),
    ).rejects.toThrow(
      "Cloudflare rejected the query: zone does not have access to the field 'clientAsn'",
    );

    const empty = transportFor({ data: { viewer: { zones: [] } } });

    await expect(
      loadSource(
        cloudflareSource(),
        "Bearer synthetic-test-credential",
        undefined,
        access,
        undefined,
        empty.transport,
      ),
    ).rejects.toThrow("Cloudflare returned no zone");

    const unused = transportFor({});

    await expect(
      loadSource(cloudflareSource(), null, undefined, access, undefined, unused.transport),
    ).rejects.toThrow("Approve a Cloudflare API token");
    expect(unused.calls).toHaveLength(0);
  });

  it("uses the slot token only when the owner approved Cloudflare's API origin for it", async () => {
    const data: LoadedSource = {
      columns: [{ key: "requests", label: "Requests", type: "number" }],
      rows: [{ requests: 1 }],
    };

    const loader = vi.fn<SourceLoader>(async () => data);
    const { sources, host } = service(loader);

    await host.harness.behavior.setSettings({
      apiOrigin1: "https://owned.example.com",
      apiToken1: "synthetic-test-credential",
    });
    sources.upsert("thread", cloudflareSource());
    const refused = await sources.refresh("thread", "edge");
    expect(refused.source.error).toContain("not approved");
    expect(loader).not.toHaveBeenCalled();
    expect(JSON.stringify(refused)).not.toContain("synthetic-test-credential");

    await host.harness.behavior.setSettings({
      apiOrigin1: "https://api.cloudflare.com",
      apiToken1: "synthetic-test-credential",
    });
    const loaded = await sources.refresh("thread", "edge");
    expect(loaded.source.status).toBe("ready");
    expect(loader).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cloudflare" }),
      "Bearer synthetic-test-credential",
      expect.anything(),
      expect.anything(),
    );
    expect(JSON.stringify(loaded)).not.toContain("synthetic-test-credential");
  });
});
