// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { OmnyoDesktopApi } from "@omnyo/desktop-contract";
import type {
  DesktopBrowserCookieSyncSource,
  DesktopBrowserCookieSyncStatus,
  DesktopBrowserImportSource,
} from "@omnyo/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_STEPS } from "./onboarding-model";
import {
  OnboardingBrowserStep,
  browserLoginApi,
  type BrowserLoginApi,
} from "./OnboardingBrowserStep";

const sources: DesktopBrowserImportSource[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    profiles: [{ directory: "Default", name: "Person 1", cookieCount: 40 }],
  },
  {
    id: "dia",
    name: "Dia",
    profiles: [{ directory: "Profile 7", name: "Work", cookieCount: 9 }],
  },
];

const dia: DesktopBrowserCookieSyncSource = {
  sourceId: "dia",
  sourceProfileDirectory: "Profile 7",
};

const off: DesktopBrowserCookieSyncStatus = {
  source: null,
  running: false,
  lastRun: null,
  nextRunAt: null,
};

const chrome = {
  compact: false,
  reserveMacosTrafficLights: false,
  steps: ONBOARDING_STEPS,
  previousStep: null,
  onSelectStep: () => undefined,
  onSkipAll: () => undefined,
};

function browser(
  overrides: Partial<BrowserLoginApi> = {},
): BrowserLoginApi & Record<string, unknown> {
  return {
    listImportSources: vi.fn(async () => ({ sources, recommended: dia })),
    cookieSyncStatus: vi.fn(async () => off),
    configureCookieSync: vi.fn(async (source) => ({
      source,
      running: false,
      lastRun: {
        ok: true as const,
        at: Date.now(),
        imported: 9,
        removed: 0,
        skipped: 0,
      },
      nextRunAt: null,
    })),
    ...overrides,
  } as BrowserLoginApi & Record<string, unknown>;
}

function renderStep(api: BrowserLoginApi) {
  const onContinue = vi.fn();
  const onSkip = vi.fn();
  render(
    <OnboardingBrowserStep
      chrome={chrome}
      browser={api}
      permissionNote="If macOS asks, choose Always Allow so Omnyo stays in sync."
      onBack={() => undefined}
      onContinue={onContinue}
      onSkip={onSkip}
      onConnectedChange={() => undefined}
    />,
  );

  return { onContinue, onSkip };
}

afterEach(cleanup);

describe("OnboardingBrowserStep", () => {
  it("connects the default browser's profile in one click and moves on", async () => {
    const api = browser();
    const { onContinue } = renderStep(api);

    expect(await screen.findByText("Dia · Work")).toBeDefined();
    expect(screen.getByText("Your default browser")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Connect Dia" }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(api.configureCookieSync).toHaveBeenCalledWith(dia);
  });

  it("shows why connecting failed and turns sync back off when skipped", async () => {
    const configureCookieSync = vi.fn(
      async (source: DesktopBrowserCookieSyncSource | null) =>
        source === null
          ? off
          : {
              source,
              running: false,
              lastRun: {
                ok: false as const,
                at: Date.now(),
                reason: "needsKeychainApproval" as const,
              },
              nextRunAt: null,
            },
    );

    const { onContinue, onSkip } = renderStep(browser({ configureCookieSync }));

    fireEvent.click(await screen.findByRole("button", { name: "Connect Dia" }));
    expect(await screen.findByText(/Needs Keychain access/u)).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(onSkip).toHaveBeenCalledOnce());
    expect(configureCookieSync).toHaveBeenLastCalledWith(null);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows an existing connection and continues without reconnecting", async () => {
    const api = browser({
      cookieSyncStatus: vi.fn(async () => ({ ...off, source: dia })),
    });

    const { onContinue } = renderStep(api);

    expect(await screen.findByText("Connected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(api.configureCookieSync).not.toHaveBeenCalled();
  });
});

describe("browserLoginApi", () => {
  const api = browser();

  it.each([
    ["macos", true],
    ["linux", true],
    ["windows", false],
  ] as const)("offers the step on %s: %s", (platform, offered) => {
    const desktop = { platform, browser: api } as unknown as OmnyoDesktopApi;

    expect(browserLoginApi(desktop) !== null).toBe(offered);
  });

  it("hides the step outside the desktop app and on desktop builds without login sync", () => {
    expect(browserLoginApi(null)).toBeNull();
    expect(
      browserLoginApi({
        platform: "macos",
        browser: { ...api, configureCookieSync: undefined },
      } as unknown as OmnyoDesktopApi),
    ).toBeNull();
  });
});
