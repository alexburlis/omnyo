// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  OmnyoDesktopBrowserApi,
  OmnyoDesktopBrowserImportSourcesResult,
} from "@omnyo/desktop-contract";
import type { DesktopBrowserImportSource } from "@omnyo/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSectionContent } from "./BrowserSettingsSection";
import { BROWSER_IMPORT_RECORDS_STORAGE_KEY } from "./browser-import-wizard";

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { success: vi.fn(), error: vi.fn() },
}));

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const sources: DesktopBrowserImportSource[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    icon: PNG,
    profiles: [
      { directory: "Default", name: "Person 1", cookieCount: 3 },
      { directory: "Profile 1", name: "Work", cookieCount: 1 },
    ],
  },
  {
    id: "firefox",
    name: "Firefox",
    profiles: [{ directory: "Profiles/p1", name: "default", cookieCount: 9 }],
  },
  { id: "brave", name: "Brave", profiles: [], unavailable: "browserRunning" },
  { id: "arc", name: "Arc", profiles: [], unavailable: "notInstalled" },
  {
    id: "safari",
    name: "Safari",
    profiles: [],
    unavailable: "unsupportedPlatform",
  },
];

function makeDesktopBrowser(
  overrides: Partial<OmnyoDesktopBrowserApi> = {},
): OmnyoDesktopBrowserApi {
  const noop = () => undefined;

  return {
    attach: noop,
    detach: noop,
    navigate: noop,
    goBack: noop,
    goForward: noop,
    reload: noop,
    stop: noop,
    setBounds: noop,
    setVisible: noop,
    onState: () => noop,
    onOpenTab: () => noop,
    listImportSources: vi.fn(async () => ({ sources })),
    importCookies: vi.fn(async () => ({
      ok: true as const,
      imported: 2,
      skipped: 1,
      skippedDomains: ["accounts.example.com"],
    })),
    ...overrides,
  };
}

