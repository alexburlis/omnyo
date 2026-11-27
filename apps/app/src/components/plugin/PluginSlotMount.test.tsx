// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginSlotMount,
  resetAllCrashedPluginSlotsForTest,
  resetCrashedPluginSlots,
} from "./PluginSlotMount";
import { applyPluginCss, resetPluginCssForTest } from "@/lib/plugin-css";

function Bomb(): never {
  throw new Error("kaboom");
}

function Healthy() {
  return <div>healthy slot</div>;
}

describe("PluginSlotMount", () => {
  beforeEach(() => {
    resetAllCrashedPluginSlotsForTest();
    resetPluginCssForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  beforeEach(() => {
    vi.spyOn(HTMLLinkElement.prototype, "sheet", "get").mockReturnValue(
      new CSSStyleSheet(),
    );
  });

  afterEach(() => {
    cleanup();
    resetPluginCssForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the preferences controller alive through a sidebar collision and recovers through the typed owner RPC and Reload", async () => {
    const { useState } = await import("react");
    const { useAtomValue, getDefaultStore } = await import("jotai");
    const { toast, Toaster } = await import("sonner");

    const { renderSlot, installTestPluginRuntime } =
      await import("@omnyo/plugin-sdk/testing/app");

    installTestPluginRuntime();
    const { createFakePluginHost } = await import("@omnyo/plugin-sdk/testing");

    const { default: threadListPlugin } =
      await import("../../../../../plugins/thread-list/server.js");

    const { PreferencesSync, PreferencesSyncController } =
      await import("../../../../../plugins/thread-list/app/preferences/PreferencesSync.js");

    const { moveThreadAction } =
      await import("../../../../../plugins/thread-list/app/rows/moveThreadAction.js");

    const owner =
      await import("../../../../../plugins/thread-list/app/preferences/preferences-sync.js");

    const { ThreadListPlaceholder } =
      await import("../sidebar/ThreadListPlaceholder");

    const { fireEvent, waitFor } = await import("@testing-library/react");

    const { api, harness } = createFakePluginHost({
      pluginId: "thread-list",
      sdk: {
        system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
      },
    });

    await api.storage.kv.set("preference:organizationMode", "project");
    await threadListPlugin(api);
    const legacyKey = "bb.thread-list.preferences.v1";
    const currentKey = "omnyo.thread-list.preferences.v1";
    const receiptKey = "omnyo.thread-list.preferences-import.v1";

    const original = JSON.stringify({
      organizationMode: "chronological",
      futureField: { opaque: "kept" },
    });

    for (const key of [legacyKey, currentKey, receiptKey])
      window.localStorage.removeItem(key);
    window.localStorage.setItem(legacyKey, original);
    owner.setPreferencesMirrorStorageForTest(window.localStorage);

    function MoveCollector() {
      const useData = moveThreadAction.useData;

      if (useData === undefined) throw new Error("Move collector is missing");
      const data = useData({ threadIds: [] });
      const ready = useAtomValue(owner.preferencesReadyAtom());

      return (
        <div>{`collector ${ready ? "ready" : "closed"}; choices ${data === null ? "none" : data.length}`}</div>
      );
    }

    function Fixture() {
      const [attempt, setAttempt] = useState(0);

      return (
        <>
          <Toaster />
          <PluginSlotMount
            pluginId="thread-list"
            slotKind="appOverlay"
            slotId="preferences-sync-v1"
          >
            <PreferencesSyncController />
          </PluginSlotMount>
          <PluginSlotMount
            pluginId="thread-list"
            slotKind="threadAction"
            slotId="move"
          >
            <MoveCollector />
          </PluginSlotMount>
          <PluginSlotMount
            key={attempt}
            pluginId="thread-list"
            slotKind="threadList"
            slotId="thread-list"
            crashFallback={
              <ThreadListPlaceholder
                state={{
                  kind: "crashed",
                  pluginTitle: "Thread list",
                  onReload: () => {
                    resetCrashedPluginSlots("thread-list");
                    setAttempt((value) => value + 1);
                  },
                }}
              />
            }
          >
            <PreferencesSync />
            <div>primary mounted</div>
          </PluginSlotMount>
        </>
      );
    }

    const view = renderSlot(
      { component: Fixture },
      {},
      {
        pluginId: "thread-list",
        rpc: {
          listPreferences: () =>
            harness.behavior.callRpc("listPreferences", null),
          setPreference: (input: unknown) =>
            harness.behavior.callRpc("setPreference", input),
        },
      },
    );

    try {
      await screen.findByText("Thread list stopped working.");
      expect(screen.getByText("collector closed; choices none")).toBeDefined();
      expect(getDefaultStore().get(owner.preferencesReadyAtom())).toBe(false);
      expect(screen.queryByText("plugin thread-list crashed")).toBeNull();
      await screen.findByText(
        /omnyo plugin rpc call thread-list setPreference --input-file FILE/,
      );
      expect(
        view.rpcCalls.filter(({ method }) => method === "listPreferences"),
      ).toHaveLength(1);
      expect(
        view.rpcCalls.filter(({ method }) => method === "setPreference"),
      ).toEqual([]);
      expect(window.localStorage.getItem(currentKey)).toBe(original);

      const resolved = await harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "project",
      });

      expect(resolved).toEqual({ key: "organizationMode", value: "project" });
      const signal = harness.realtimeSignals.at(-1);

      if (signal === undefined)
        throw new Error("Current owner did not publish its committed field");
      await view.emitRealtime(signal.channel, signal.payload);
      await waitFor(() =>
        expect(getDefaultStore().get(owner.preferencesReadyAtom())).toBe(true),
      );
      expect(screen.getByText("collector ready; choices none")).toBeDefined();
      expect(
        JSON.parse(window.localStorage.getItem(receiptKey) ?? "null"),
      ).toMatchObject({
        originalRaw: original,
        acknowledged: { organizationMode: "project" },
      });
      expect(
        JSON.parse(window.localStorage.getItem(currentKey) ?? "null"),
      ).toMatchObject({
        organizationMode: "project",
        futureField: { opaque: "kept" },
      });
      expect(
        view.rpcCalls.filter(({ method }) => method === "setPreference"),
      ).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await screen.findByText("primary mounted");
      expect(screen.queryByText("Thread list stopped working.")).toBeNull();
      expect(getDefaultStore().get(owner.preferencesReadyAtom())).toBe(true);
      expect(await api.storage.kv.get("preference:organizationMode")).toBe(
        "project",
      );
      expect(
        JSON.parse(window.localStorage.getItem(receiptKey) ?? "null")
          .originalRaw,
      ).toBe(original);
    } finally {
      view.unmount();
      owner.resetPreferencesSyncForTest();
      owner.setPreferencesMirrorStorageForTest(undefined);

      for (const key of [legacyKey, currentKey, receiptKey])
        window.localStorage.removeItem(key);
      toast.dismiss("thread-list:preferences-import-v1");
    }
  });

  it("collapses a throwing slot to a crash chip and keeps siblings alive", () => {
    render(
      <>
        <PluginSlotMount
          pluginId="broken"
          slotKind="homepageSection"
          slotId="a"
        >
          <Bomb />
        </PluginSlotMount>
        <PluginSlotMount pluginId="fine" slotKind="homepageSection" slotId="b">
          <Healthy />
        </PluginSlotMount>
      </>,
    );

    expect(screen.getByText("plugin broken crashed")).toBeDefined();
    expect(screen.getByText("healthy slot")).toBeDefined();
  });

  it("renders nothing after a crash when the fallback is explicitly null", () => {
    render(
      <PluginSlotMount
        pluginId="broken"
        slotKind="appOverlay"
        slotId="widget"
        crashFallback={null}
      >
        <Bomb />
      </PluginSlotMount>,
    );

    expect(screen.queryByText("plugin broken crashed")).toBeNull();
  });

  it("holds slot children behind the pending fallback until the plugin stylesheet loads", () => {
    applyPluginCss("demo", "/demo.css?h=v1");
    render(
      <PluginSlotMount
        pluginId="demo"
        slotKind="sidebarFooterItem"
        slotId="status"
        pendingFallback={<div>slot styles loading</div>}
      >
        <Healthy />
      </PluginSlotMount>,
    );

    expect(screen.getByText("slot styles loading")).toBeDefined();
    expect(screen.queryByText("healthy slot")).toBeNull();

    act(() => {
      document.head
        .querySelector('link[data-omnyo-plugin-css="demo"]')
        ?.dispatchEvent(new Event("load"));
    });

    expect(screen.getByText("healthy slot")).toBeDefined();
    expect(screen.queryByText("slot styles loading")).toBeNull();
  });

  it("never mounts unstyled content and recovers when the stylesheet is retried", () => {
    applyPluginCss("demo", "/demo.css?h=v1");
    render(
      <PluginSlotMount
        pluginId="demo"
        slotKind="messageDirective"
        slotId="card"
      >
        <Healthy />
      </PluginSlotMount>,
    );

    const finish = (type: "load" | "error") =>
      act(() => {
        document.head
          .querySelector('link[data-omnyo-plugin-css="demo"]')
          ?.dispatchEvent(new Event(type));
      });

    finish("error");
    expect(screen.queryByText("healthy slot")).toBeNull();
    finish("error");
    expect(screen.queryByText("healthy slot")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry demo styles" }));
    finish("load");
    expect(screen.getByText("healthy slot")).toBeDefined();
  });

  it("keeps one sheet through simultaneous mounts and a portal until the final route unmount", async () => {
    vi.useFakeTimers();
    applyPluginCss("demo", "/demo.css?h=v1");

    function PortalContent() {
      return createPortal(<div>portalled plugin content</div>, document.body);
    }

    const view = render(
      <>
        <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="main">
          <Healthy />
        </PluginSlotMount>
        <PluginSlotMount
          pluginId="demo"
          slotKind="threadPanelAction"
          slotId="details"
        >
          <PortalContent />
        </PluginSlotMount>
      </>,
    );

    const pluginSheets = () =>
      document.head.querySelectorAll('link[data-omnyo-plugin-css="demo"]');

    expect(pluginSheets()).toHaveLength(1);
    act(() => {
      pluginSheets()[0]?.dispatchEvent(new Event("load"));
    });
    expect(screen.getByText("portalled plugin content")).toBeDefined();

    view.rerender(
      <PluginSlotMount
        pluginId="demo"
        slotKind="threadPanelAction"
        slotId="details"
      >
        <PortalContent />
      </PluginSlotMount>,
    );
    expect(pluginSheets()).toHaveLength(1);

    view.unmount();
    await act(async () => {});
    expect(pluginSheets()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(pluginSheets()).toHaveLength(1);
    expect(pluginSheets()[0]?.getAttribute("media")).toBe("not all");
  });

  it("keeps a crashed slot instance disabled for the session across remounts", () => {
    const first = render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Bomb />
      </PluginSlotMount>,
    );

    first.unmount();

    const childRender = vi.fn(() => <div>should not render</div>);

    function Child() {
      return childRender();
    }

    render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Child />
      </PluginSlotMount>,
    );
    expect(screen.getByText("plugin broken crashed")).toBeDefined();
    expect(childRender).not.toHaveBeenCalled();
  });

  it("re-enables a plugin's slots after resetCrashedPluginSlots (reload path)", () => {
    const first = render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Bomb />
      </PluginSlotMount>,
    );

    first.unmount();
    resetCrashedPluginSlots("broken");

    render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Healthy />
      </PluginSlotMount>,
    );
    expect(screen.getByText("healthy slot")).toBeDefined();
  });
});
