import type { BrowserWindowConstructorOptions, Event } from "electron";
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  PRIMARY_WINDOW_STATE_KEY,
  type DisplayWorkArea,
  type WindowBounds,
  type WindowStateKey,
} from "./types.js";
import {
  persistBrowserWindowStates,
  readPersistedWindowStateEntries,
  removePersistedWindowState,
  restoreBrowserWindowState,
  type PersistBrowserWindowStateSnapshot,
  type StatefulBrowserWindow,
} from "./window-state.js";
import { resolveDesktopExternalUrl } from "./desktop-external-url.js";
import type { DesktopContextMenuWebContents } from "./desktop-context-menu.js";
import {
  createDesktopWindowNavigation,
  type DesktopWindowNavigationEvents,
} from "./desktop-window-navigation.js";

type DesktopWindowEvents = DesktopWindowNavigationEvents & {
  "context-menu": Parameters<
    Parameters<DesktopContextMenuWebContents["on"]>[1]
  >;
  "did-change-theme-color": [event: Event, color: string | null];
  "did-finish-load": [];
};

type DesktopWindowIcon = BrowserWindowConstructorOptions["icon"];

const MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET = 18;

const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET,
  y: MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET,
};

interface DesktopWindowOpenDetails {
  url: string;
}

interface DesktopWindowOpenHandlerResult {
  action: "deny";
}

export type DesktopWindowOpenHandler = (
  details: DesktopWindowOpenDetails,
) => DesktopWindowOpenHandlerResult;

export interface DesktopWindowOpenDevToolsOptions {
  mode: "detach";
}

export interface DesktopWindowWebContents extends DesktopContextMenuWebContents {
  id: number;
  getURL(): string;
  on<K extends keyof DesktopWindowEvents>(
    eventName: K,
    listener: (...args: DesktopWindowEvents[K]) => void,
  ): void;
  removeListener<K extends keyof DesktopWindowNavigationEvents>(
    eventName: K,
    listener: (...args: DesktopWindowNavigationEvents[K]) => void,
  ): void;
  openDevTools(options: DesktopWindowOpenDevToolsOptions): void;
  setWindowOpenHandler(handler: DesktopWindowOpenHandler): void;
  setZoomFactor(factor: number): void;
}

export interface DesktopBrowserWindow extends StatefulBrowserWindow {
  readonly id: number;
  focus(): void;
  isMinimized(): boolean;
  loadURL(url: string): Promise<void>;
  maximize(): void;
  on(
    eventName: "close" | "closed" | "enter-full-screen" | "leave-full-screen",
    listener: () => void,
  ): void;
  once(eventName: "ready-to-show", listener: () => void): void;
  restore(): void;
  setFullScreen(isFullScreen: boolean): void;
  setBackgroundColor(color: string): void;
  show(): void;
  webContents: DesktopWindowWebContents;
}

export interface DesktopBrowserWindowCreator {
  create(options: BrowserWindowConstructorOptions): DesktopBrowserWindow;
}

interface OpenExternalUrlArgs {
  url: string;
}

interface CreateDesktopWindowFactoryArgs {
  browserWindowCreator: DesktopBrowserWindowCreator;
  createWindowStateKey(): WindowStateKey;
  displayWorkAreas: DisplayWorkArea[] | null;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  isQuitting(): boolean;
  getServerTargetGeneration(): number;
  logWarning(message: string): void;
  shouldUseDarkColors(): boolean;
  openExternalUrl(args: OpenExternalUrlArgs): void;
  preloadPath: string;
  userDataPath: string;
  resolveInitialUrl?(args: {
    stateKey: WindowStateKey;
    initialUrl: string | null;
  }): string | null;
  onNavigation?(args: {
    stateKey: WindowStateKey;
    url: string;
    webContentsId: number;
  }): void;
}

interface CreateDesktopWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface RestoreDesktopWindowsArgs {
  initialUrl: string | null;
}

interface LoadDesktopWindowsUrlArgs {
  url: string;
}

