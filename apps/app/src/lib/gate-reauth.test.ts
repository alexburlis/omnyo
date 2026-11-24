import {
  buildBridgeInjectionScript,
  MOBILE_BRIDGE_VERSION,
  type NativeShellHandshake,
} from "@omnyo/mobile-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOmnyoDesktopApi } from "@/test/omnyo-desktop-test-utils";
import { resetNativeShellForTests } from "@/lib/native-shell";
import { fetchWithAppSurface } from "./app-surface";

const fetchMock = vi.fn<typeof fetch>();

const mobileHandshake: NativeShellHandshake = {
  bridgeVersion: MOBILE_BRIDGE_VERSION,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

function stubBrowserWindow(shell: Record<string, unknown> = {}) {
  const stored = new Map<string, string>();
  const topReload = vi.fn();
  const frameReload = vi.fn();

  vi.stubGlobal("window", {
    ...shell,
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    location: { reload: frameReload },
    top: { location: { reload: topReload } },
  });
  resetNativeShellForTests();

  return { topReload, frameReload };
}

function mobileShellWindow(): Record<string, unknown> {
  const shell: Record<string, unknown> = {
    ReactNativeWebView: { postMessage: () => {} },
  };

  // eslint-disable-next-line no-new-func
  new Function("window", buildBridgeInjectionScript(mobileHandshake))(shell);

  return shell;
}

function respondWith(status: number, headers: Record<string, string> = {}) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: "reauthentication_required" }), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetNativeShellForTests();
  fetchMock.mockReset();
});

describe("gate re-authentication", () => {
  it("reloads the top-level page once and still returns the 401 to the caller", async () => {
    const { topReload, frameReload } = stubBrowserWindow();
    respondWith(401, { "x-omnyo-gate-reauth": "1" });

    const first = await fetchWithAppSurface("/api/v1/threads");
    const second = await fetchWithAppSurface("/api/v1/projects");

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(topReload).toHaveBeenCalledTimes(1);
    expect(frameReload).not.toHaveBeenCalled();
  });

  it("refuses a second reload inside 60 seconds and allows one after", async () => {
    const { topReload } = stubBrowserWindow();
    respondWith(401, { "x-omnyo-gate-reauth": "1" });

    await fetchWithAppSurface("/api/v1/threads");
    vi.setSystemTime(new Date("2026-11-09T12:00:59Z"));
    await fetchWithAppSurface("/api/v1/threads");

    expect(topReload).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-09T12:01:00Z"));
    await fetchWithAppSurface("/api/v1/threads");

    expect(topReload).toHaveBeenCalledTimes(2);
  });

  it("leaves other 401 and 403 responses to the normal error path", async () => {
    const { topReload } = stubBrowserWindow();

    respondWith(401);
    await fetchWithAppSurface("/api/v1/threads");
    respondWith(403, { "x-omnyo-gate-reauth": "1" });
    await fetchWithAppSurface("/api/v1/threads");

    expect(topReload).not.toHaveBeenCalled();
  });

  it.each([
    [
      "desktop",
      () => ({
        omnyoDesktop: createOmnyoDesktopApi({
          lastCheckedAt: null,
          latestVersion: null,
          pendingVersion: null,
          platform: "macos",
          updateAvailable: false,
          updateDownloaded: false,
          version: "0.0.0-test",
        }),
      }),
    ],
    ["mobile", mobileShellWindow],
  ])(
    "leaves the %s shell to renew its own session",
    async (_surface, shellWindow) => {
      const { topReload, frameReload } = stubBrowserWindow(shellWindow());
      respondWith(401, { "x-omnyo-gate-reauth": "1" });

      const response = await fetchWithAppSurface("/api/v1/threads");

      expect(response.status).toBe(401);
      expect(topReload).not.toHaveBeenCalled();
      expect(frameReload).not.toHaveBeenCalled();
    },
  );
});
