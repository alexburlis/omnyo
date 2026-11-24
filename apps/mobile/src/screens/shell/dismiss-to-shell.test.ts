import type { Href, useRouter } from "expo-router";
import { describe, expect, it, vi } from "vitest";
import { dismissToShell } from "./dismiss-to-shell";

type AppRouter = ReturnType<typeof useRouter>;

function recordingRouter() {
  const calls: string[] = [];

  const router = {
    dismissTo: vi.fn((href: Href) => calls.push(`dismissTo ${String(href)}`)),
    dismissAll: vi.fn(() => calls.push("dismissAll")),
    replace: vi.fn((href: Href) => calls.push(`replace ${String(href)}`)),
  };

  return { calls, router: router as unknown as AppRouter };
}

const stack = (...names: string[]) => ({
  getState: () => ({ routes: names.map((name) => ({ name })) }),
});

describe("dismissToShell", () => {
  it("returns to the shell that is already open under the settings screens", () => {
    const { calls, router } = recordingRouter();

    dismissToShell(
      router,
      stack("webview", "settings/device", "connect/index"),
      "/webview",
    );

    expect(calls).toEqual(["dismissTo /webview"]);
  });

  it("closes the first-run pairing sheets and opens the shell in their place", () => {
    const { calls, router } = recordingRouter();

    dismissToShell(
      router,
      stack("settings/servers/add", "connect/index"),
      "/webview",
    );

    expect(calls).toEqual(["dismissAll", "replace /webview"]);
  });

  it("replaces a lone first-run Add server sheet without dismissing an empty stack", () => {
    const { calls, router } = recordingRouter();

    dismissToShell(router, stack("settings/servers/add"), "/webview");

    expect(calls).toEqual(["dismissTo /webview"]);
  });
});
