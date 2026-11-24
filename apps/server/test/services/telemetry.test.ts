import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  migrate,
  getAppSettings,
  readUsageActors,
} from "@omnyo/db";
import { productUsageReportSchema } from "@omnyo/domain/usage-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryService,
  runWithUsageRequest,
  usageSubject,
  type TelemetryService,
} from "../../src/services/system/telemetry.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const action = {
  name: "thread_created",
  properties: { is_child_thread: false },
} as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function drain(usage: TelemetryService): void {
  const now = Date.now();

  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);

  usage.prune();
  clock.mockRestore();
}

describe("coordinator usage privacy", () => {
  let db: ReturnType<typeof createConnection>;
  let directory: string;
  let server: ReturnType<typeof createServer>;
  let collectorUrl: string;
  let reports: Array<{ path: string; headers: object; body: string }>;
  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    directory = await mkdtemp(join(tmpdir(), "omnyo-usage-"));
    reports = [];
    server = createServer(async (request, response) => {
      let body = "";

      for await (const chunk of request) body += String(chunk);
      reports.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(
        request.url === "/metrics/product-erasure" ? 204 : 200,
      );
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Local collector did not bind");
    collectorUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  });

  const submit = (
    service: TelemetryService,
    proof?: string,
    interactive = true,
  ) =>
    runWithUsageRequest({ proof, interactive }, () => {
      service.capture(action);
      service.capture({
        name: "operation_finished",
        properties: {
          operation: "new_chat",
          outcome: "accepted",
          latency: "under_1s",
        },
      });
    });

  async function service(
    extra: {
      enabled?: boolean;
      countRegion?: string;
      collectorUrl?: string;
    } = {},
  ) {
    return createTelemetryService({
      db,
      dataDir: directory,
      appVersion: "1.2.3",
      enabled: true,
      collectorUrl,
      logger,
      ...extra,
    });
  }

  it("migrates refusal and retires only the old identifier before any capture", async () => {
    db.$client
      .prepare(
        "INSERT INTO app_settings_values (key,value,updated_at) VALUES ('telemetryEnabled','false',1)",
      )
      .run();
    await writeFile(join(directory, "telemetry-id"), "old-id");
    await writeFile(join(directory, "keep"), "keep");
    const usage = await service();
    submit(usage);
    await tick();
    expect(reports).toEqual([]);
    expect(getAppSettings(db).usageConsent).toMatchObject({
      count: "declined",
      product: "declined",
      countSource: "legacy-refusal",
      productSource: "legacy-refusal",
    });
    expect(await readdir(directory)).toEqual(["keep"]);
    expect(readUsageActors(db)).toEqual([]);
  });
  it("requires a trusted US configuration and acknowledged notice for a regional default", async () => {
    const unknown = await service();
    submit(unknown);
    expect(unknown.status().count.effective).toBe(false);
    const us = await service({ countRegion: "US" });
    expect(us.status().count.noticeRequired).toBe(true);
    submit(us);
    await tick();
    expect(reports).toEqual([]);
    us.choose({ purpose: "notice", choice: "granted", source: "settings" });
    submit(us);
    await tick();
    expect(
      reports.filter((row) => row.path === "/metrics/active-week"),
    ).toHaveLength(1);
    expect(us.status().count.reason).toBe("regional-default");
    expect(us.status().product.effective).toBe(false);
  });
  it("sends one constant attempt per newer UTC week across concurrency, restart, refusal and clock rollback", async () => {
    let now = Date.parse("2026-11-23T23:59:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = await service();
    first.choose({ purpose: "count", choice: "granted", source: "cli" });
    await Promise.all(Array.from({ length: 8 }, async () => submit(first)));
    const restarted = await service();
    submit(restarted);
    restarted.choose({ purpose: "count", choice: "declined", source: "cli" });
    restarted.choose({ purpose: "count", choice: "granted", source: "cli" });
    submit(restarted);
    now = Date.parse("2026-11-16T10:00:00Z");
    submit(restarted);
    now = Date.parse("2026-11-30T00:00:00Z");
    submit(restarted);
    await tick();
    const counts = reports.filter((row) => row.path === "/metrics/active-week");
    expect(counts).toHaveLength(2);
    expect(counts[0]).toEqual(counts[1]);
    expect(counts[0]?.body).toBe("");
    expect(counts[0]?.headers).toMatchObject({
      "user-agent": "Omnyo-Usage/1",
      "content-type": "text/plain",
    });
    expect(JSON.stringify(counts)).not.toMatch(
      /cookie|authorization|referer|private-company|timestamp|distinct_id/,
    );
  });
  it("consumes a failed count without retry and excludes boot, noninteractive and children", async () => {
    const failing = await service({ collectorUrl: "http://127.0.0.1:1" });
    failing.choose({ purpose: "count", choice: "granted", source: "sdk" });
    failing.capture({ name: "app_started" });
    submit(failing, undefined, false);
    runWithUsageRequest({ interactive: true }, () =>
      failing.capture({
        ...action,
        properties: { ...action.properties, is_child_thread: true },
      }),
    );
    expect(failing.status().count.attemptedWeek).toBeNull();
    submit(failing);
    await tick();
    const restored = await service();
    submit(restored);
    await tick();
    expect(reports).toEqual([]);
    expect(restored.status().count.attemptedWeek).not.toBeNull();
  });
  it("requires a separate actor proof, sends bounded daily fields, withdraws immediately and rotates on regrant", async () => {
    const usage = await service();

    const granted = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "settings",
    });

    if (!granted.proof) throw new Error("Expected actor proof");
    submit(usage);
    submit(usage, "a".repeat(64));
    submit(usage, granted.proof);
    submit(usage, granted.proof);
    expect(reports).toEqual([]);
    drain(usage);
    await tick();

    const payloads = reports
      .filter((row) => row.path === "/metrics/product")
      .map((row) => productUsageReportSchema.parse(JSON.parse(row.body)));

    expect(payloads).toHaveLength(3);
    expect(
      payloads.every((row) => row.subject === usageSubject(granted.proof!)),
    ).toBe(true);
    expect(payloads.find((row) => row.event === "activity")).toMatchObject({
      properties: { first: true },
    });
    expect(
      payloads.filter((row) => row.event === "first_accepted_action"),
    ).toMatchObject([{ properties: { since_grant: "under_1m" }, count: 1 }]);
    expect(JSON.stringify(payloads)).not.toContain("private-company-slug");
    expect(JSON.stringify(payloads)).not.toContain(granted.proof);
    expect(
      payloads
        .filter((row) => row.event === "operation")
        .map((row) => row.count),
    ).toEqual([2]);
    expect(payloads.find((row) => row.event === "operation")).toMatchObject({
      properties: { latency: "under_1s" },
    });
    usage.choose(
      { purpose: "product", choice: "declined", source: "settings" },
      granted.proof,
    );
    submit(usage, granted.proof);
    await tick();
    expect(reports).toHaveLength(3);
    const restarted = await service();
    submit(restarted, granted.proof);
    await tick();
    expect(reports).toHaveLength(3);

    const regrant = restarted.choose(
      { purpose: "product", choice: "granted", source: "settings" },
      granted.proof,
    );

    expect(regrant.proof).not.toBe(granted.proof);
    const erased = await restarted.erase(granted.proof);
    expect(erased.product.erasure).toBe("complete");
    expect(reports.at(-1)).toMatchObject({
      path: "/metrics/product-erasure",
      body: JSON.stringify({ proof: granted.proof }),
    });
  });
  it("never creates a subject in a hard-disabled channel and rejects unregistered fields", async () => {
    const usage = await service({ enabled: false });
    expect(
      usage.choose({ purpose: "product", choice: "granted", source: "sdk" })
        .proof,
    ).toBeUndefined();
    usage.choose({ purpose: "count", choice: "granted", source: "sdk" });
    submit(usage);
    await tick();
    expect(reports).toEqual([]);
    expect(readUsageActors(db)).toEqual([]);
    expect(
      productUsageReportSchema.safeParse({
        count: 1,
        subject: "a".repeat(64),
        day: "2026-11-24",
        event: "activity",
        properties: { first: true },
        private: "not-allowed",
      }).success,
    ).toBe(false);
  });
  it("keeps client withdrawals and purpose refusals independent and prunes local old records", async () => {
    const usage = await service();
    usage.choose({ purpose: "count", choice: "declined", source: "cli" });

    const a = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    const b = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "settings",
    });

    if (!a.proof || !b.proof) throw new Error("Expected two client proofs");
    usage.choose(
      { purpose: "product", choice: "declined", source: "sdk" },
      a.proof,
    );
    expect(usage.status(a.proof).product.effective).toBe(false);
    expect(usage.status(b.proof).product.effective).toBe(true);
    expect(usage.status().count.reason).toBe("declined");
    expect(getAppSettings(db).usageConsent.countSource).toBe("cli");
    submit(usage, b.proof);
    await tick();
    const stored = readUsageActors(db);
    expect(
      stored.find((row) => row.subject === usageSubject(b.proof!))?.keys.length,
    ).toBeGreaterThan(0);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 86400000);
    usage.prune();
    expect(
      readUsageActors(db).some((row) => row.subject === usageSubject(a.proof!)),
    ).toBe(false);
    expect(readUsageActors(db)[0]?.keys).toEqual([]);
    expect(usage.status(b.proof).product.effective).toBe(true);
  });

  it("reports only reviewed public listing keys on explicit interactive installs", async () => {
    const usage = await service();

    const granted = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    const install = (
      pluginId: string,
      provenance: "builtin" | "direct",
      interactive = true,
    ) =>
      runWithUsageRequest({ proof: granted.proof, interactive }, () =>
        usage.capture({
          name: "plugin_installed",
          properties: {
            plugin_id: pluginId,
            provenance,
            marketplace: null,
            source_kind: "builtin",
          },
        }),
      );

    install("workspace-github", "builtin");
    install("sentry", "builtin");
    install("private-business", "builtin");
    install("sentry", "direct");
    install("workspace-github", "builtin", false);
    drain(usage);
    await tick();

    const listings = reports
      .filter((row) => row.path === "/metrics/product")
      .map((row) => productUsageReportSchema.parse(JSON.parse(row.body)))
      .filter((row) => row.event === "public_plugin_installed");

    expect(listings.map((row) => row.properties.listing)).toEqual([
      "workspace-github",
      "sentry",
    ]);
    expect(JSON.stringify(reports)).not.toContain("private-business");
  });
  it("requires a collector acknowledgment for erasure even when local grant history is absent", async () => {
    const usage = await service();
    const unknown = await usage.erase("e".repeat(64));
    expect(unknown.product.erasure).toBe("complete");
    expect(reports.at(-1)?.path).toBe("/metrics/product-erasure");
    const unavailable = await service({ collectorUrl: "http://127.0.0.1:1" });
    expect((await unavailable.erase("f".repeat(64))).product.erasure).toBe(
      "pending",
    );
  });
  it("withdraws only the matching actor while count and other client requests continue", async () => {
    const usage = await service();
    usage.choose({ purpose: "count", choice: "granted", source: "sdk" });

    const a = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    const b = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    if (!a.proof || !b.proof) throw new Error("Expected actor proofs");
    const requests: Array<{ subject: string | null; signal: AbortSignal }> = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init: RequestInit) => {
      const signal = init.signal;

      if (!signal) throw new Error("Expected abort signal");
      requests.push({
        subject:
          init.body === "" ? null : JSON.parse(String(init.body)).subject,
        signal,
      });

      return new Promise<Response>((resolve) =>
        signal.addEventListener(
          "abort",
          () => resolve(new Response(null, { status: 204 })),
          { once: true },
        ),
      );
    });
    submit(usage, a.proof);
    submit(usage, b.proof);
    drain(usage);
    usage.setEnabled(true);
    expect(requests.every((request) => !request.signal.aborted)).toBe(true);
    usage.choose(
      { purpose: "product", choice: "declined", source: "sdk" },
      a.proof,
    );
    expect(
      requests
        .filter((request) => request.subject === usageSubject(a.proof!))
        .every((request) => request.signal.aborted),
    ).toBe(true);
    expect(
      requests
        .filter(
          (request) =>
            request.subject === null ||
            request.subject === usageSubject(b.proof!),
        )
        .every((request) => !request.signal.aborted),
    ).toBe(true);
    usage.stop();
  });
  it("reports only closed onboarding failure reasons and maps legacy failures to unknown", async () => {
    const usage = await service();

    const grant = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    runWithUsageRequest({ interactive: true, proof: grant.proof }, () => {
      usage.capture({
        name: "onboarding_sign_in",
        properties: {
          entry: "first_run",
          outcome: "failed",
          failure_reason: "nonzero_exit",
        },
      });
      usage.capture({
        name: "onboarding_sign_in",
        properties: {
          entry: "first_run",
          outcome: "failed",
          failure_reason: "start_rejected",
        },
      });
      usage.capture({
        name: "onboarding_sign_in",
        properties: { entry: "first_run", outcome: "failed" },
      });
    });
    drain(usage);
    await tick();

    const failures = reports
      .map((report) => productUsageReportSchema.parse(JSON.parse(report.body)))
      .filter((report) => report.event === "operation");

    expect(failures.map((report) => report.properties.failure_reason)).toEqual([
      "nonzero_exit",
      "start_rejected",
      "unknown",
    ]);
  });
  it("drops queued analytics on withdrawal and does not replay an unflushed batch after restart", async () => {
    const usage = await service();

    const grant = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    if (!grant.proof) throw new Error("Expected actor proof");
    submit(usage, grant.proof);
    expect(reports).toEqual([]);
    usage.choose(
      { purpose: "product", choice: "declined", source: "sdk" },
      grant.proof,
    );
    drain(usage);
    await tick();
    expect(reports).toEqual([]);

    const next = usage.choose(
      { purpose: "product", choice: "granted", source: "sdk" },
      grant.proof,
    );

    if (!next.proof) throw new Error("Expected new actor proof");
    submit(usage, next.proof);
    usage.stop();
    const restarted = await service();
    drain(restarted);
    await tick();
    expect(reports).toEqual([]);
  });
  it("retains separate consecutive-day aggregates when midnight activity precedes the sweep", async () => {
    let now = Date.parse("2026-11-24T23:59:58Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const usage = await service();

    const grant = usage.choose({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });

    const capture = () =>
      runWithUsageRequest({ interactive: true, proof: grant.proof }, () =>
        usage.capture({
          name: "onboarding_step_reached",
          properties: { step: "agent", entry: "first_run" },
        }),
      );

    capture();
    capture();
    now = Date.parse("2026-11-25T00:00:01Z");
    capture();
    usage.prune();
    await tick();

    const payloads = reports.map((row) =>
      productUsageReportSchema.parse(JSON.parse(row.body)),
    );

    expect(payloads.map((row) => [row.day, row.count])).toEqual([
      ["2026-11-24", 2],
      ["2026-11-25", 1],
    ]);
    expect(readUsageActors(db)[0]?.keys[0]?.sentCount).toBe(1);
  });
});
