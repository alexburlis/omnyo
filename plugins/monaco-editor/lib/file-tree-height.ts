export const DEFAULT_TREE_HEIGHT = 256;

export const MIN_TREE_HEIGHT = 96;

export const MIN_EDITOR_HEIGHT = 120;

const STORAGE_KEY = "omnyo-plugin-monaco-editor:file-tree-height";

const LEGACY_STORAGE_KEY_V1 = "bb-plugin-monaco-editor:file-tree-height";

function readStoredTreeHeightValue(): string | null {
  const canonical = window.localStorage.getItem(STORAGE_KEY);

  if (canonical !== null) return canonical;

  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY_V1);

  if (legacy === null) return null;

  try {
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {}

  return legacy;
}

export function clampTreeHeight(height: number, available: number): number {
  const max = Math.max(MIN_TREE_HEIGHT, available - MIN_EDITOR_HEIGHT);

  return Math.round(Math.min(Math.max(height, MIN_TREE_HEIGHT), max));
}

export function readStoredTreeHeight(): number {
  try {
    const raw = readStoredTreeHeightValue();

    if (raw === null) return DEFAULT_TREE_HEIGHT;
    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TREE_HEIGHT;

    return Math.max(parsed, MIN_TREE_HEIGHT);
  } catch {
    return DEFAULT_TREE_HEIGHT;
  }
}

export function storeTreeHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(height)));
  } catch {}
}
