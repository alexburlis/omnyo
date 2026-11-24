import { expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  extra: { omnyoMobileVariant: "private" },
  navigation: vi.fn(() => {
    throw new Error("relay enrollment mounted");
  }),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: control.extra } },
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: "screen", Toolbar: "toolbar" },
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useNavigation: control.navigation,
  useLocalSearchParams: () => ({}),
}));

vi.mock("react-native", () => ({ View: "view" }));

vi.mock("@/app-shell", () => ({ useProfiles: vi.fn() }));

vi.mock("@/data/connect", () => ({
  DEFAULT_CONNECT_APEX_URL: "https://omnyo.link",
  describeEnrollmentError: vi.fn(),
  redeemEnrollment: vi.fn(),
  resolveEnrollmentTarget: vi.fn(),
}));

vi.mock("@/lib/device-label", () => ({ describeThisDevice: vi.fn() }));

vi.mock("@/lib/haptics", () => ({ iosHaptic: vi.fn() }));

vi.mock("@/theme", () => ({ useTheme: vi.fn() }));

vi.mock("@/ui", () => ({
  Button: "button",
  GroupedRow: "row",
  Icon: "icon",
  Input: "input",
  Spinner: "spinner",
  Text: "text",
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../settings/GroupedScreen", () => ({ GroupedScreen: "group" }));

vi.mock("../settings/settings-badges", () => ({ useBadgeColors: vi.fn() }));

vi.mock("../settings/SettingsRows", () => ({ SettingsSection: "section" }));

vi.mock("./AccountServersList", () => ({ AccountServersList: "accounts" }));

vi.mock("./ConnectScanner", () => ({ ConnectScanner: "scanner" }));

import { ConnectEnrollScreen } from "./ConnectEnrollScreen";

it("mounts relay pairing in the private build instead of a retired notice", () => {
  expect(control.extra.omnyoMobileVariant).toBe("private");
  expect(() => ConnectEnrollScreen()).toThrow("relay enrollment mounted");
  expect(control.navigation).toHaveBeenCalledOnce();
});
