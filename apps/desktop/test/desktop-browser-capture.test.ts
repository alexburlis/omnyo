import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeImage } from "electron";
import { captureDesktopBrowserPage } from "../src/desktop-browser-capture.js";

vi.mock("electron", () => ({
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => false, source: "native" }),
    createFromBuffer: (bytes: Uint8Array) => ({
      isEmpty: () => false,
      source: "cdp",
      bytes,
    }),
  },
}));

afterEach(() => vi.restoreAllMocks());

function fixture(attached: boolean) {
  const calls: string[] = [];
  const image = nativeImage.createEmpty();

  const capturePage = vi.fn(async () => {
    calls.push("native");

    return image;
  });

  const debuggerApi = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand: vi.fn(async (method: string) => {
      calls.push(method);

      return { data: Buffer.from("jpeg").toString("base64") };
    }),
    on: vi.fn(),
    off: vi.fn(),
  };

  const contents = {
    capturePage,
    debugger: debuggerApi,
    isDestroyed: vi.fn(() => false),
    getBackgroundThrottling: vi.fn(() => true),
    setBackgroundThrottling: vi.fn(),
  };

  return { contents, calls, image, capturePage, debuggerApi };
}

describe("native browser capture ownership", () => {
  it("uses the existing debugger screenshot before accepting a nonempty native bitmap", async () => {
    const value = fixture(true);
    const result = await captureDesktopBrowserPage(value.contents);
    expect(result).toMatchObject({ source: "cdp", bytes: Buffer.from("jpeg") });
    expect(value.calls[0]).toBe("Page.captureScreenshot");
    expect(value.debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 80, captureBeyondViewport: false },
      undefined,
    );
    expect(value.debuggerApi.attach).not.toHaveBeenCalled();
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
    expect(value.contents.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it("preserves the native capture path when no debugger controls the tab", async () => {
    const value = fixture(false);
    expect(await captureDesktopBrowserPage(value.contents)).toBe(value.image);
    expect(value.calls).toEqual(["native"]);
    expect(value.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(value.debuggerApi.attach).not.toHaveBeenCalled();
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it("fails visibly on a foreign debugger error without retrying or detaching it", async () => {
    const value = fixture(true);
    value.debuggerApi.sendCommand.mockRejectedValue(
      new Error("Existing capture failed"),
    );
    await expect(captureDesktopBrowserPage(value.contents)).rejects.toThrow(
      "Existing capture failed",
    );
    expect(value.debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    expect(value.debuggerApi.attach).not.toHaveBeenCalled();
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
    expect(value.contents.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it("restores only its own attachment and throttling after native capture fails", async () => {
    const value = fixture(false);
    value.capturePage.mockRejectedValue(new Error("No native pixels"));
    expect(await captureDesktopBrowserPage(value.contents)).toMatchObject({
      source: "cdp",
    });
    expect(value.debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(value.contents.setBackgroundThrottling.mock.calls).toEqual([
      [false],
      [true],
    ]);
  });

  it("rejects a destroyed native target before issuing capture commands", async () => {
    const value = fixture(true);
    value.contents.isDestroyed.mockReturnValue(true);
    await expect(captureDesktopBrowserPage(value.contents)).rejects.toThrow(
      "Native browser tab is unavailable",
    );
    expect(value.calls).toEqual([]);
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
  });
});
