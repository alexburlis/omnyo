import { ANALYTICS_CONSENT_HEADER } from "@omnyo/domain/usage-telemetry";
import { saveClientUsageConsent } from "./usage-consent";
import { APP_SURFACE_HEADER_NAME } from "@omnyo/config/app-surface";
import {
  buildBridgeInjectionScript,
  MOBILE_BRIDGE_VERSION,
  type NativeShellHandshake,
} from "@omnyo/mobile-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmnyoDesktopApi } from "@/test/omnyo-desktop-test-utils";
import { resetNativeShellForTests } from "@/lib/native-shell";
import {
  appSurfaceRequestInit,
  getAppSurface,
  fetchWithAppSurface,
} from "./app-surface";

const mobileHandshake: NativeShellHandshake = {
  bridgeVersion: MOBILE_BRIDGE_VERSION,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
} as const;

describe("app surface request metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNativeShellForTests();
  });

  it("defaults browser requests to the web app surface", () => {
    const init = appSurfaceRequestInit({
      headers: { "x-existing": "kept" },
    });

    const headers = new Headers(init.headers);
    expect(getAppSurface()).toBe("web");
    expect(headers.get(APP_SURFACE_HEADER_NAME)).toBe("web");
    expect(headers.get("x-existing")).toBe("kept");
  });

  it("keeps API requests out of the browser HTTP cache unless the caller chooses a mode", () => {
    expect(appSurfaceRequestInit().cache).toBe("no-store");
    expect(appSurfaceRequestInit({ cache: "force-cache" }).cache).toBe(
      "force-cache",
    );
  });

  it("marks Electron preload requests as desktop", () => {
    vi.stubGlobal("window", {
      omnyoDesktop: createOmnyoDesktopApi(desktopInfo),
    });

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("desktop");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "desktop",
    );
  });

  it("marks requests from the Omnyo mobile shell as mobile", () => {
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: () => {} },
    };

    // eslint-disable-next-line no-new-func
    new Function("window", buildBridgeInjectionScript(mobileHandshake))(
      fakeWindow,
    );
    vi.stubGlobal("window", fakeWindow);
    resetNativeShellForTests();

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("mobile");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "mobile",
    );
  });
  it("limits a saved analytics capability to contributing same-origin actions and refuses redirects", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    vi.stubGlobal("window", { location: new URL("http://localhost") });
    const proof = "a".repeat(64);
    saveClientUsageConsent({ active: proof, proofs: [proof] });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    try {
      await fetchWithAppSurface("/api/v1/threads", { method: "POST" });
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
          ANALYTICS_CONSENT_HEADER,
        ),
      ).toBe(proof);
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
      await fetchWithAppSurface("/api/v1/plugins/private/rpc/call", {
        method: "POST",
      });
      await fetchWithAppSurface("https://external.example/api/v1/threads", {
        method: "POST",
      });
      await fetchWithAppSurface("/api/v1/system/bug-reports", {
        method: "POST",
      });

      for (const call of fetchMock.mock.calls.slice(1))
        expect(
          new Headers(call[1]?.headers).has(ANALYTICS_CONSENT_HEADER),
        ).toBe(false);
      await fetchWithAppSurface("/api/v1/system/usage/erase", {
        method: "POST",
        body: JSON.stringify({ proof }),
      });
      expect(fetchMock.mock.calls.at(-1)?.[1]?.redirect).toBe("error");
    } finally {
      localStorage.removeItem("omnyo.usage-consent.v1");
    }
  });
});
