import * as Haptics from "expo-haptics";
import { useCallback, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import {
  createHapticsPreferenceStore,
  resolveHapticCall,
  type HapticCall,
  type HapticKind,
  type HapticsPreferenceStore,
} from "./haptics-policy";
import { getPreferencesStorage } from "../native/preferences-storage";

let store: HapticsPreferenceStore | null = null;

function getHapticsPreferenceStore(): HapticsPreferenceStore {
  store ??= createHapticsPreferenceStore(getPreferencesStorage());

  return store;
}

const IMPACT_STYLES = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
  soft: Haptics.ImpactFeedbackStyle.Soft,
  rigid: Haptics.ImpactFeedbackStyle.Rigid,
} as const;

const NOTIFICATION_TYPES = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  error: Haptics.NotificationFeedbackType.Error,
} as const;

async function performHapticCall(call: HapticCall): Promise<void> {
  switch (call.method) {
    case "selection":
      await Haptics.selectionAsync();

      return;
    case "impact":
      await Haptics.impactAsync(IMPACT_STYLES[call.style]);

      return;
    case "notification":
      await Haptics.notificationAsync(NOTIFICATION_TYPES[call.type]);

      return;
  }
}

export function haptic(kind: HapticKind): void {
  const isIos = Platform.OS === "ios";

  if (isIos && AppState.currentState !== "active") return;

  const call = resolveHapticCall(
    getHapticsPreferenceStore().isEnabled(),
    kind,
    isIos,
  );

  if (call === null) return;
  performHapticCall(call).catch(() => undefined);
}

export function iosHaptic(kind: HapticKind): void {
  if (Platform.OS === "ios") haptic(kind);
}

export function useHapticsEnabled(): [boolean, (enabled: boolean) => void] {
  const preference = getHapticsPreferenceStore();

  const enabled = useSyncExternalStore(
    preference.subscribe,
    preference.isEnabled,
    preference.isEnabled,
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      if (next === preference.isEnabled()) return;
      preference.setEnabled(next);

      if (next) haptic("impact-light");
    },
    [preference],
  );

  return [enabled, setEnabled];
}
