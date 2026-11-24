import { describe, expect, it } from "vitest";
import {
  desktopBrowserBrokerCommandRequestSchema,
  desktopBrowserBrokerCommandSchema,
  desktopBrowserCookieSyncStatusSchema,
} from "../src/desktop-browser-cookie-sync.js";

const instance = { instanceId: "window", generation: "generation" };

describe("desktop browser cookie sync contract", () => {
  it("accepts sync commands and still accepts existing broker commands", () => {
    for (const command of [
      { type: "desktop.browser.cookie_sync_status", ...instance },
      { type: "desktop.browser.cookie_sync_run", ...instance },
      {
        type: "desktop.browser.cookie_sync_configure",
        ...instance,
        source: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
      },
      {
        type: "desktop.browser.cookie_sync_configure",
        ...instance,
        source: null,
      },
      {
        type: "desktop.browser.import_cookies",
        ...instance,
        sourceId: "dia",
        sourceProfileDirectory: "Profile 7",
      },
      { type: "desktop.browser.list_instances" },
    ]) {
      expect(desktopBrowserBrokerCommandSchema.parse(command)).toEqual(command);
    }

    expect(
      desktopBrowserBrokerCommandRequestSchema.safeParse({
        type: "request",
        requestId: "request",
        command: { type: "desktop.browser.cookie_sync_run", ...instance },
      }).success,
    ).toBe(true);
  });

  it("rejects untargeted sync commands and unknown sources", () => {
    expect(
      desktopBrowserBrokerCommandSchema.safeParse({
        type: "desktop.browser.cookie_sync_run",
      }).success,
    ).toBe(false);
    expect(
      desktopBrowserBrokerCommandSchema.safeParse({
        type: "desktop.browser.cookie_sync_configure",
        ...instance,
        source: { sourceId: "/tmp/Cookies", sourceProfileDirectory: "Default" },
      }).success,
    ).toBe(false);
  });

  it("keeps cookie identities out of sync status", () => {
    const status = {
      source: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
      running: false,
      lastRun: { ok: true, at: 1, imported: 2, removed: 1, skipped: 0 },
      nextRunAt: 2,
    };

    expect(desktopBrowserCookieSyncStatusSchema.parse(status)).toEqual(status);
    expect(
      desktopBrowserCookieSyncStatusSchema.safeParse({
        ...status,
        lastRun: { ...status.lastRun, skippedDomains: ["example.com"] },
      }).success,
    ).toBe(false);
  });
});
