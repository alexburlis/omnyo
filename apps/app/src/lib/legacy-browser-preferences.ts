type Normalize = (raw: string) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function json(isValid: (value: unknown) => boolean = () => true): Normalize {
  return (raw) => {
    try {
      return isValid(JSON.parse(raw)) ? raw : null;
    } catch {
      return null;
    }
  };
}

const text: Normalize = (raw) => raw;

const nonEmpty: Normalize = (raw) => (raw.length > 0 ? raw : null);

const flag: Normalize = (raw) =>
  raw === "true" || raw === "false" ? raw : null;

const finiteNumber: Normalize = (raw) =>
  raw.trim().length > 0 && Number.isFinite(Number(raw)) ? raw : null;

const LEGACY_SIDEBAR_SPLIT_PLUGIN_ID_FIELD =
  '"pluginId":"bb-secondary-panel-split"';

const SIDEBAR_SPLIT_PLUGIN_ID_FIELD =
  '"pluginId":"omnyo-secondary-panel-split"';

const sidebarSplitLayout: Normalize = (raw) => {
  const value = json(isRecord)(raw);

  return (
    value?.replaceAll(
      LEGACY_SIDEBAR_SPLIT_PLUGIN_ID_FIELD,
      SIDEBAR_SPLIT_PLUGIN_ID_FIELD,
    ) ?? null
  );
};

const stringList = json(isStringArray);

const objectValue = json(isRecord);

const anyJson = json();

const exactPreferences: ReadonlyMap<string, Normalize> = new Map([
  ["bb.sidebar.open", flag],
  ["bb.sidebar.width", finiteNumber],
  ["bb.sidebar.scope", objectValue],
  ["bb.sidebar.machineAttentionAcknowledged", stringList],
  ["bb.sidebar.pluginAttentionAcknowledged", json(isNullableString)],
  ["bb.onboarding.seen", (raw) => (raw === "1" ? raw : null)],
  ["bb.newTab.actionOrder", stringList],
  ["bb.appearance.sourceCodeRenderer", json(isString)],
  ["bb.appearance.diffRenderer", json(isString)],
  ["bb.palette.threadArchiveFilter", json(Array.isArray)],
  ["bb.palette.threadSort", json(isString)],
  ["bb.palette.threadSortDirection", json(isString)],
  ["bb.palette.recents", json(Array.isArray)],
  ["bb.fileOpenerByExtension", objectValue],
  ["bb.openLinksInAppBrowser", flag],
  ["bb.root-compose.project-id", nonEmpty],
  ["bb.root-compose.reuse-environment", text],
  ["bb.root-compose.placement", anyJson],
  ["bb.root-compose.navigate-after-create", flag],
  ["bb.splitLayout", anyJson],
  ["bb.splitLayout.maximizedPaneId", text],
  ["bb.splitLayout.dimInactiveSplits", flag],
  ["bb.workspaceOpenTarget", nonEmpty],
  ["bb.fileOpenTarget", nonEmpty],
  ["bb.pullRequest.mergeMethod", nonEmpty],
  ["bb.rewriteLocalhostLinks", flag],
  ["bb.pluginComposerActionUsage.v1", objectValue],
  ["bb:browser-import:records", objectValue],
  ["bb.promptbox.provider", text],
  ["bb.promptbox.service-tier", text],
  ["bb.promptbox.permission-mode", text],
  ["bb.promptbox.environment", text],
  ["bb.thread.gitDiff.displayMode", text],
  ["bb.thread.gitDiff.lineOverflowMode", text],
  ["bb.thread.secondaryPanel.widthPercent", finiteNumber],
  ["bb.plugins.workspace.tabs", objectValue],
  ["bb.settings.updates.dismissed-changelog-version", text],
]);

const preferenceFamilies: ReadonlyArray<readonly [RegExp, Normalize]> = [
  [/^bb\.threadCompanion\.aside\..+$/u, flag],
  [/^bb\.promptbox\.(?:model|reasoning|environment|machine)-.+-1$/u, text],
  [/^bb\.promptbox\.session-options-.+-1$/u, objectValue],
  [/^bb\.thread\.browserHistory-.+$/u, json(Array.isArray)],
  [/^bb\.thread\.recentItems-.+$/u, json(Array.isArray)],
  [/^bb\.thread\.secondaryPanelSplitLayout\..+$/u, sidebarSplitLayout],
  [/^bb\.thread\.conversation\.collapsed-.+$/u, flag],
  [/^bb\.thread\.model-fallback-dismissed\..+$/u, text],
  [/^bb\.thread\.fixedPanelTabsState-.+$/u, objectValue],
];

const retiredKeys: ReadonlySet<string> = new Set([
  "bb.threadTimelineDisplay.v1",
  "bb.environmentWorkStatusDisplay.v1",
  "bb:timeline-gap-trace",
  "bb.watched-plugin-updates",
]);

const RETIRED_PROJECT_ICON_PREFIX = "bb.sidebar.project-icon:v2:";

function normalizerFor(key: string): Normalize | null {
  const exact = exactPreferences.get(key);

  if (exact) return exact;

  for (const [pattern, normalize] of preferenceFamilies) {
    if (pattern.test(key)) return normalize;
  }

  return null;
}

function storedKeys(storage: Storage): string[] {
  const keys: string[] = [];

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);

    if (key !== null) keys.push(key);
  }

  return keys;
}

function canonicalKey(legacyKey: string): string {
  return legacyKey.replace(/^bb(?=[.:])/u, "omnyo");
}

function importPreference(
  storage: Storage,
  legacyKey: string,
  normalize: Normalize,
): void {
  const raw = storage.getItem(legacyKey);

  if (raw === null) return;
  const canonical = canonicalKey(legacyKey);
  const value = normalize(raw);

  if (value !== null && storage.getItem(canonical) === null)
    storage.setItem(canonical, value);

  storage.removeItem(legacyKey);
}

function sweepRetiredKeys(storage: Storage): void {
  for (const key of storedKeys(storage)) {
    if (retiredKeys.has(key) || key.startsWith(RETIRED_PROJECT_ICON_PREFIX))
      storage.removeItem(key);
  }
}

function importStore(storage: Storage): void {
  for (const key of storedKeys(storage)) {
    const normalize = normalizerFor(key);

    if (!normalize) continue;

    try {
      importPreference(storage, key, normalize);
    } catch {}
  }
}

function importBrowserPreferences(resolveStorage: () => Storage): void {
  try {
    const storage = resolveStorage();

    try {
      sweepRetiredKeys(storage);
    } catch {}

    importStore(storage);
  } catch {}
}

export function importLegacyBrowserPreferences(input?: {
  local: Storage;
  session: Storage;
}): void {
  importBrowserPreferences(() => input?.local ?? window.localStorage);
  importBrowserPreferences(() => input?.session ?? window.sessionStorage);
}
