import {
  buildBridgeInjectionScript,
  parsePageToShellMessage,
  type NativeShellHandshake,
  type PageToShellMessage,
} from "@omnyo/mobile-bridge";
import { resetNativeShellForTests } from "@/lib/native-shell";

const TEST_HANDSHAKE: NativeShellHandshake = {
  bridgeVersion: 3,
  appVersion: "0.40.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: [
    "haptic",
    "badge",
    "share",
    "open-external",
    "safe-area",
    "open-native",
  ],
};

export interface InstalledNativeShell {
  messages(): PageToShellMessage[];
}

export function installNativeShellForTest(
  overrides: Partial<NativeShellHandshake> = {},
): InstalledNativeShell {
  const posted: string[] = [];

  Object.defineProperty(window, "ReactNativeWebView", {
    configurable: true,
    value: {
      postMessage: (raw: string) => {
        posted.push(raw);
      },
    },
  });
  new Function(
    "window",
    buildBridgeInjectionScript({ ...TEST_HANDSHAKE, ...overrides }),
  )(window);
  resetNativeShellForTests();

  return {
    messages: () =>
      posted.map((raw) => {
        const parsed = parsePageToShellMessage(raw);

        if (!parsed.ok)
          throw new Error(`shell could not parse: ${parsed.reason}`);

        return parsed.message;
      }),
  };
}

export function removeNativeShellForTest(): void {
  Reflect.deleteProperty(window, "omnyo");
  Reflect.deleteProperty(window, "ReactNativeWebView");
  resetNativeShellForTests();
}
