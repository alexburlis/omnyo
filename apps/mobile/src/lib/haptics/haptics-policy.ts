import type { PageToShellMessage } from "@omnyo/mobile-bridge";

export type HapticKind = Extract<
  PageToShellMessage,
  { type: "haptic" }
>["kind"];

export type HapticCall =
  | { method: "selection" }
  | { method: "impact"; style: "light" | "medium" | "heavy" | "soft" | "rigid" }
  | { method: "notification"; type: "success" | "warning" | "error" };

export const HAPTICS_ENABLED_STORAGE_KEY = "omnyo.haptics.enabled";

const HAPTICS_ENABLED_DEFAULT = true;

export function parseHapticsEnabled(stored: string | undefined): boolean {
  if (stored === undefined) return HAPTICS_ENABLED_DEFAULT;

  return stored !== "false";
}

function serializeHapticsEnabled(enabled: boolean): string {
  return enabled ? "true" : "false";
}

export function resolveHapticCall(
  enabled: boolean,
  kind: HapticKind,
  isIos: boolean,
): HapticCall | null {
  if (!enabled) return null;

  switch (kind) {
    case "selection":
      return { method: "selection" };
    case "impact-light":
      return { method: "impact", style: isIos ? "soft" : "light" };
    case "impact-medium":
      return { method: "impact", style: isIos ? "rigid" : "medium" };
    case "impact-heavy":
      return { method: "impact", style: "heavy" };
    case "success":
      return { method: "notification", type: "success" };
    case "warning":
      return { method: "notification", type: "warning" };
    case "error":
      return { method: "notification", type: "error" };
  }
}

export interface HapticsPreferenceStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface HapticsPreferenceStore {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createHapticsPreferenceStore(
  storage: HapticsPreferenceStorage,
): HapticsPreferenceStore {
  const listeners = new Set<() => void>();

  let enabled = parseHapticsEnabled(
    storage.getString(HAPTICS_ENABLED_STORAGE_KEY),
  );

  return {
    isEnabled: () => enabled,
    setEnabled: (next) => {
      if (next === enabled) return;
      enabled = next;
      storage.set(HAPTICS_ENABLED_STORAGE_KEY, serializeHapticsEnabled(next));

      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