function rowButton(id: string): HTMLButtonElement {
  const button = screen
    .getByTestId(`browser-import-${id}`)
    .querySelector("button");

  if (!button) throw new Error(`no button in row ${id}`);

  return button;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("BrowserSettingsSectionContent", () => {
  it("explains that import is desktop only outside the desktop app", () => {
    render(<BrowserSettingsSectionContent desktopBrowser={null} />);
    expect(
      screen.getByText("Only available in the Omnyo desktop app."),
    ).toBeDefined();
  });

  it("lists installed browsers with icons and status, hiding absent ones", async () => {
    render(
      <BrowserSettingsSectionContent desktopBrowser={makeDesktopBrowser()} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Google Chrome")).toBeDefined(),
    );
    expect(screen.queryByText("Arc")).toBeNull();
    expect(screen.queryByText("Safari")).toBeNull();
    expect(
      screen
        .getByTestId("browser-import-chrome")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe(PNG);
    expect(screen.getByText("2 profiles")).toBeDefined();
    expect(screen.getByText("4 cookies")).toBeDefined();
    expect(screen.getByText("Running · quit Brave to import")).toBeDefined();
    expect(rowButton("brave").textContent).toBe("Recheck");
  });

  it.each(["firefox", `storage-${"b".repeat(64)}`])(
    "imports %s directly and records it in the row",
    async (sourceId) => {
      const desktopBrowser = makeDesktopBrowser({
        listImportSources: vi.fn(async () => ({
          sources: sources.map((source) =>
            source.id === "firefox" ? { ...source, id: sourceId } : source,
          ),
        })),
      });

      render(<BrowserSettingsSectionContent desktopBrowser={desktopBrowser} />);
      await waitFor(() => expect(screen.getByText("Firefox")).toBeDefined());
      fireEvent.click(rowButton(sourceId));
      await waitFor(() =>
        expect(screen.getByText("default · 2 cookies imported")).toBeDefined(),
      );
      expect(desktopBrowser.importCookies).toHaveBeenCalledWith({
        sourceId,
        sourceProfileDirectory: "Profiles/p1",
      });
      expect(
        screen.getByText("1 skipped (accounts.example.com)"),
      ).toBeDefined();
      expect(screen.getByText("imported just now")).toBeDefined();
      expect(
        JSON.parse(
          window.localStorage.getItem(BROWSER_IMPORT_RECORDS_STORAGE_KEY) ??
            "{}",
        )[sourceId].imported,
      ).toBe(2);
    },
  );

  it("asks for a profile when a browser has several, then imports it", async () => {
    const desktopBrowser = makeDesktopBrowser();
    render(<BrowserSettingsSectionContent desktopBrowser={desktopBrowser} />);
    await waitFor(() =>
      expect(screen.getByText("Google Chrome")).toBeDefined(),
    );
    fireEvent.click(rowButton("chrome"));
    expect(screen.getByText("Import from Google Chrome")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: /Work/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 cookie" }));
    await waitFor(() =>
      expect(screen.getByText("Work · 2 cookies imported")).toBeDefined(),
    );
    expect(screen.queryByText("Import from Google Chrome")).toBeNull();
  });

  it("rechecks a running browser from its row", async () => {
    const listImportSources = vi
      .fn()
      .mockResolvedValueOnce({ sources })
      .mockResolvedValue({
        sources: sources.map((source) =>
          source.id === "brave"
            ? {
                ...source,
                unavailable: undefined,
                profiles: [
                  { directory: "Default", name: "Default", cookieCount: 5 },
                ],
              }
            : source,
        ),
      });

    render(
      <BrowserSettingsSectionContent
        desktopBrowser={makeDesktopBrowser({ listImportSources })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Brave")).toBeDefined());
    fireEvent.click(rowButton("brave"));
    await waitFor(() => expect(rowButton("brave").textContent).toBe("Import…"));
    expect(screen.getByText("5 cookies")).toBeDefined();
  });

  it("turns on login sync from a chosen profile and syncs on demand", async () => {
    const off = {
      source: null,
      running: false,
      lastRun: null,
      nextRunAt: null,
    };

    const on = {
      source: {
        sourceId: "chrome" as const,
        sourceProfileDirectory: "Profile 1",
      },
      running: false,
      lastRun: {
        ok: true as const,
        at: Date.now(),
        imported: 12,
        removed: 2,
        skipped: 0,
      },
      nextRunAt: Date.now() + 900_000,
    };

    const configureCookieSync = vi.fn(async () => on);

    const runCookieSync = vi.fn(async () => ({
      ...on,
      lastRun: {
        ok: false as const,
        at: Date.now(),
        reason: "needsKeychainApproval" as const,
      },
    }));

    render(
      <BrowserSettingsSectionContent
        desktopBrowser={makeDesktopBrowser({
          cookieSyncStatus: vi.fn(async () => off),
          configureCookieSync,
          runCookieSync,
        })}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Keep logins synced",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    const panel = within(screen.getByTestId("browser-cookie-sync"));
    const picker = panel.getByRole("button", { name: "Sync from" });
    expect(picker.textContent).toContain("Choose a profile");
    fireEvent.pointerDown(picker, { button: 0 });
    expect(
      await screen.findByRole("menuitem", {
        name: /Google Chrome\s*Person 1/u,
      }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Firefox/u })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: /Brave/u })).toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Google Chrome\s*Work/u }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Synced just now · 12 cookies, 2 removed"),
      ).toBeDefined(),
    );
    expect(configureCookieSync).toHaveBeenCalledWith({
      sourceId: "chrome",
      sourceProfileDirectory: "Profile 1",
    });
    expect(
      panel.getByRole("button", { name: "Sync from" }).textContent,
    ).toContain("Google Chrome · Work");

    fireEvent.pointerDown(panel.getByRole("button", { name: "Sync from" }), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Google Chrome\s*Work/u }),
    );
    expect(configureCookieSync).toHaveBeenCalledOnce();
    fireEvent.pointerDown(panel.getByRole("button", { name: "Sync from" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Firefox/u }));
    await waitFor(() => expect(configureCookieSync).toHaveBeenCalledTimes(2));
    expect(configureCookieSync).toHaveBeenLastCalledWith({
      sourceId: "firefox",
      sourceProfileDirectory: "Profiles/p1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(
        screen.getByText(/^Failed just now: Needs Keychain/u),
      ).toBeDefined(),
    );
  });

  it("connects the default browser's profile in one click", async () => {
    const recommended = {
      sourceId: "chrome" as const,
      sourceProfileDirectory: "Profile 1",
    };

    const configureCookieSync = vi.fn(async () => ({
      source: recommended,
      running: false,
      lastRun: {
        ok: true as const,
        at: Date.now(),
        imported: 5,
        removed: 0,
        skipped: 0,
      },
      nextRunAt: Date.now() + 900_000,
    }));

    render(
      <BrowserSettingsSectionContent
        desktopBrowser={makeDesktopBrowser({
          listImportSources: vi.fn(async () => ({ sources, recommended })),
          cookieSyncStatus: vi.fn(async () => ({
            source: null,
            running: false,
            lastRun: null,
            nextRunAt: null,
          })),
          configureCookieSync,
        })}
      />,
    );

    expect(
      await screen.findByText(/Google Chrome · Work is your default browser/u),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google Chrome" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Synced just now · 5 cookies")).toBeDefined(),
    );
    expect(configureCookieSync).toHaveBeenCalledWith(recommended);
    expect(
      screen.queryByRole("button", { name: "Connect Google Chrome" }),
    ).toBeNull();
  });
});