export interface DesktopWindowFactory {
  createWindow(args: CreateDesktopWindowArgs): Promise<DesktopBrowserWindow>;
  focusFirstWindow(): boolean;
  hasOpenWindows(): boolean;
  loadUrl(args: LoadDesktopWindowsUrlArgs): Promise<void>;
  openDevTools(): void;
  persistOpenWindows(): Promise<void>;
  restoreSavedWindows(
    args: RestoreDesktopWindowsArgs,
  ): Promise<DesktopBrowserWindow[]>;
}

interface DesktopWindowEntry {
  browserWindow: DesktopBrowserWindow;
  navigation: ReturnType<typeof createDesktopWindowNavigation>;
}

interface ResolveWindowStateKeyArgs {
  activeWindows: Map<WindowStateKey, DesktopWindowEntry>;
  createWindowStateKey(): WindowStateKey;
  pendingStateKeys: Set<WindowStateKey>;
  requestedStateKey: WindowStateKey | null;
}

interface CreateWindowOptionsArgs {
  backgroundColor: string;
  bounds: WindowBounds;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  preloadPath: string;
}

function resolveWindowStateKey(
  args: ResolveWindowStateKeyArgs,
): WindowStateKey {
  if (args.requestedStateKey !== null) {
    return args.requestedStateKey;
  }

  if (
    !args.activeWindows.has(PRIMARY_WINDOW_STATE_KEY) &&
    !args.pendingStateKeys.has(PRIMARY_WINDOW_STATE_KEY)
  ) {
    return PRIMARY_WINDOW_STATE_KEY;
  }

  let stateKey = args.createWindowStateKey();

  while (
    args.activeWindows.has(stateKey) ||
    args.pendingStateKeys.has(stateKey)
  ) {
    stateKey = args.createWindowStateKey();
  }

  return stateKey;
}

function createWindowOptions(
  args: CreateWindowOptionsArgs,
): BrowserWindowConstructorOptions {
  return {
    backgroundColor: args.backgroundColor,
    ...(args.isLinuxFrameless ? { frame: false } : {}),
    ...(args.isLinuxTransparent
      ? { backgroundColor: "#00000000", transparent: true }
      : {}),
    ...(args.isMac
      ? {
          frame: false,
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
        }
      : { autoHideMenuBar: true }),
    height: args.bounds.height,
    icon: args.icon,
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    show: false,
    title: "Omnyo",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
      spellcheck: true,
    },
    width: args.bounds.width,
    x: args.bounds.x,
    y: args.bounds.y,
  };
}

