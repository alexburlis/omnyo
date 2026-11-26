import {
  compareBridgeVersions,
  isBridgeUsable,
  NATIVE_BRIDGE_GLOBAL,
  parseNativeShellHandshake,
  parseShellToPageEvent,
  safeAreaInsetsSchema,
  type NativeScreen,
  type NativeCapability,
  type NativeShellHandshake,
  type PageCapability,
  type PageToShellMessage,
  type SafeAreaInsets,
  type ShellToPageEvent,
} from "@omnyo/mobile-bridge";

interface NativeBridgeGlobal {
  post(message: unknown): void;
  request(kind: string, payload: unknown): Promise<unknown>;
  copyTextAndImage?(text: string, imageUrl: string): Promise<unknown>;
  copyRichText?(text: string, html: string): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  safeArea?: unknown;
}

export interface NativeShell {
  handshake: NativeShellHandshake;
  safeArea(): SafeAreaInsets;
  has(capability: NativeCapability): boolean;
  post(message: unknown): void;
  request(kind: string, payload: unknown): Promise<unknown>;
  copyTextAndImage?(text: string, imageUrl: string): Promise<unknown>;
  copyRichText?(text: string, html: string): Promise<unknown>;
  subscribe(listener: (event: ShellToPageEvent) => void): () => void;
}

function readBridgeGlobal(): NativeBridgeGlobal | null {
  if (typeof window === "undefined") return null;

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const root = (window as unknown as Record<string, unknown>)[
    NATIVE_BRIDGE_GLOBAL
  ];

  if (typeof root !== "object" || root === null) return null;
  const native = (root as Record<string, unknown>).native;

  if (typeof native !== "object" || native === null) return null;
  const candidate = native as Partial<NativeBridgeGlobal>;

  if (
    typeof candidate.post !== "function" ||
    typeof candidate.request !== "function" ||
    typeof candidate.subscribe !== "function"
  ) {
    return null;
  }

  return native as NativeBridgeGlobal;
}

const KNOWN_CAPABILITIES: Record<NativeCapability, true> = {
  haptic: true,
  badge: true,
  share: true,
  "open-external": true,
  "safe-area": true,
  "open-native": true,
};

function isKnownCapability(value: unknown): value is NativeCapability {
  return typeof value === "string" && Object.hasOwn(KNOWN_CAPABILITIES, value);
}

function pickKnownCapabilities(value: unknown): unknown {
  return Array.isArray(value) ? value.filter(isKnownCapability) : value;
}

function pickHandshakeFields(bridge: NativeBridgeGlobal): unknown {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const source = bridge as unknown as Record<string, unknown>;

  return {
    bridgeVersion: source.bridgeVersion,
    appVersion: source.appVersion,
    androidVersionCode: source.androidVersionCode,
    platform: source.platform,
    profileMode: source.profileMode,
    secureContext: source.secureContext,
    safeArea: source.safeArea,
    capabilities: pickKnownCapabilities(source.capabilities),
  };
}

function buildNativeShell(): NativeShell | null {
  const bridge = readBridgeGlobal();

  if (bridge === null) return null;
  const handshake = parseNativeShellHandshake(pickHandshakeFields(bridge));

  if (handshake === null) return null;

  if (!isBridgeUsable(compareBridgeVersions(handshake.bridgeVersion))) {
    return null;
  }

  const capabilities = new Set<NativeCapability>(handshake.capabilities);

  return {
    handshake,
    safeArea: () => {
      const live = safeAreaInsetsSchema.safeParse(bridge.safeArea);

      return live.success ? live.data : handshake.safeArea;
    },
    has: (capability) => capabilities.has(capability),
    post: (message) => bridge.post(message),
    request: (kind, payload) => bridge.request(kind, payload),
    copyRichText:
      typeof bridge.copyRichText === "function"
        ? bridge.copyRichText.bind(bridge)
        : undefined,
    copyTextAndImage:
      typeof bridge.copyTextAndImage === "function"
        ? bridge.copyTextAndImage.bind(bridge)
        : undefined,
    subscribe: (listener) =>
      bridge.subscribe((event) => {
        const parsed = parseShellToPageEvent(event);

        if (parsed !== null) listener(parsed);
      }),
  };
}

let cached: NativeShell | null = null;

export function getNativeShell(): NativeShell | null {
  cached ??= buildNativeShell();

  return cached;
}

export function resetNativeShellForTests(): void {
  cached = null;
}

export function isInsideNativeShell(): boolean {
  return getNativeShell() !== null;
}

export function shellHaptic(
  kind: Extract<PageToShellMessage, { type: "haptic" }>["kind"],
): void {
  const shell = getNativeShell();

  if (shell?.handshake.platform === "ios" && shell.has("haptic")) {
    shell.post({ type: "haptic", kind });
  }
}

export function shellOpenExternal(url: string): boolean {
  const shell = getNativeShell();

  if (shell === null || !shell.has("open-external")) return false;
  shell.post({ type: "open-external", url });

  return true;
}

export function shellOpenNative(screen: NativeScreen): boolean {
  const shell = getNativeShell();

  if (shell === null || !shell.has("open-native")) return false;
  shell.post({ type: "open-native", screen });

  return true;
}

export function canOpenNativeScreen(): boolean {
  const shell = getNativeShell();

  return shell !== null && shell.has("open-native");
}

export interface NativeShellServerSummary {
  host: string;
  mode: NativeShellHandshake["profileMode"];
}

export function nativeShellServerSummary(): NativeShellServerSummary | null {
  const shell = getNativeShell();

  if (shell === null) return null;

  return { host: window.location.host, mode: shell.handshake.profileMode };
}

export function shellReportReady(path: string): void {
  getNativeShell()?.post({ type: "ready", path });
}

export function shellReportCapabilities(
  capabilities: readonly PageCapability[],
): void {
  getNativeShell()?.post({ type: "capabilities", capabilities });
}

export function shellReportPath(title: string, path: string): void {
  getNativeShell()?.post({ type: "title", title, path });
}
