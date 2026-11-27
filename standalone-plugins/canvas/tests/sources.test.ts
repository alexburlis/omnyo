import { sourceMigrations } from "../lib/storage.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { datasetSchema, sourceInputSchema, type SourceInput } from "../source-contract";
import {
  SourceError,
  SourceService,
  isPublicAddress,
  gscWindow,
  jsonDataset,
  loadSource,
  publicSourceUrl,
  type LoadedSource,
  type SourceLoader,
  type SourceBrokerRunner,
} from "../lib/sources";

const hosts: FakePluginHost[] = [];

const data: LoadedSource = {
  columns: [
    { key: "day", label: "Day", type: "string" },
    { key: "clicks", label: "Clicks", type: "number" },
  ],
  rows: [{ day: "2026-10-31", clicks: 245 }],
};

function fixture(loader?: SourceLoader) {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  host.api.storage.migrate(host.api.storage.database(), sourceMigrations);
  host.api.storage
    .database()
    .exec(
      "CREATE TABLE canvas_threads(thread_id TEXT PRIMARY KEY,enabled INTEGER); INSERT INTO canvas_threads VALUES('thread',1); CREATE TABLE authored_state(value TEXT); INSERT INTO authored_state VALUES('manual title and layout');",
    );

  return { host, sources: new SourceService(host.api, loader) };
}

function source(id = "search"): Extract<SourceInput, { provider: "json" }> {
  const result = sourceInputSchema.parse({
    id,
    title: "Search",
    provider: "json",
    config: { url: "https://api.example.com/analytics", columns: data.columns },
    provenance: {
      windowLabel: "2026-10-31",
      timezone: "America/Los_Angeles",
      cohort: "Google web clicks, not visitors",
    },
  });

  if (result.provider !== "json") throw new Error("Expected JSON source");

  return result;
}

function pending() {
  let complete: ((value: LoadedSource) => void) | undefined;

  const promise = new Promise<LoadedSource>((resolve) => {
    complete = resolve;
  });

  return {
    promise,
    complete(value: LoadedSource) {
      if (!complete) throw Error("Missing resolver");
      complete(value);
    },
  };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

it("runs Search Console with its supported Python runtime and reports subprocess failures safely", async () => {
  const broker = vi.fn<SourceBrokerRunner>();

  const input = sourceInputSchema.parse({
    id: "search-console",
    title: "Search Console",
    provider: "gsc",
    config: {
      siteUrl: "sc-domain:example.com",
      startDate: "2026-10-31",
      endDate: "2026-10-31",
      dimensions: ["page"],
    },
  });

  broker.mockResolvedValue({
    stdout: JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ ok: true, data: { rows: [] } }) }],
    }),
    stderr: "",
  });

  const access = {
    gscBroker: "/opt/example/bin/mcp-call",
    posthogOrigin: "https://eu.posthog.com",
    mcpOrigins: [],
  };

  await expect(
    loadSource(input, null, undefined, { ...access, gscBroker: " " }, broker),
  ).rejects.toThrow("Search Console sources need a broker command in Canvas plugin settings");
  expect(broker).not.toHaveBeenCalled();

  await expect(loadSource(input, null, undefined, access, broker)).resolves.toMatchObject({
    rows: [],
    columns: [
      { key: "page", label: "Page", type: "string" },
      { key: "clicks", label: "Clicks", type: "number" },
      { key: "impressions", label: "Impressions", type: "number" },
      { key: "ctr", label: "Click-through rate", type: "number", format: "percent" },
      { key: "position", label: "Avg. position", type: "number" },
    ],
  });
  expect(broker).toHaveBeenCalledWith(
    "/opt/example/bin/mcp-call",
    ["gsc", "gsc.query_search_analytics", expect.any(String), "--json"],
    expect.objectContaining({
      env: {
        HOME: expect.any(String),
        PATH: expect.stringContaining(":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"),
      },
    }),
  );

  broker.mockRejectedValue(
    Object.assign(new Error("private-provider-diagnostic"), {
      code: 1,
      stderr: "private-provider-diagnostic",
    }),
  );
  await expect(loadSource(input, null, undefined, access, broker)).rejects.toThrow(
    "Search Console broker failed (exit 1); check its runtime and connection",
  );
});

it("preserves declared column formats through JSON and agent-pushed datasets", () => {
  const columns = [
    { key: "ctr", label: "Click-through rate", type: "number", format: "percent" },
  ] as const;

  const json = sourceInputSchema.parse({
    id: "rate",
    title: "Click-through rate",
    provider: "json",
    config: { url: "https://api.example.com/metrics", columns },
  });

  if (json.provider !== "json") throw Error("Expected JSON source");
  const normalized = jsonDataset([{ ctr: 0.086 }], json);
  expect(normalized.columns).toEqual(columns);
  const { sources } = fixture();
  sources.upsert(
    "thread",
    sourceInputSchema.parse({ id: "rate", title: "Click-through rate", provider: "manual" }),
  );
  const pushed = sources.push("thread", { sourceId: "rate", ...normalized });
  expect(pushed.dataset?.columns).toEqual(columns);

  const changed = sources.push("thread", {
    sourceId: "rate",
    rows: normalized.rows,
    columns: [{ key: "ctr", label: "Click-through rate", type: "number", format: "number" }],
  });

  expect(changed.dataset?.revision).toBe(2);
});

