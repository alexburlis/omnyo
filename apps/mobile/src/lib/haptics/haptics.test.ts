import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const savedPreference: { value: string | undefined } = { value: undefined };

  return {
    appState: { currentState: "active" },
    platform: { OS: "ios" },
    savedPreference,
    impact: vi.fn<(style: string) => Promise<void>>(),
    selection: vi.fn<() => Promise<void>>(),
    notification: vi.fn<(type: string) => Promise<void>>(),
  };
});

vi.mock("react-native", () => ({
  AppState: native.appState,
  Platform: native.platform,
}));

vi.mock("../native/preferences-storage", () => ({
  getPreferencesStorage: () => ({
    getString: () => native.savedPreference.value,
  }),
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Soft: "soft",
    Rigid: "rigid",
  },
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning",
    Error: "error",
  },
  impactAsync: native.impact,
  selectionAsync: native.selection,
  notificationAsync: native.notification,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.appState.currentState = "active";
  native.platform.OS = "ios";
  native.savedPreference.value = undefined;
});

it("plays iOS impacts, selection and outcome through the Taptic Engine adapter", async () => {
  const { haptic, iosHaptic } = await import("./haptics");

  haptic("impact-light");
  haptic("impact-medium");
  iosHaptic("selection");
  iosHaptic("success");

  expect(native.impact.mock.calls).toEqual([["soft"], ["rigid"]]);
  expect(native.selection).toHaveBeenCalledOnce();
  expect(native.notification).toHaveBeenCalledExactlyOnceWith("success");
});

it("keeps both haptic entry points quiet when the saved iOS preference is off", async () => {
  native.savedPreference.value = "false";
  const { haptic, iosHaptic } = await import("./haptics");

  haptic("impact-light");
  iosHaptic("success");

  expect(native.impact).not.toHaveBeenCalled();
  expect(native.notification).not.toHaveBeenCalled();
});

it("plays no iOS feedback while the app is inactive", async () => {
  native.appState.currentState = "inactive";
  const { haptic, iosHaptic } = await import("./haptics");

  haptic("impact-medium");
  iosHaptic("selection");
  native.appState.currentState = "active";
  iosHaptic("selection");

  expect(native.impact).not.toHaveBeenCalled();
  expect(native.selection).toHaveBeenCalledOnce();
});

it("preserves the Android impact for existing callers", async () => {
  native.platform.OS = "android";
  const { haptic, iosHaptic } = await import("./haptics");

  haptic("impact-light");
  iosHaptic("success");

  expect(native.impact).toHaveBeenCalledExactlyOnceWith("light");
  expect(native.notification).not.toHaveBeenCalled();
});
