// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getElementById("omnyo-prefetch-manifest")?.remove();
});

it("retains only a recognized manifest asset basename for the failed download", async () => {
  vi.resetModules();
  const manifest = document.createElement("script");
  manifest.id = "omnyo-prefetch-manifest";
  manifest.type = "application/json";
  manifest.textContent = JSON.stringify({
    files: [
      "https://private.example/customer/assets/ok-AbCd1234.js?private=draft",
      "https://private.example/customer/assets/editor-XyZ_9876.css?private=draft",
    ],
    splits: { editor: [0, 1] },
  });
  document.head.append(manifest);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(null, { status: url.includes("editor-") ? 503 : 200 }),
    ),
  );
  const { downloadSplit, splitImportAssetName } = await import("./split-load");
  expect(await downloadSplit("editor")).toEqual({
    kind: "http",
    status: 503,
    downloadPhase: "request",
    online: true,
    assetName: "editor-XyZ_9876.css",
  });
  expect(splitImportAssetName("editor")).toBe("ok-AbCd1234.js");
});

it("omits unrecognized and ambiguous manifest asset names", async () => {
  vi.resetModules();
  const manifest = document.createElement("script");
  manifest.id = "omnyo-prefetch-manifest";
  manifest.type = "application/json";
  manifest.textContent = JSON.stringify({
    files: [
      "https://private.example/customer/private-document.js?private=draft",
      "/assets/first-AbCd1234.js",
      "/assets/second-XyZ_9876.js",
    ],
    splits: { private: [0], multiple: [1, 2] },
  });
  document.head.append(manifest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  const { downloadSplit, splitImportAssetName } = await import("./split-load");
  expect(await downloadSplit("private")).toEqual({
    kind: "http",
    status: 404,
    downloadPhase: "request",
    online: true,
  });
  expect(splitImportAssetName("multiple")).toBeUndefined();
});

it("waits for all current loads and the next paint opportunity", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    window.setTimeout(callback, 0),
  );

  const { trackCriticalLoad, whenCriticalLoadsSettled } =
    await import("./split-load");

  let resolveFirst: () => void = () => {};

  let rejectSecond: (error: Error) => void = () => {};

  const first = trackCriticalLoad(
    new Promise<void>((resolve) => {
      resolveFirst = resolve;
    }),
  );

  const second = trackCriticalLoad(
    new Promise<void>((_resolve, reject) => {
      rejectSecond = reject;
    }),
  );

  void second.catch(() => {});
  let settled = false;

  const ready = whenCriticalLoadsSettled().then(() => {
    settled = true;
  });

  resolveFirst();
  await first;
  await vi.runAllTimersAsync();
  expect(settled).toBe(false);
  rejectSecond(new Error("requested feature unavailable"));
  await vi.runAllTimersAsync();
  await ready;
  expect(settled).toBe(true);
});

it("resolves without starting work when no current load is pending", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    window.setTimeout(callback, 0),
  );
  const { whenCriticalLoadsSettled } = await import("./split-load");
  let settled = false;

  const ready = whenCriticalLoadsSettled().then(() => {
    settled = true;
  });

  expect(settled).toBe(false);
  await vi.runAllTimersAsync();
  await ready;
  expect(settled).toBe(true);
});

it.each(["request", "body"] as const)(
  "distinguishes a connection failure during %s without retaining the rejection",
  async (phase) => {
    vi.resetModules();
    const manifest = document.createElement("script");
    manifest.id = "omnyo-prefetch-manifest";
    manifest.type = "application/json";
    manifest.textContent = JSON.stringify({
      files: ["/assets/connection-AbCd1234.js"],
      splits: { connection: [0] },
    });
    document.head.append(manifest);

    const fail = () => {
      throw new TypeError("private-origin/path?private=request-content");
    };

    vi.stubGlobal("fetch", async () => {
      if (phase === "request") fail();

      return { ok: true, arrayBuffer: fail };
    });
    const { downloadSplit } = await import("./split-load");
    const result = await downloadSplit("connection");
    expect(result).toEqual({
      kind: "network",
      downloadPhase: phase,
      online: true,
      assetName: "connection-AbCd1234.js",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  },
);