describe("source isolation and refresh", () => {
  it("pushes normalized agent datasets and only changes content revisions when facts change", () => {
    const { sources } = fixture();

    const input = sourceInputSchema.parse({
      id: "inventory",
      title: "Accounts",
      provider: "manual",
    });

    sources.upsert("thread", input);
    const first = sources.push("thread", { sourceId: "inventory", ...data, capturedAt: 10 });
    const identical = sources.push("thread", { sourceId: "inventory", ...data, capturedAt: 20 });
    expect(first.dataset?.revision).toBe(1);
    expect(identical.dataset?.revision).toBe(1);
    expect(identical.dataset?.capturedAt).toBe(20);

    const changed = sources.push("thread", {
      sourceId: "inventory",
      ...data,
      rows: [{ day: "2026-10-31", clicks: 246 }],
    });

    expect(changed.dataset?.revision).toBe(2);
    expect(sourceInputSchema.safeParse({ ...input, intervalSeconds: 60 }).success).toBe(false);
  });

  it("refreshes data without touching authored state and preserves revision for identical polls", async () => {
    const { sources, host } = fixture(async () => data);
    sources.upsert("thread", source());
    const first = await sources.refresh("thread", "search");
    const again = await sources.refresh("thread", "search");
    expect(again.dataset?.revision).toBe(first.dataset?.revision);
    expect(again.source.status).toBe("ready");
    expect(again.dataset?.provenance.cohort).toContain("not visitors");
    expect(
      host.api.storage.database().prepare("SELECT value FROM authored_state").pluck().get(),
    ).toBe("manual title and layout");
  });

  it("ignores object property order when comparing refreshed facts", async () => {
    let alternate = false;

    const { sources } = fixture(async () =>
      alternate
        ? {
            ...data,
            rows: [{ clicks: 245, day: "2026-10-31" }],
            provenance: { cohort: "Google clicks", timezone: "UTC", windowLabel: "2026-10-31" },
          }
        : {
            ...data,
            provenance: { windowLabel: "2026-10-31", timezone: "UTC", cohort: "Google clicks" },
          },
    );

    sources.upsert("thread", source());
    const first = await sources.refresh("thread", "search");
    alternate = true;
    const second = await sources.refresh("thread", "search");
    expect(second.dataset?.revision).toBe(first.dataset?.revision);
  });

  it("deduplicates simultaneous requests and detects configuration ABA", async () => {
    const deferred = pending();
    const loader = vi.fn<SourceLoader>(async () => deferred.promise);
    const { sources } = fixture(loader);
    const input = source();
    sources.upsert("thread", input);
    const first = sources.refresh("thread", "search");
    const second = sources.refresh("thread", "search");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    sources.upsert("thread", { ...input, title: "Alternative" });
    sources.upsert("thread", input);
    deferred.complete(data);
    const result = await first;
    expect(result.source.status).toBe("error");
    expect(result.source.error).toContain("changed during refresh");
    expect(result.dataset).toBeNull();
  });

  it("retains historical data on failure without exposing provider diagnostics", async () => {
    let fail = false;

    const { sources } = fixture(async () => {
      if (fail) throw Error("private-provider-diagnostic");

      return data;
    });

    sources.upsert("thread", { ...source(), intervalSeconds: 60 });
    const first = await sources.refresh("thread", "search");
    fail = true;
    const failed = await sources.refresh("thread", "search");
    expect(failed.dataset).toEqual(first.dataset);
    expect(failed.source.lastSuccessAt).toBe(first.source.lastSuccessAt);
    expect(failed.source.status).toBe("error");
    expect(failed.source.error).not.toContain("private-provider-diagnostic");
    expect(failed.source.nextRefreshAt).toBeGreaterThan(Date.now() + 100000);
  });

  it("does not resurrect sources removed during an in-flight refresh", async () => {
    const deferred = pending();
    let signal: AbortSignal | undefined;

    const loader: SourceLoader = async (_definition, _authorization, inputSignal) => {
      signal = inputSignal;

      return deferred.promise;
    };

    const { sources } = fixture(loader);
    sources.upsert("thread", source());
    const refresh = sources.refresh("thread", "search");
    await vi.waitFor(() => expect(signal).toBeDefined());
    sources.remove("thread");
    expect(signal?.aborted).toBe(true);
    deferred.complete(data);
    await expect(refresh).rejects.toThrow("removed during refresh");
    expect(sources.list("thread")).toEqual([]);
  });

  it("polls only enabled due boards and stops when paused", async () => {
    const loader = vi.fn<SourceLoader>(async () => data);
    const { sources, host } = fixture(loader);
    sources.upsert("thread", { ...source(), intervalSeconds: 60 });
    const db = host.api.storage.database();
    db.exec("UPDATE canvas_sources SET next_refresh_at=0; UPDATE canvas_threads SET enabled=0");
    await sources.poll();
    expect(loader).not.toHaveBeenCalled();
    db.exec("UPDATE canvas_threads SET enabled=1");
    await sources.poll();
    expect(loader).toHaveBeenCalledOnce();
    await sources.poll();
    expect(loader).toHaveBeenCalledOnce();
    const paused = sources.pause("thread", "search", true);
    expect(paused.source.nextRefreshAt).toBeNull();
  });

  it("retries failed sources at once when polling resumes after the host slept", async () => {
    let fail = true;

    const loader = vi.fn<SourceLoader>(async () => {
      if (fail) throw Error("offline");

      return data;
    });

    const { sources } = fixture(loader);
    sources.upsert("thread", { ...source(), intervalSeconds: 60 });
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const start = Date.now();
      await sources.refresh("thread", "search");
      await sources.refresh("thread", "search");
      await sources.refresh("thread", "search");
      await sources.poll();
      vi.setSystemTime(start + 60000);
      await sources.poll();
      expect(loader).toHaveBeenCalledTimes(3);
      fail = false;
      vi.setSystemTime(start + 260000);
      await sources.poll();
      expect(loader).toHaveBeenCalledTimes(4);
      expect(sources.get("thread", "search")?.source).toMatchObject({
        status: "ready",
        failures: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects credentials on a different origin before invoking a provider", async () => {
    const loader = vi.fn<SourceLoader>(async () => data);
    const { sources, host } = fixture(loader);
    await host.harness.behavior.setSettings({
      apiOrigin1: "https://owned.example.com",
      apiToken1: "synthetic-test-credential",
    });
    const input = source();

    if (input.provider !== "json") throw Error("Expected JSON source");
    sources.upsert("thread", { ...input, config: { ...input.config, credential: "apiToken1" } });
    const result = await sources.refresh("thread", "search");
    expect(result.source.error).toContain("not approved");
    expect(loader).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic-test-credential");
  });

  it("refuses credential imports until the user approves a reference in settings", async () => {
    const { sources } = fixture();

    await expect(
      sources.importCredential("thread", {
        slot: "posthogToken",
        reference: "op://Vault/PostHog/credential",
      }),
    ).rejects.toThrow("Set this source's address and 1Password reference");
  });

  it("passes the configured PostHog origin and Search Console broker to the loader", async () => {
    const loader = vi.fn<SourceLoader>(async () => data);
    const { sources, host } = fixture(loader);
    await host.harness.behavior.setSettings({
      posthogOrigin: "https://us.posthog.com",
      gscBroker: "~/bin/search-console",
    });
    sources.upsert("thread", source());
    await sources.refresh("thread", "search");
    expect(loader).toHaveBeenCalledWith(expect.anything(), null, expect.anything(), {
      gscBroker: "~/bin/search-console",
      posthogOrigin: "https://us.posthog.com",
      mcpOrigins: [],
    });
  });
});

it("projects declared JSON columns and rejects invalid cells and types", () => {
  const input = source();

  if (input.provider !== "json") throw Error("Expected JSON source");
  const result = jsonDataset([{ day: "2026-10-31", clicks: 245, extra: "omitted" }], input);
  expect(result.rows).toEqual(data.rows);
  expect(() => jsonDataset([{ day: "2026-10-31", clicks: "245" }], input)).toThrow(
    "wrong data type",
  );
  expect(() =>
    datasetSchema.parse({
      sourceId: "search",
      ...data,
      capturedAt: 0,
      revision: 1,
      provenance: {},
      rows: [{ nested: { unsupported: 1 } }],
    }),
  ).toThrow();
});

it("uses maintained IP classification and rejects private or credential-bearing URLs", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("1.1.1.1")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);

  for (const address of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?api_key=secret",
    "https://example.com:8443",
    "https://example.com/#fragment",
  ])
    expect(() => publicSourceUrl(address)).toThrow(SourceError);
});

it("advances rolling Search Console windows in Pacific calendar dates", () => {
  const input = sourceInputSchema.parse({
    id: "rolling",
    title: "Rolling",
    provider: "gsc",
    config: {
      siteUrl: "sc-domain:example.com",
      startDate: "2020-01-01",
      endDate: "2020-01-02",
      rollingDays: 28,
      lagDays: 2,
    },
  });

  if (input.provider !== "gsc") throw Error("Expected GSC");
  expect(gscWindow(input.config, Date.UTC(2026, 10, 3, 20))).toEqual({
    startDate: "2026-10-05",
    endDate: "2026-11-01",
  });
  expect(gscWindow(input.config, Date.UTC(2026, 10, 3, 1))).toEqual({
    startDate: "2026-10-04",
    endDate: "2026-10-31",
  });
});
