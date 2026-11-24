// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";
import { definePluginApp } from "./plugin-app-definition";
import {
  createPluginFrontendReconcileState,
  fetchFrontendCandidates,
  reconcilePluginFrontends,
  type PluginFrontendReconcileDeps,
} from "./plugin-frontend";

const bundle = {
  jsUrl: "/api/v1/plugin-app-assets/0123456789abcdef/app.js",
  cssUrl: null,
  jsBytes: 100,
  hash: "0123456789abcdef",
  sdkMajor: 0,
  sdkVersion: "0.1.0",
  compatible: true,
};

const running = makeInstalledPlugin({
  id: "omnyo--account-usage",
  app: { hasApp: true, bundle },
});

const starting = {
  ...running,
  status: "starting" as const,
  statusDetail: null,
  app: { hasApp: true, bundle: null },
};

function makeHarness() {
  let listed: unknown[] = [running];

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ plugins: listed })),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });

  const state = createPluginFrontendReconcileState();

  const deps = {
    fetchCandidates: () => fetchFrontendCandidates(queryClient),
    importModule: vi.fn(async () => ({ default: definePluginApp(() => {}) })),
    applyCss: () => {},
    retainCss: () => () => {},
    resetCrashedSlots: () => {},
    setRegistrations: vi.fn(),
    removeRegistrations: vi.fn(),
    beginSlotBatch: () => () => {},
    warn: () => {},
    routePluginId: () => null,
  } satisfies PluginFrontendReconcileDeps;

  return {
    state,
    deps,
    list: (plugins: unknown[]) => {
      listed = plugins;
    },
    reconcile: async () => {
      await queryClient.invalidateQueries();
      await reconcilePluginFrontends(state, deps);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin frontends across a server restart", () => {
  it("keeps a mounted plugin while the restarted server is still loading it", async () => {
    const harness = makeHarness();
    await harness.reconcile();
    expect(harness.state.activeGenerations.has("omnyo--account-usage")).toBe(
      true,
    );

    harness.list([starting]);
    await harness.reconcile();

    expect(harness.deps.removeRegistrations).not.toHaveBeenCalled();
    expect(harness.state.activeGenerations.has("omnyo--account-usage")).toBe(
      true,
    );

    harness.list([running]);
    await harness.reconcile();

    expect(harness.deps.importModule).toHaveBeenCalledTimes(1);
    expect(harness.deps.removeRegistrations).not.toHaveBeenCalled();
  });

  it("waits to import a plugin until the server reports it running", async () => {
    const harness = makeHarness();
    harness.list([starting]);
    await harness.reconcile();

    expect(harness.deps.importModule).not.toHaveBeenCalled();

    harness.list([running]);
    await harness.reconcile();

    expect(harness.deps.importModule).toHaveBeenCalledWith(bundle.jsUrl);
    expect(harness.state.activeGenerations.has("omnyo--account-usage")).toBe(
      true,
    );
  });

  it("still removes a plugin the server no longer runs", async () => {
    const harness = makeHarness();
    await harness.reconcile();

    harness.list([]);
    await harness.reconcile();

    expect(harness.deps.removeRegistrations).toHaveBeenCalledWith(
      "omnyo--account-usage",
    );
    expect(harness.state.activeGenerations.has("omnyo--account-usage")).toBe(
      false,
    );
  });
});