describe("BrowserCookieSyncSettings status", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads sync status while browser profile discovery is pending", async () => {
    let releaseSources = () => {};

    const sourceList = new Promise<OmnyoDesktopBrowserImportSourcesResult>(
      (resolve) => {
        releaseSources = () => resolve({ sources });
      },
    );

    const listImportSources = vi.fn(() => sourceList);

    const cookieSyncStatus = vi.fn(async () => ({
      source: null,
      running: false,
      lastRun: null,
      nextRunAt: null,
    }));

    render(
      <BrowserSettingsSectionContent
        desktopBrowser={makeDesktopBrowser({
          listImportSources,
          cookieSyncStatus,
        })}
      />,
    );

    expect(listImportSources).toHaveBeenCalledOnce();
    expect(cookieSyncStatus).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("switch", { name: "Keep logins synced" }),
    ).toBeNull();

    releaseSources();
    expect(
      await screen.findByRole("switch", { name: "Keep logins synced" }),
    ).toBeDefined();
    expect(cookieSyncStatus).toHaveBeenCalledOnce();
  });

  it("shows a background sync that finishes while the section stays open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const source = {
      sourceId: "chrome" as const,
      sourceProfileDirectory: "Profile 1",
    };

    const earlier = {
      source,
      running: false,
      lastRun: {
        ok: true as const,
        at: Date.now() - 12 * 60_000,
        imported: 30,
        removed: 4,
        skipped: 0,
      },
      nextRunAt: Date.now() + 180_000,
    };

    const later = {
      ...earlier,
      lastRun: {
        ok: true as const,
        at: Date.now(),
        imported: 31,
        removed: 2,
        skipped: 0,
      },
      nextRunAt: Date.now() + 900_000,
    };

    const cookieSyncStatus = vi
      .fn<() => Promise<typeof earlier>>()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValue(later);

    render(
      <BrowserSettingsSectionContent
        desktopBrowser={makeDesktopBrowser({ cookieSyncStatus })}
      />,
    );

    expect(
      await screen.findByText(/^Synced .+ · 30 cookies, 4 removed$/u),
    ).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(
      await screen.findByText("Synced just now · 31 cookies, 2 removed"),
    ).toBeDefined();
  });
});
