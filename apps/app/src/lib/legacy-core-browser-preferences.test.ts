import { describe, expect, it } from "vitest";
import { importLegacyBrowserPreferences } from "./legacy-browser-preferences";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
  }

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

function imported(entries: Record<string, string>): Record<string, string> {
  const local = new MemoryStorage(entries);
  importLegacyBrowserPreferences({ local, session: new MemoryStorage() });

  return local.entries();
}

describe("core thread and panel preference import", () => {
  it.each([
    ["bb.thread.browserHistory-thr_1-1", "[]"],
    ["bb.thread.recentItems-thr_1-1", "[]"],
    ["bb.thread.conversation.collapsed-thr_1", "true"],
    ["bb.thread.model-fallback-dismissed.thr_1", "occurrence-7"],
    ["bb.thread.fixedPanelTabsState-thr_1-1", '{"version":1}'],
    ["bb.thread.gitDiff.displayMode", "split"],
    ["bb.thread.gitDiff.lineOverflowMode", "wrap"],
    ["bb.thread.secondaryPanel.widthPercent", "42"],
    ["bb.plugins.workspace.tabs", '{"tabs":[],"activePluginId":null}'],
    ["bb.settings.updates.dismissed-changelog-version", "0.46.300"],
  ])("moves %s to the omnyo key", (legacyKey, value) => {
    expect(imported({ [legacyKey]: value })).toEqual({
      [legacyKey.replace(/^bb/u, "omnyo")]: value,
    });
  });

  it("decodes the old split layout plugin id while copying", () => {
    const old =
      '{"root":{"content":{"kind":"plugin-panel","pluginId":"bb-secondary-panel-split"}}}';

    expect(
      imported({ "bb.thread.secondaryPanelSplitLayout.panel_1": old }),
    ).toEqual({
      "omnyo.thread.secondaryPanelSplitLayout.panel_1":
        '{"root":{"content":{"kind":"plugin-panel","pluginId":"omnyo-secondary-panel-split"}}}',
    });
  });

  it("drops an invalid legacy value and keeps a present canonical value", () => {
    expect(
      imported({
        "bb.thread.recentItems-thr_1-1": "not-json",
        "bb.thread.secondaryPanel.widthPercent": "10",
        "omnyo.thread.secondaryPanel.widthPercent": "55",
      }),
    ).toEqual({
      "omnyo.thread.secondaryPanel.widthPercent": "55",
    });
  });
});
