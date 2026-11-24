import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import type { DesktopBrowserViewManager } from "../src/desktop-browser-view.js";
import type { BrowserImportService } from "../src/browser-import/browser-import.js";
import type { BrowserCookieSyncHost } from "../src/browser-cookie-sync-ipc.js";

function createFakeCookieSyncHost(statePath: string) {
  const bindings: Array<(webContentsId: number) => boolean> = [];

  const host: BrowserCookieSyncHost = {
    statePath: () => statePath,
    bind(_sync, isTrustedSender) {
      bindings.push(isTrustedSender);

      return () => undefined;
    },
  };

  return { host, bindings };
}

function createFakeManager(
  session: DesktopBrowserViewManager["session"],
  listTabs: DesktopBrowserViewManager["listTabs"] = () => [],
) {
  const manager: Pick<
    DesktopBrowserViewManager,
    "listTabs" | "subscribeAutomationTabs" | "session" | "destroyAll"
  > = {
    listTabs,
    subscribeAutomationTabs: () => () => undefined,
    session,
    destroyAll: () => undefined,
  };

  return manager as DesktopBrowserViewManager;
}

function createFakeWindow() {
  return {
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: () => undefined,
    },
    isDestroyed: () => false,
    focus: () => undefined,
    show: () => undefined,
    restore: () => undefined,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
  };
}

describe("desktop browser broker cookie import commands", () => {
  it("lists sources and imports into the browser session", async () => {
    const browserSession = { cookies: {} } as unknown as Session;

    const browserImport: BrowserImportService = {
      listSources: vi.fn(),
      listImportSources: vi.fn<BrowserImportService["listImportSources"]>(
        async () => ({
          sources: [
            {
              id: "firefox",
              name: "Firefox",
              profiles: [{ directory: "Profiles/a", name: "default" }],
            },
          ],
          recommended: {
            sourceId: "firefox",
            sourceProfileDirectory: "Profiles/a",
          },
        }),
      ),
      readCookies: vi.fn<BrowserImportService["readCookies"]>(async () => ({
        ok: false,
        reason: "readFailed",
      })),
      importCookies: vi.fn<BrowserImportService["importCookies"]>(async () => ({
        ok: true,
        imported: 1,
        skipped: 0,
        skippedDomains: [],
      })),
    };

    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(() => browserSession),
      product: "Chrome/1",
      browserImport,
      cookieSyncHost: createFakeCookieSyncHost(
        join(tmpdir(), "omnyo-unused-cookie-sync.json"),
      ).host,
    });

    const window = createFakeWindow();
    broker.registerWindow(window as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).resolves.toEqual({
      sources: [
        {
          id: "firefox",
          name: "Firefox",
          profiles: [{ directory: "Profiles/a", name: "default" }],
        },
      ],
      recommended: {
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/a",
      },
    });
    await expect(
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: instance.generation,
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
      }),
    ).resolves.toEqual({
      ok: true,
      imported: 1,
      skipped: 0,
      skippedDomains: [],
    });
    expect(browserImport.importCookies).toHaveBeenCalledWith(
      { sourceId: "firefox", sourceProfileDirectory: "Profiles/p1" },
      browserSession,
    );
    await expect(
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: "stale",
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
      }),
    ).rejects.toThrow(/unavailable or has reconnected/);
    broker.dispose();
  });

  it("routes cookie sync commands to the local sync service and trusts only Omnyo windows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnyo-broker-sync-"));

    const cookies = {
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      flushStore: vi.fn(async () => undefined),
    };

    const browserImport: BrowserImportService = {
      listSources: vi.fn(async () => []),
      listImportSources: vi.fn(async () => ({ sources: [] })),
      importCookies: vi.fn(),
      readCookies: vi.fn<BrowserImportService["readCookies"]>(async () => ({
        ok: true,
        read: {
          cookies: [
            {
              url: "https://example.test/",
              name: "sid",
              value: "secret",
              domain: ".example.test",
              path: "/",
              secure: true,
              httpOnly: true,
              expirationDate: undefined,
              sameSite: "lax",
            },
          ],
          undecryptable: 0,
          undecryptableHosts: [],
        },
      })),
    };

    const { host, bindings } = createFakeCookieSyncHost(
      join(directory, "browser-cookie-sync.json"),
    );

    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(() => ({ cookies }) as unknown as Session),
      product: "Chrome/1",
      browserImport,
      cookieSyncHost: host,
    });

    try {
      broker.registerWindow(createFakeWindow() as never);
      const [instance] = broker.listInstances();

      const target = {
        instanceId: instance.instanceId,
        generation: instance.generation,
      };

      expect(bindings).toHaveLength(1);
      expect(bindings[0](7)).toBe(true);
      expect(bindings[0](8)).toBe(false);
      await expect(
        broker.execute({
          type: "desktop.browser.cookie_sync_status",
          ...target,
        }),
      ).resolves.toMatchObject({ source: null, lastRun: null });

      const status = await broker.execute({
        type: "desktop.browser.cookie_sync_configure",
        ...target,
        source: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
      });

      expect(status).toMatchObject({
        source: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
        lastRun: { ok: true, imported: 1, removed: 0, skipped: 0 },
      });
      expect(JSON.stringify(status)).not.toContain("example.test");
      expect(cookies.set).toHaveBeenCalledTimes(1);
    } finally {
      broker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects import commands when no import service is wired", async () => {
    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(() => {
        throw new Error("unused");
      }),
      product: "Chrome/1",
    });

    broker.registerWindow(createFakeWindow() as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).rejects.toThrow("Browser cookie import is unavailable");
    broker.dispose();
  });
});

describe("desktop browser reveal", () => {
  it("sends the tab request without restoring, showing, or focusing the window", async () => {
    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(
        () => {
          throw new Error("unused");
        },
        () => [
          {
            tabId: "tab-a",
            threadId: "thread-a",
            generation: "tab-generation",
            presentation: "hidden",
            url: "about:blank",
            title: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            errorText: null,
          },
        ],
      ),
      product: "Chrome/1",
    });

    const window = {
      ...createFakeWindow(),
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const send = vi.spyOn(window.webContents, "send");
    broker.registerWindow(window as never);
    broker.setHostId("host-a");
    const [instance] = broker.listInstances();

    try {
      await broker.execute({
        type: "desktop.browser.reveal_tab",
        instanceId: instance.instanceId,
        generation: instance.generation,
        threadId: "thread-a",
        tabId: "tab-a",
      });
      expect(send).toHaveBeenCalledWith("omnyo-desktop:browser:reveal", {
        threadId: "thread-a",
        tabId: "tab-a",
        desktopTarget: {
          hostId: "host-a",
          instanceId: instance.instanceId,
          generation: instance.generation,
        },
      });
      expect(window.restore).not.toHaveBeenCalled();
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
    } finally {
      broker.dispose();
    }
  });
});
