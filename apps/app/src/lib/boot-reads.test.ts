// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootPartName, BootResponse } from "@omnyo/server-contract";
import {
  BOOT_REFRESH_WINDOW_MS,
  createBootReads,
  PAGE_BOOT_ACCEPT_MS,
  parseBootOutcome,
  type BootOutcome,
} from "./boot-reads";

const ORIGIN = "https://omnyo.test";

function bootResponse(
  parts: BootResponse["parts"],
  serverIdentity = "a".repeat(64),
): BootResponse {
  return { version: 1, serverIdentity, parts };
}

function okOutcome(parts: BootResponse["parts"]): BootOutcome {
  return { kind: "ok", response: bootResponse(parts), receivedAt: 1_000 };
}

function networkResponse(body: unknown) {
  return vi.fn(async () => Response.json(body));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("boot reads", () => {
  it("answers the first-screen reads from the page-start response without the network", async () => {
    const reads = createBootReads({
      origin: ORIGIN,
      page: {
        startedAt: 0,
        settled: true,
        outcome: Promise.resolve(
          okOutcome({
            hosts: { status: 200, body: [{ id: "host" }] },
            serverMove: { status: 403, body: { code: "forbidden" } },
          }),
        ),
      },
      requestBoot: vi.fn(),
      now: () => 10,
    });

    const network = networkResponse("network");

    const hosts = await reads.serve(
      `${ORIGIN}/api/v1/hosts?includeCreating=false`,
      undefined,
      network,
    );

    const serverMove = await reads.serve(
      `${ORIGIN}/api/v1/server/move`,
      { method: "GET" },
      network,
    );

    expect(hosts?.status).toBe(200);
    expect(await hosts?.json()).toEqual([{ id: "host" }]);
    expect(serverMove?.status).toBe(403);
    expect(await serverMove?.json()).toEqual({ code: "forbidden" });
    expect(network).not.toHaveBeenCalled();
  });

  it("leaves other reads, writes and other origins to the network", () => {
    const reads = createBootReads({
      origin: ORIGIN,
      page: {
        startedAt: 0,
        settled: true,
        outcome: Promise.resolve(okOutcome({})),
      },
      requestBoot: vi.fn(),
      now: () => 10,
    });

    const network = networkResponse("network");

    expect(
      reads.serve(`${ORIGIN}/api/v1/hosts?includeCreating=true`, {}, network),
    ).toBeNull();
    expect(
      reads.serve(`${ORIGIN}/api/v1/system/config`, { method: "PUT" }, network),
    ).toBeNull();
    expect(
      reads.serve("https://elsewhere.test/api/v1/system/config", {}, network),
    ).toBeNull();
    expect(reads.serve(`${ORIGIN}/api/v1/projects`, {}, network)).toBeNull();
  });

  it("loads each item separately when the combined read failed or omitted it", async () => {
    const onBootFailure = vi.fn();

    const failed = createBootReads({
      origin: ORIGIN,
      page: {
        startedAt: 0,
        settled: true,
        outcome: Promise.resolve({ kind: "failed" }),
      },
      requestBoot: vi.fn(),
      now: () => 10,
      onBootFailure,
    });

    const network = networkResponse({ from: "network" });
    const response = await failed.serve("/api/v1/system/config", {}, network);

    expect(await response?.json()).toEqual({ from: "network" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(onBootFailure).toHaveBeenCalledTimes(1);

    const partial = createBootReads({
      origin: ORIGIN,
      page: {
        startedAt: 0,
        settled: true,
        outcome: Promise.resolve(okOutcome({})),
      },
      requestBoot: vi.fn(),
      now: () => 10,
    });

    await partial.serve(`${ORIGIN}/api/v1/system/config`, {}, network);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("stops answering from the page-start response once live updates connect or it ages out", () => {
    let now = 10;

    const page = {
      startedAt: 0,
      settled: true,
      outcome: Promise.resolve(
        okOutcome({ systemVersion: { status: 200, body: {} } }),
      ),
    };

    const aged = createBootReads({
      origin: ORIGIN,
      page,
      requestBoot: vi.fn(),
      now: () => now,
    });

    now = PAGE_BOOT_ACCEPT_MS + 1;
    expect(
      aged.serve(`${ORIGIN}/api/v1/system/version`, {}, vi.fn()),
    ).toBeNull();

    now = 10;
    vi.useFakeTimers();

    const connected = createBootReads({
      origin: ORIGIN,
      page,
      requestBoot: vi.fn(),
      now: () => now,
    });

    connected.openRefreshWindow();
    vi.advanceTimersByTime(BOOT_REFRESH_WINDOW_MS);
    expect(
      connected.serve(`${ORIGIN}/api/v1/system/version`, {}, vi.fn()),
    ).toBeNull();
  });

  it("collects the reads that follow a connection into one combined request", async () => {
    vi.useFakeTimers();

    const requestBoot = vi.fn(async (parts: readonly BootPartName[]) =>
      okOutcome(
        Object.fromEntries(
          parts.map((part) => [part, { status: 200, body: { part } }]),
        ),
      ),
    );

    const reads = createBootReads({
      origin: ORIGIN,
      page: null,
      requestBoot,
    });

    const network = networkResponse("network");
    reads.openRefreshWindow();

    const config = reads.serve(`${ORIGIN}/api/v1/system/config`, {}, network);

    const sidebar = reads.serve(
      `${ORIGIN}/api/v1/sidebar-bootstrap`,
      {},
      network,
    );

    const hosts = reads.serve(
      `${ORIGIN}/api/v1/hosts?includeCreating=false`,
      {},
      network,
    );

    await vi.advanceTimersByTimeAsync(BOOT_REFRESH_WINDOW_MS);

    expect(requestBoot).toHaveBeenCalledTimes(1);
    expect(requestBoot.mock.calls[0]?.[0]).toEqual([
      "systemConfig",
      "sidebarBootstrap",
      "hosts",
    ]);
    expect(await (await config)?.json()).toEqual({ part: "systemConfig" });
    expect(await (await sidebar)?.json()).toEqual({ part: "sidebarBootstrap" });
    expect(await (await hosts)?.json()).toEqual({ part: "hosts" });
    expect(network).not.toHaveBeenCalled();
  });

  it("sends a lone read after a connection directly", async () => {
    vi.useFakeTimers();
    const requestBoot = vi.fn();

    const reads = createBootReads({
      origin: ORIGIN,
      page: null,
      requestBoot,
    });

    const network = networkResponse({ from: "network" });
    reads.openRefreshWindow();
    const config = reads.serve(`${ORIGIN}/api/v1/system/config`, {}, network);
    await vi.advanceTimersByTimeAsync(BOOT_REFRESH_WINDOW_MS);

    expect(await (await config)?.json()).toEqual({ from: "network" });
    expect(requestBoot).not.toHaveBeenCalled();
  });

  it("rejects a waiting read when its caller cancels it", async () => {
    let resolveOutcome: (outcome: BootOutcome) => void = () => {};

    const reads = createBootReads({
      origin: ORIGIN,
      page: {
        startedAt: 0,
        settled: false,
        outcome: new Promise((resolve) => {
          resolveOutcome = resolve;
        }),
      },
      requestBoot: vi.fn(),
      now: () => 10,
    });

    const controller = new AbortController();
    const network = networkResponse("network");

    const read = reads.serve(
      `${ORIGIN}/api/v1/system/config`,
      { signal: controller.signal },
      network,
    );

    controller.abort();
    await expect(read).rejects.toBeDefined();
    resolveOutcome(okOutcome({}));
    expect(network).not.toHaveBeenCalled();
  });

  it("treats a signed-out answer as signed out and other answers as failures", () => {
    expect(parseBootOutcome({ status: 401, text: "", receivedAt: 1 })).toEqual({
      kind: "signed-out",
    });
    expect(
      parseBootOutcome({ status: 503, text: "{}", receivedAt: 1 }),
    ).toEqual({ kind: "failed" });
    expect(
      parseBootOutcome({ status: 200, text: "<html>", receivedAt: 1 }),
    ).toEqual({ kind: "failed" });
    expect(
      parseBootOutcome({
        status: 200,
        text: JSON.stringify(bootResponse({})),
        receivedAt: 1,
      }),
    ).toEqual({ kind: "ok", response: bootResponse({}), receivedAt: 1 });
  });
});
