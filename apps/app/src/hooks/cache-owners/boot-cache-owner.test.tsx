// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootPartName,
  BootResponse,
  SidebarBootstrapResponse,
  SystemVersionResponse,
} from "@omnyo/server-contract";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSidebarBootstrapResponse } from "@/test/fixtures/projects";
import {
  BOOT_REFRESH_WINDOW_MS,
  installBootReads,
  type BootOutcome,
  type BootReads,
  type PageBoot,
} from "@/lib/boot-reads";
import { resetSidebarBootstrapCacheForTest } from "@/lib/sidebar-bootstrap-cache";
import { createRealtimeCacheEffects } from "../realtime-cache-effects";
import { useSidebarNavigation } from "../queries/sidebar-navigation-query";
import type {
  BootSnapshotRecord,
  BootSnapshotStore,
} from "@/lib/boot-snapshot-store";
import { useHosts } from "../queries/host-queries";
import { usePluginSafeMode } from "../queries/plugin-settings-queries";
import { useSystemVersion } from "../queries/system-queries";
import {
  hostsQueryKey,
  pluginSafeModeQueryKey,
  systemVersionQueryKey,
} from "../queries/query-keys";
import {
  BOOT_SNAPSHOT_READ_DEADLINE_MS,
  startBootCache,
  type BootCache,
} from "./boot-cache-owner";

const IDENTITY = "a".repeat(64);

const OTHER_IDENTITY = "b".repeat(64);

const clients: QueryClient[] = [];

const caches: BootCache[] = [];

function version(currentVersion: string): SystemVersionResponse {
  return {
    currentCommit: null,
    installKind: "source",
    currentVersion,
    latestVersion: null,
    source: "private",
    updateAvailable: false,
    isDevelopment: false,
    upgradeCommand: "",
  };
}

function ok(
  parts: BootResponse["parts"],
  serverIdentity = IDENTITY,
): BootOutcome {
  return {
    kind: "ok",
    response: { version: 1, serverIdentity, parts },
    receivedAt: Date.now(),
  };
}

function deferredPage(): {
  page: PageBoot;
  settle: (outcome: BootOutcome) => void;
} {
  let settle: (outcome: BootOutcome) => void = () => {};

  const outcome = new Promise<BootOutcome>((resolve) => {
    settle = resolve;
  });

  return { page: { startedAt: Date.now(), settled: false, outcome }, settle };
}

function memoryStore(record: BootSnapshotRecord | null) {
  let current = record;

  const store: BootSnapshotStore = {
    read: vi.fn(async () => current),
    write: vi.fn(async (next: BootSnapshotRecord) => {
      current = next;
    }),
    clear: vi.fn(async () => {
      current = null;
    }),
  };

  return { store, current: () => current };
}

function storedRecord(
  parts: Record<string, unknown>,
  serverIdentity = IDENTITY,
): BootSnapshotRecord {
  return {
    schema: 1,
    origin: window.location.origin,
    serverIdentity,
    savedAt: 1_000,
    parts,
  };
}

async function start(args: {
  queryClient: QueryClient;
  page: PageBoot;
  store: BootSnapshotStore;
  clearLastKnownCaches?: () => void;
  requestBoot?: (parts: readonly BootPartName[]) => Promise<BootOutcome>;
}) {
  let reads: BootReads | null = null;

  const cache = await startBootCache({
    queryClient: args.queryClient,
    origin: window.location.origin,
    page: args.page,
    store: args.store,
    requestBoot: args.requestBoot ?? vi.fn(),
    clearLastKnownCaches: args.clearLastKnownCaches ?? vi.fn(),
    install: (installed) => {
      reads = installed;
      installBootReads(installed);
    },
  });

  caches.push(cache);

  return Object.assign(cache, {
    openRefreshWindow: () => reads?.openRefreshWindow(),
  });
}

function harness() {
  const result = createQueryClientTestHarness();
  clients.push(result.queryClient);

  return result;
}

