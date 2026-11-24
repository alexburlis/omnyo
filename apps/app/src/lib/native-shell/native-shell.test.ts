// @vitest-environment jsdom

import {
  buildBridgeEventScript,
  type NativeShellHandshake,
} from "@omnyo/mobile-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  installNativeShellForTest,
  removeNativeShellForTest,
  type InstalledNativeShell,
} from "@/test/native-shell-test-utils";
import { NativeShellReporter } from "./NativeShellReporter";
import {
  canOpenNativeScreen,
  getNativeShell,
  isInsideNativeShell,
  nativeShellServerSummary,
  resetNativeShellForTests,
  shellHaptic,
  shellOpenExternal,
} from "./native-shell";

const baseHandshake: Partial<NativeShellHandshake> = {
  appVersion: "0.39.0",
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

function installShell(
  overrides: Partial<NativeShellHandshake> = {},
): InstalledNativeShell {
  return installNativeShellForTest({ ...baseHandshake, ...overrides });
}

function announceRawCapabilities(capabilities: unknown): void {
  new Function(
    "window",
    "capabilities",
    "window.omnyo.native.__apply({ capabilities: capabilities });",
  )(window, capabilities);
  resetNativeShellForTests();
}

afterEach(() => {
  cleanup();
  removeNativeShellForTest();
  vi.restoreAllMocks();
});

describe("getNativeShell", () => {
  it("reads the handshake the shell installed", () => {
    installShell();
    const shell = getNativeShell();
    expect(shell).not.toBeNull();
    expect(shell?.handshake.profileMode).toBe("connect");
    expect(shell?.safeArea()).toEqual({
      top: 59,
      right: 0,
      bottom: 34,
      left: 0,
    });
    expect(isInsideNativeShell()).toBe(true);
  });

  it("reports no shell in a plain browser", () => {
    expect(getNativeShell()).toBeNull();
    expect(isInsideNativeShell()).toBe(false);
  });

  it("plays a haptic when the bridge appears after the first lookup", () => {
    const shell = installShell();
    const globals = Object.getOwnPropertyDescriptor(window, "omnyo");

    if (!globals) throw new Error("The fixture did not install the bridge");

    Reflect.deleteProperty(window, "omnyo");
    expect(getNativeShell()).toBeNull();

    Object.defineProperty(window, "omnyo", globals);
    shellHaptic("impact-light");
    expect(shell.messages()).toEqual([
      { type: "haptic", kind: "impact-light" },
    ]);
  });

  it("ignores a global that is not a usable bridge", () => {
    Object.defineProperty(window, "omnyo", {
      configurable: true,
      value: { native: { post: "not a function" } },
    });
    expect(getNativeShell()).toBeNull();
  });

  it("treats a nonsense bridge version as no bridge", () => {
    installShell({ bridgeVersion: 0 });
    expect(getNativeShell()).toBeNull();
  });

  it("keeps working with a shell newer than this page", () => {
    installShell({ bridgeVersion: 99 });
    expect(getNativeShell()).not.toBeNull();
  });

  it("keeps the shell when a newer native announces a capability this page does not know", () => {
    installShell();
    announceRawCapabilities(["haptic", "open-native", "live-activity"]);
    const shell = getNativeShell();
    expect(shell).not.toBeNull();
    expect(shell?.handshake.capabilities).toEqual(["haptic", "open-native"]);
    expect(canOpenNativeScreen()).toBe(true);
  });

  it("still refuses capabilities that are not a list", () => {
    installShell();
    announceRawCapabilities("open-native");
    expect(getNativeShell()).toBeNull();
  });
});

describe("nativeShellServerSummary", () => {
  it("names this page's host and the shell's connection mode", () => {
    installShell({ profileMode: "direct" });
    expect(nativeShellServerSummary()).toEqual({
      host: window.location.host,
      mode: "direct",
    });
  });

  it("has nothing to say in a plain browser", () => {
    expect(nativeShellServerSummary()).toBeNull();
  });
});

describe("shellHaptic", () => {
  it("delivers a haptic message to the iOS WebView bridge", () => {
    const shell = installShell();
    shellHaptic("impact-light");
    expect(shell.messages()).toEqual([
      { type: "haptic", kind: "impact-light" },
    ]);
  });

  it.each<Partial<NativeShellHandshake>>([
    { platform: "android" },
    { capabilities: [] },
  ])("leaves the bridge quiet with %j", (overrides) => {
    const shell = installShell(overrides);
    shellHaptic("impact-light");
    expect(shell.messages()).toEqual([]);
  });

  it("works in a browser without a native bridge", () => {
    expect(() => shellHaptic("success")).not.toThrow();
  });
});

describe("shellOpenExternal", () => {
  it("hands the link to the shell and says it took it", () => {
    const shell = installShell();
    expect(shellOpenExternal("https://example.com/docs")).toBe(true);
    expect(shell.messages().at(-1)).toEqual({
      type: "open-external",
      url: "https://example.com/docs",
    });
  });

  it("declines in a plain browser so the caller can use window.open", () => {
    expect(shellOpenExternal("https://example.com/docs")).toBe(false);
  });
});

it("applies native bottom insets to portaled UI and updates them when the safe area changes", () => {
  installShell({
    platform: "android",
    safeArea: { top: 24, right: 0, bottom: 24, left: 0 },
  });

  const { unmount } = render(
    createElement(MemoryRouter, null, createElement(NativeShellReporter)),
  );

  expect(
    document.documentElement.style.getPropertyValue("--omnyo-safe-area-bottom"),
  ).toBe("24px");
  act(() => {
    new Function(
      "window",
      buildBridgeEventScript({
        type: "safe-area",
        safeArea: { top: 0, right: 24, bottom: 0, left: 0 },
      }),
    )(window);
  });
  expect(
    document.documentElement.style.getPropertyValue("--omnyo-safe-area-bottom"),
  ).toBe("0px");
  unmount();
  expect(
    document.documentElement.style.getPropertyValue("--omnyo-safe-area-bottom"),
  ).toBe("");
});
