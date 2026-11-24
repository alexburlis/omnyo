// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { OmnyoDesktopBrowserApi } from "@omnyo/desktop-contract";
import { createNoopDesktopBrowserApi } from "@/test/omnyo-desktop-test-utils";
import { createPluginBrowserPage } from "./PluginBrowserToolbarActions";

vi.mock("@/lib/sdk", () => ({
  sdk: { experimental_desktopBrowsers: { captureTab: vi.fn() } },
}));

vi.mock("@/lib/plugin-slots", () => ({ usePluginSlots: () => [] }));

vi.mock("./PluginSlotMount", () => ({ PluginSlotMount: () => null }));

function browser() {
  const evaluate = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { retained: true } });

  const api: OmnyoDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    evaluate,
    onPageMessage: () => () => {},
  };

  return { api, evaluate };
}

function page(
  desktopBrowser: OmnyoDesktopBrowserApi,
  desktopVersion: string | null,
) {
  const result = createPluginBrowserPage({
    desktopBrowser,
    desktopVersion,
    pluginId: "plugin-owner",
    tabId: "tab-one",
    threadId: "thread-one",
  });

  if (result === null) throw new Error("Desktop browser page missing");

  return result;
}

describe("browser evaluator native-version admission", () => {
  it.each([
    null,
    "unknown",
    "0.46.241+private.9",
    "0.46.242+private.1",
    "0.46.245+private.1",
    "0.46.246-beta.1",
  ])("refuses unsupported %s before IPC dispatch", async (version) => {
    const { api, evaluate } = browser();
    await expect(
      page(api, version).evaluate("omnyo.postMessage({ kept: true })"),
    ).rejects.toThrow(/Update Omnyo desktop.*0\.46\.246/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(["0.46.246+private.1", "0.46.247", "0.47.0"])(
    "forwards supported %s bytes without inspecting user code",
    async (version) => {
      const { api, evaluate } = browser();
      const expression = String.raw`({ text: "bb.postMessage remains user data", nested: { bb: "unchanged" } })`;
      await expect(
        page(api, version).evaluate(expression, { world: "main" }),
      ).resolves.toEqual({ retained: true });
      expect(evaluate).toHaveBeenCalledExactlyOnceWith({
        tabId: "tab-one",
        expression,
        world: "main",
        channel: "plugin-owner",
      });
    },
  );

  it("keeps isolated as the default for supported native", async () => {
    const { api, evaluate } = browser();
    await page(api, "0.46.246").evaluate("typeof omnyo");
    expect(evaluate).toHaveBeenCalledExactlyOnceWith({
      tabId: "tab-one",
      expression: "typeof omnyo",
      world: "isolated",
      channel: "plugin-owner",
    });
  });

  it("preserves message attribution independently of evaluation admission", () => {
    const handlers: {
      receive?: Parameters<
        NonNullable<OmnyoDesktopBrowserApi["onPageMessage"]>
      >[0];
    } = {};

    const dispose = vi.fn();
    const { api, evaluate } = browser();
    api.onPageMessage = (receive) => {
      handlers.receive = receive;

      return dispose;
    };

    const listener = vi.fn();
    const unsubscribe = page(api, "0.46.241").onMessage(listener);
    const receive = handlers.receive;

    if (receive === undefined) throw new Error("Message receiver missing");
    receive({ tabId: "other-tab", channel: "plugin-owner", data: "foreign" });
    receive({ tabId: "tab-one", channel: "other-plugin", data: "foreign" });
    receive({
      tabId: "tab-one",
      channel: "plugin-owner",
      data: { retained: true },
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ retained: true });
    expect(evaluate).not.toHaveBeenCalled();
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