const fetchSpy = vi.fn(async () => Response.json({ unexpected: true }));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();

  for (const cache of caches.splice(0)) cache.dispose();
  installBootReads(null);

  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe("boot cache", () => {
  it("lets first-screen hooks mount on the page-start response without their own requests", async () => {
    const host = makeHost({ id: "host-boot" });
    const { queryClient, wrapper } = harness();

    await start({
      queryClient,
      page: {
        startedAt: Date.now(),
        settled: true,
        outcome: Promise.resolve(
          ok({
            hosts: { status: 200, body: [host] },
            systemVersion: { status: 200, body: version("1.0.0") },
            pluginSafeMode: { status: 200, body: { enabled: true } },
          }),
        ),
      },
      store: memoryStore(null).store,
    });

    const hosts = renderHook(() => useHosts(), { wrapper });
    const systemVersion = renderHook(() => useSystemVersion(), { wrapper });
    const safeMode = renderHook(() => usePluginSafeMode(), { wrapper });

    await waitFor(() => {
      expect(hosts.result.current.data).toEqual([host]);
      expect(systemVersion.result.current.data?.currentVersion).toBe("1.0.0");
      expect(safeMode.result.current.data).toBe(true);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes the reads invalidated by the first live connection with one combined request", async () => {
    resetSidebarBootstrapCacheForTest();
    const host = makeHost({ id: "host-boot" });
    const sidebar: SidebarBootstrapResponse = makeSidebarBootstrapResponse();
    const { queryClient, wrapper } = harness();

    const requestBoot = vi.fn(async (parts: readonly BootPartName[]) =>
      ok(
        Object.fromEntries(
          parts.map((part) => [
            part,
            {
              status: 200,
              body:
                part === "hosts" ? [host, makeHost({ id: "host-2" })] : sidebar,
            },
          ]),
        ),
      ),
    );

    const cache = await start({
      queryClient,
      page: {
        startedAt: Date.now(),
        settled: true,
        outcome: Promise.resolve(
          ok({
            hosts: { status: 200, body: [host] },
            sidebarBootstrap: { status: 200, body: sidebar },
          }),
        ),
      },
      store: memoryStore(null).store,
      requestBoot,
    });

    const hosts = renderHook(() => useHosts(), { wrapper });
    const navigation = renderHook(() => useSidebarNavigation(), { wrapper });

    await waitFor(() => {
      expect(hosts.result.current.data).toEqual([host]);
      expect(navigation.result.current.isSuccess).toBe(true);
    });

    const effects = createRealtimeCacheEffects({ queryClient });
    cache.openRefreshWindow();
    effects.handleConnected({ reconnected: false });

    await new Promise((resolve) =>
      setTimeout(resolve, BOOT_REFRESH_WINDOW_MS + 10),
    );
    await waitFor(() => {
      expect(hosts.result.current.data).toHaveLength(2);
    });
    expect(requestBoot).toHaveBeenCalledTimes(1);
    expect([...(requestBoot.mock.calls[0]?.[0] ?? [])].sort()).toEqual([
      "hosts",
      "sidebarBootstrap",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    effects.dispose();
  });

  it("shows the saved copy before the network answers, then replaces it with the network response", async () => {
    const { queryClient, wrapper } = harness();
    const { page, settle } = deferredPage();

    const { store } = memoryStore(
      storedRecord({
        systemVersion: version("0.9.0"),
        pluginSafeMode: false,
      }),
    );

    await start({ queryClient, page, store });

    expect(
      queryClient.getQueryData<SystemVersionResponse>(systemVersionQueryKey())
        ?.currentVersion,
    ).toBe("0.9.0");
    expect(
      queryClient.getQueryState(systemVersionQueryKey())?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(systemVersionQueryKey())?.dataUpdatedAt,
    ).toBe(1_000);

    const systemVersion = renderHook(() => useSystemVersion(), { wrapper });
    const safeMode = renderHook(() => usePluginSafeMode(), { wrapper });

    expect(systemVersion.result.current.data?.currentVersion).toBe("0.9.0");
    expect(systemVersion.result.current.isFetching).toBe(true);
    expect(safeMode.result.current.data).toBe(false);

    settle(
      ok({
        systemVersion: { status: 200, body: version("1.0.0") },
        pluginSafeMode: { status: 200, body: { enabled: true } },
      }),
    );

    await waitFor(() => {
      expect(systemVersion.result.current.data?.currentVersion).toBe("1.0.0");
      expect(safeMode.result.current.data).toBe(true);
    });
    expect(
      queryClient.getQueryState(systemVersionQueryKey())?.isInvalidated,
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops a saved copy that fails its schema", async () => {
    const { queryClient } = harness();

    await start({
      queryClient,
      page: deferredPage().page,
      store: memoryStore(
        storedRecord({
          systemVersion: { currentVersion: 3 },
          hosts: [{ id: "not-a-host" }],
          pluginSafeMode: true,
        }),
      ).store,
    });

    expect(queryClient.getQueryData(systemVersionQueryKey())).toBeUndefined();
    expect(queryClient.getQueryData(hostsQueryKey(false))).toBeUndefined();
    expect(queryClient.getQueryData(pluginSafeModeQueryKey())).toBe(true);
  });

  it("starts without the saved copy when its storage does not answer in time", async () => {
    const { queryClient } = harness();
    const onSnapshotReadTimeout = vi.fn();

    const store: BootSnapshotStore = {
      read: vi.fn(() => new Promise<BootSnapshotRecord | null>(() => {})),
      write: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const startedAt = Date.now();

    const cache = await startBootCache({
      queryClient,
      origin: window.location.origin,
      page: deferredPage().page,
      store,
      requestBoot: vi.fn(),
      clearLastKnownCaches: vi.fn(),
      install: installBootReads,
      onSnapshotReadTimeout,
    });

    caches.push(cache);

    expect(Date.now() - startedAt).toBeLessThan(
      BOOT_SNAPSHOT_READ_DEADLINE_MS + 1_000,
    );
    expect(onSnapshotReadTimeout).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(systemVersionQueryKey())).toBeUndefined();
  });

  it.each(["ok", "signed-out"] as const)(
    "starts on a live %s response without waiting for slow saved storage",
    async (kind) => {
      vi.useFakeTimers();
      const { queryClient } = harness();
      const { page, settle } = deferredPage();
      const store = memoryStore(null).store;
      vi.mocked(store.read).mockImplementation(
        () => new Promise<BootSnapshotRecord | null>(() => {}),
      );
      const onSnapshotReadTimeout = vi.fn();
      let started = false;

      const starting = startBootCache({
        queryClient,
        page,
        store,
        origin: window.location.origin,
        requestBoot: vi.fn(),
        clearLastKnownCaches: vi.fn(),
        install: installBootReads,
        onSnapshotReadTimeout,
      }).then((cache) => {
        caches.push(cache);
        started = true;
      });

      try {
        setTimeout(
          () => settle(kind === "ok" ? ok({}) : { kind: "signed-out" }),
          20,
        );
        await vi.advanceTimersByTimeAsync(20);
        expect(started).toBe(true);
      } finally {
        await vi.advanceTimersByTimeAsync(BOOT_SNAPSHOT_READ_DEADLINE_MS);
        await starting;
        expect(onSnapshotReadTimeout).not.toHaveBeenCalled();
        vi.useRealTimers();
      }
    },
  );

  it.each(["ok", "signed-out"] as const)(
    "does not seed an old snapshot when the live %s response is already known",
    async (kind) => {
      const { queryClient } = harness();
      const setQueryData = vi.spyOn(queryClient, "setQueryData");
      await start({
        queryClient,
        page: {
          startedAt: Date.now(),
          settled: true,
          outcome: Promise.resolve(
            kind === "ok" ? ok({}) : { kind: "signed-out" },
          ),
        },
        store: memoryStore(storedRecord({ pluginSafeMode: true })).store,
      });
      expect(setQueryData).not.toHaveBeenCalled();
    },
  );

  it("still waits for the saved copy when the live response fails", async () => {
    vi.useFakeTimers();
    const { queryClient } = harness();
    const { page, settle } = deferredPage();
    const store = memoryStore(null).store;
    vi.mocked(store.read).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(storedRecord({ pluginSafeMode: true })), 50);
        }),
    );
    let started = false;

    const starting = start({ queryClient, page, store }).then(() => {
      started = true;
    });

    try {
      settle({ kind: "failed" });
      await vi.advanceTimersByTimeAsync(20);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(30);
      await starting;
      expect(queryClient.getQueryData(pluginSafeModeQueryKey())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks a saved identity that arrives after the display deadline", async () => {
    vi.useFakeTimers();
    const { queryClient } = harness();
    const { page, settle } = deferredPage();
    const saved = memoryStore(null);
    vi.mocked(saved.store.read).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(storedRecord({}, OTHER_IDENTITY)),
            BOOT_SNAPSHOT_READ_DEADLINE_MS + 50,
          );
        }),
    );
    const clearLastKnownCaches = vi.fn();

    const starting = start({
      queryClient,
      page,
      store: saved.store,
      clearLastKnownCaches,
    });

    try {
      settle(ok({}));
      await vi.advanceTimersByTimeAsync(20);
      const cache = await starting;
      expect(clearLastKnownCaches).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(BOOT_SNAPSHOT_READ_DEADLINE_MS + 30);
      await cache.settled;
      expect(clearLastKnownCaches).toHaveBeenCalledOnce();
      expect(saved.store.read).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the saved copy and other saved server data when the server identity changes", async () => {
    const { queryClient } = harness();
    const { page, settle } = deferredPage();
    const clearLastKnownCaches = vi.fn();

    const saved = memoryStore(
      storedRecord({ pluginSafeMode: true }, OTHER_IDENTITY),
    );

    const cache = await start({
      queryClient,
      page,
      store: saved.store,
      clearLastKnownCaches,
    });

    expect(queryClient.getQueryData(pluginSafeModeQueryKey())).toBe(true);

    settle(ok({}));
    await cache.settled;

    expect(saved.store.clear).toHaveBeenCalledWith(window.location.origin);
    expect(clearLastKnownCaches).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(pluginSafeModeQueryKey())).toBeUndefined();
  });

  it("forgets the saved copy when the session is signed out", async () => {
    const { queryClient } = harness();
    const { page, settle } = deferredPage();
    const clearLastKnownCaches = vi.fn();
    const saved = memoryStore(storedRecord({ pluginSafeMode: true }));

    const cache = await start({
      queryClient,
      page,
      store: saved.store,
      clearLastKnownCaches,
    });

    settle({ kind: "signed-out" });
    await cache.settled;

    expect(saved.current()).toBeNull();
    expect(clearLastKnownCaches).toHaveBeenCalledTimes(1);
  });

  it("saves only network-confirmed data under the confirmed server identity", async () => {
    const { queryClient, wrapper } = harness();
    const { page, settle } = deferredPage();

    const saved = memoryStore(
      storedRecord({ systemVersion: version("0.9.0"), pluginSafeMode: false }),
    );

    const cache = await start({ queryClient, page, store: saved.store });
    const systemVersion = renderHook(() => useSystemVersion(), { wrapper });

    settle(ok({ systemVersion: { status: 200, body: version("1.0.0") } }));
    await cache.settled;
    await waitFor(() => {
      expect(systemVersion.result.current.data?.currentVersion).toBe("1.0.0");
    });

    await cache.persist();

    const written = saved.current();
    expect(written?.serverIdentity).toBe(IDENTITY);
    expect(written?.parts).toEqual({ systemVersion: version("1.0.0") });
  });
});
