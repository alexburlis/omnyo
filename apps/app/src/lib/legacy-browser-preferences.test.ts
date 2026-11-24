import { describe, expect, it } from "vitest";
import { importLegacyBrowserPreferences } from "./legacy-browser-preferences";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  constructor(
    entries: Record<string, string> = {},
    private readonly quotaKeys: ReadonlySet<string> = new Set(),
  ) {
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
    if (this.quotaKeys.has(key))
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.values.set(key, value);
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

function runImport(
  localEntries: Record<string, string>,
  sessionEntries: Record<string, string> = {},
): { local: MemoryStorage; session: MemoryStorage } {
  const local = new MemoryStorage(localEntries);
  const session = new MemoryStorage(sessionEntries);
  importLegacyBrowserPreferences({ local, session });

  return { local, session };
}

describe("importLegacyBrowserPreferences", () => {
  it.each([
    ["bb.sidebar.open", "false", "omnyo.sidebar.open"],
    ["bb.sidebar.width", "312", "omnyo.sidebar.width"],
    ["bb.sidebar.scope", '{"kind":"inbox"}', "omnyo.sidebar.scope"],
    ["bb.onboarding.seen", "1", "omnyo.onboarding.seen"],
    ["bb.newTab.actionOrder", '["a"]', "omnyo.newTab.actionOrder"],
    [
      "bb.appearance.diffRenderer",
      '"automatic"',
      "omnyo.appearance.diffRenderer",
    ],
    ["bb.palette.threadSort", '"updated"', "omnyo.palette.threadSort"],
    ["bb.palette.recents", '["open"]', "omnyo.palette.recents"],
    ["bb.fileOpenerByExtension", "{}", "omnyo.fileOpenerByExtension"],
    ["bb.openLinksInAppBrowser", "false", "omnyo.openLinksInAppBrowser"],
    [
      "bb.splitLayout.dimInactiveSplits",
      "true",
      "omnyo.splitLayout.dimInactiveSplits",
    ],
    ["bb.workspaceOpenTarget", "vscode", "omnyo.workspaceOpenTarget"],
    ["bb.pullRequest.mergeMethod", "squash", "omnyo.pullRequest.mergeMethod"],
    ["bb.rewriteLocalhostLinks", "false", "omnyo.rewriteLocalhostLinks"],
    [
      "bb.sidebar.machineAttentionAcknowledged",
      '["host_1"]',
      "omnyo.sidebar.machineAttentionAcknowledged",
    ],
    [
      "bb.sidebar.pluginAttentionAcknowledged",
      "null",
      "omnyo.sidebar.pluginAttentionAcknowledged",
    ],
    [
      "bb.pluginComposerActionUsage.v1",
      '{"plugin":3}',
      "omnyo.pluginComposerActionUsage.v1",
    ],
    ["bb:browser-import:records", "{}", "omnyo:browser-import:records"],
    [
      "bb.threadCompanion.aside.glance/card",
      "false",
      "omnyo.threadCompanion.aside.glance/card",
    ],
  ])("moves %s", (legacyKey, value, canonicalKey) => {
    const { local } = runImport({ [legacyKey]: value });

    expect(local.entries()).toEqual({ [canonicalKey]: value });
  });

  it.each([
    ["bb.promptbox.provider", "codex", "omnyo.promptbox.provider"],
    ["bb.promptbox.service-tier", "fast", "omnyo.promptbox.service-tier"],
    ["bb.promptbox.permission-mode", "full", "omnyo.promptbox.permission-mode"],
    ["bb.promptbox.environment", "local", "omnyo.promptbox.environment"],
    ["bb.promptbox.model-codex-1", "gpt", "omnyo.promptbox.model-codex-1"],
    [
      "bb.promptbox.reasoning-codex-1",
      "high",
      "omnyo.promptbox.reasoning-codex-1",
    ],
    [
      "bb.promptbox.session-options-claude%20code-1",
      "{}",
      "omnyo.promptbox.session-options-claude%20code-1",
    ],
    [
      "bb.promptbox.environment-proj_1-1",
      "reuse",
      "omnyo.promptbox.environment-proj_1-1",
    ],
    [
      "bb.promptbox.machine-proj_1-1",
      "host_1",
      "omnyo.promptbox.machine-proj_1-1",
    ],
  ])("moves %s in both stores", (legacyKey, value, canonicalKey) => {
    const tabValue = value.startsWith("{") ? '{"tab":true}' : `${value}-tab`;

    const { local, session } = runImport(
      { [legacyKey]: value },
      { [legacyKey]: tabValue },
    );

    expect(local.entries()).toEqual({ [canonicalKey]: value });
    expect(session.entries()).toEqual({ [canonicalKey]: tabValue });
  });

  it("moves tab-scoped root-compose and split-layout keys in sessionStorage", () => {
    const { session } = runImport(
      {},
      {
        "bb.root-compose.project-id": "proj_1",
        "bb.splitLayout.maximizedPaneId": "pane-1",
      },
    );

    expect(session.entries()).toEqual({
      "omnyo.root-compose.project-id": "proj_1",
      "omnyo.splitLayout.maximizedPaneId": "pane-1",
    });
  });

  it("leaves prompt draft keys and unrelated keys to their owners", () => {
    const entries = {
      "bb.promptbox.contents-proj_1-thr_1-3": '{"text":"Draft"}',
      "bb.thread.browserHistory.thr_1": "[]",
      "bb.pending-chats.v1": "[]",
      "foreign.key": "kept",
    };

    expect(runImport(entries).local.entries()).toEqual(entries);
  });

  it("keeps the canonical value and retires the legacy copy on conflict", () => {
    const { local } = runImport({
      "bb.sidebar.width": "280",
      "omnyo.sidebar.width": "360",
    });

    expect(local.entries()).toEqual({ "omnyo.sidebar.width": "360" });
  });

  it("drops an invalid legacy value without writing the canonical key", () => {
    const { local } = runImport({
      "bb.sidebar.open": "maybe",
      "bb.sidebar.scope": "not json",
      "bb.sidebar.machineAttentionAcknowledged": '[{"bad":true}]',
    });

    expect(local.entries()).toEqual({});
  });

  it("runs again for a key an older tab wrote after the first import", () => {
    const local = new MemoryStorage({ "omnyo.sidebar.open": "true" });
    const session = new MemoryStorage();
    importLegacyBrowserPreferences({ local, session });
    local.setItem("bb.sidebar.open", "false");
    importLegacyBrowserPreferences({ local, session });

    expect(local.entries()).toEqual({ "omnyo.sidebar.open": "true" });
  });

  it("retains the legacy copy when the canonical write fails and still imports other keys", () => {
    const local = new MemoryStorage(
      { "bb.sidebar.open": "false", "bb.onboarding.seen": "1" },
      new Set(["omnyo.sidebar.open"]),
    );

    importLegacyBrowserPreferences({ local, session: new MemoryStorage() });

    expect(local.entries()).toEqual({
      "bb.sidebar.open": "false",
      "omnyo.onboarding.seen": "1",
    });
  });

  it("sweeps retired caches before importing so the import has quota", () => {
    const { local } = runImport({
      "bb.threadTimelineDisplay.v1": "cached",
      "bb.environmentWorkStatusDisplay.v1": "cached",
      "bb.sidebar.project-icon:v2:proj:src": "cached",
      "bb:timeline-gap-trace": "[]",
      "bb.sidebar.open": "true",
      "omnyo.threadTimelineDisplay.v1": "kept",
    });

    expect(local.entries()).toEqual({
      "omnyo.threadTimelineDisplay.v1": "kept",
      "omnyo.sidebar.open": "true",
    });
  });

  it("removes the retired watched-plugin list from sessionStorage", () => {
    const { session } = runImport(
      {},
      { "bb.watched-plugin-updates": '["plugin"]', foreign: "kept" },
    );

    expect(session.entries()).toEqual({ foreign: "kept" });
  });

  it("never throws when browser storage is unavailable", () => {
    const blocked = new Proxy(new MemoryStorage(), {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });

    expect(() =>
      importLegacyBrowserPreferences({
        local: blocked,
        session: new MemoryStorage({ "bb.sidebar.open": "false" }),
      }),
    ).not.toThrow();
  });
});