export function createDesktopWindowFactory(
  args: CreateDesktopWindowFactoryArgs,
): DesktopWindowFactory {
  const activeWindows = new Map<WindowStateKey, DesktopWindowEntry>();
  const pendingStateKeys = new Set<WindowStateKey>();

  async function createWindow(
    createArgs: CreateDesktopWindowArgs,
  ): Promise<DesktopBrowserWindow> {
    const stateKey = resolveWindowStateKey({
      activeWindows,
      createWindowStateKey: args.createWindowStateKey,
      pendingStateKeys,
      requestedStateKey: createArgs.stateKey,
    });

    pendingStateKeys.add(stateKey);

    try {
      const restoredState = await restoreBrowserWindowState({
        displayWorkAreas: args.displayWorkAreas,
        stateKey,
        userDataPath: args.userDataPath,
      });

      const browserWindow = args.browserWindowCreator.create(
        createWindowOptions({
          backgroundColor: args.shouldUseDarkColors() ? "#151515" : "#ffffff",
          bounds: restoredState.bounds,
          icon: args.icon,
          isLinuxTransparent: args.isLinuxTransparent,
          isMac: args.isMac,
          isLinuxFrameless: args.isLinuxFrameless,
          preloadPath: args.preloadPath,
        }),
      );

      if (!args.isLinuxTransparent) {
        browserWindow.webContents.on(
          "did-change-theme-color",
          (_event, color) => {
            if (color !== null) {
              browserWindow.setBackgroundColor(color);
            }
          },
        );
      }

      browserWindow.webContents.session.setSpellCheckerEnabled(true);

      const navigation = createDesktopWindowNavigation({
        browserWindow,
        getServerTargetGeneration: args.getServerTargetGeneration,
        isQuitting: args.isQuitting,
        logWarning: args.logWarning,
      });

      activeWindows.set(stateKey, { browserWindow, navigation });
      browserWindow.webContents.on("did-finish-load", () => {
        args.onNavigation?.({
          stateKey,
          url: browserWindow.webContents.getURL(),
          webContentsId: browserWindow.webContents.id,
        });
      });

      if (restoredState.isMaximized) {
        browserWindow.maximize();
      }

      if (restoredState.isFullScreen) {
        browserWindow.setFullScreen(true);
      }

      browserWindow.once("ready-to-show", () => {
        browserWindow.show();
      });
      browserWindow.on("closed", () => {
        navigation.stop();
        activeWindows.delete(stateKey);

        if (!args.isQuitting()) {
          void removePersistedWindowState({
            stateKey,
            userDataPath: args.userDataPath,
          });
        }
      });
      browserWindow.webContents.setWindowOpenHandler((details) => {
        const url = resolveDesktopExternalUrl(details.url);

        if (url !== null) {
          args.openExternalUrl({ url });
        }

        return { action: "deny" };
      });

      const initialUrl =
        args.resolveInitialUrl === undefined
          ? createArgs.initialUrl
          : args.resolveInitialUrl({
              stateKey,
              initialUrl: createArgs.initialUrl,
            });

      if (initialUrl !== null) {
        browserWindow.webContents.setZoomFactor(1);
        await navigation.load(initialUrl);
      }

      return browserWindow;
    } finally {
      pendingStateKeys.delete(stateKey);
    }
  }

  async function restoreSavedWindows(
    restoreArgs: RestoreDesktopWindowsArgs,
  ): Promise<DesktopBrowserWindow[]> {
    const entries = await readPersistedWindowStateEntries({
      userDataPath: args.userDataPath,
    });

    if (entries.length === 0) {
      return [
        await createWindow({
          initialUrl: restoreArgs.initialUrl,
          stateKey: PRIMARY_WINDOW_STATE_KEY,
        }),
      ];
    }

    const restoredWindows: DesktopBrowserWindow[] = [];

    for (const entry of entries) {
      restoredWindows.push(
        await createWindow({
          initialUrl: restoreArgs.initialUrl,
          stateKey: entry.stateKey,
        }),
      );
    }

    return restoredWindows;
  }

  async function loadUrl(args: LoadDesktopWindowsUrlArgs): Promise<void> {
    const loadPromises: Promise<void>[] = [];

    for (const { browserWindow, navigation } of activeWindows.values()) {
      browserWindow.webContents.setZoomFactor(1);
      loadPromises.push(navigation.load(args.url).then(() => undefined));
    }

    await Promise.all(loadPromises);
  }

  function focusFirstWindow(): boolean {
    for (const { browserWindow } of activeWindows.values()) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }

      browserWindow.focus();

      return true;
    }

    return false;
  }

  function openDevTools(): void {
    for (const { browserWindow } of activeWindows.values()) {
      browserWindow.webContents.openDevTools({ mode: "detach" });
    }
  }

  async function persistOpenWindows(): Promise<void> {
    const snapshots: PersistBrowserWindowStateSnapshot[] = [];

    for (const [stateKey, { browserWindow }] of activeWindows.entries()) {
      snapshots.push({ browserWindow, stateKey });
    }

    await persistBrowserWindowStates({
      snapshots,
      userDataPath: args.userDataPath,
    });
  }

  return {
    createWindow,
    focusFirstWindow,
    hasOpenWindows() {
      return activeWindows.size > 0;
    },
    loadUrl,
    openDevTools,
    persistOpenWindows,
    restoreSavedWindows,
  };
}
