export {
  MOBILE_BRIDGE_VERSION,
  NATIVE_BRIDGE_GLOBAL,
  compareBridgeVersions,
  isBridgeUsable,
} from "./version.js";

export {
  parseNativeShellHandshake,
  safeAreaInsetsSchema,
  type NativeCapability,
  type NativeShellHandshake,
  type SafeAreaInsets,
} from "./handshake.js";

export {
  type NativeScreen,
  type PageCapability,
  parsePageToShellMessage,
  type BridgeSharePayload,
  type PageToShellMessage,
} from "./messages.js";

export {
  parseAppPath,
  parseShellToPageEvent,
  type BridgeResponse,
  type ShellToPageEvent,
} from "./events.js";

export {
  buildBridgeEventScript,
  buildBridgeInjectionScript,
  type NativeShellApi,
} from "./inject.js";
