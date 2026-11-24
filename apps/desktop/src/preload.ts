import { workflowImportReferenceSchema } from "@omnyo/desktop-contract";
import {
  TAKE_WORKFLOW_IMPORT_CHANNEL,
  WORKFLOW_IMPORT_READY_CHANNEL,
} from "./workflow-import-ipc.js";
import {
  omnyoDesktopServerChoicesSchema,
  type OmnyoDesktopServerChoice,
} from "@omnyo/desktop-contract";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { DESKTOP_NOTIFICATION_DELIVER_CHANNEL } from "./desktop-notifications-ipc.js";
import { OMNYO_DESKTOP_SET_ATTENTION_CHANNEL } from "./desktop-attention-ipc.js";
import { appCommandIdSchema, type AppCommandId } from "@omnyo/domain";
import {
  desktopBrowserCookieSyncStatusSchema,
  desktopBrowserImportOutcomeSchema,
  desktopBrowserImportSelectionSchema,
  desktopBrowserImportSourceSchema,
} from "@omnyo/host-daemon-contract";
import { z } from "zod";
import {
  omnyoDesktopBrowserEvaluateResultSchema,
  omnyoDesktopBrowserFindResultSchema,
  omnyoDesktopBrowserOpenTabRequestSchema,
  omnyoDesktopBrowserPageMessageSchema,
  omnyoDesktopBrowserScopedOpenTabRequestSchema,
  omnyoDesktopBrowserTabRefSchema,
  omnyoDesktopBrowserSnapshotSchema,
  omnyoDesktopBrowserStateSchema,
  omnyoDesktopBrowserTargetSchema,
  omnyoDesktopBrowserControlStateSchema,
  omnyoDesktopBrowserRevealRequestSchema,
  type OmnyoDesktopBrowserControlState,
  type OmnyoDesktopClipboardContent,
  type OmnyoDesktopBrowserRevealRequest,
  omnyoDesktopInfoSchema,
  omnyoDesktopNativeFileClassificationsSchema,
  omnyoDesktopWindowStateSchema,
  type OmnyoDesktopApi,
  type OmnyoDesktopAppCommandHandler,
  type OmnyoDesktopOpenThreadHandler,
  type OmnyoDesktopBrowserApi,
  type OmnyoDesktopBrowserFindResultHandler,
  type OmnyoDesktopWindowFindRequest,
  type OmnyoDesktopBrowserPageMessageHandler,
  type OmnyoDesktopBrowserOpenTabHandler,
  type OmnyoDesktopBrowserScopedOpenTabHandler,
  type OmnyoDesktopBrowserFocusHandler,
  type OmnyoDesktopBrowserSnapshotHandler,
  type OmnyoDesktopBrowserStateHandler,
  type OmnyoDesktopBrowserUnsubscribe,
  type OmnyoDesktopBrowserViewBounds,
  type OmnyoDesktopCloseWindowRequestHandler,
  type OmnyoDesktopInfo,
  type OmnyoDesktopInfoChangeHandler,
  type OmnyoDesktopInfoUnsubscribe,
  type OmnyoDesktopOpenNewTabHandler,
  type OmnyoDesktopTheme,
  type OmnyoDesktopWindowState,
  type OmnyoDesktopWindowStateChangeHandler,
  type OmnyoDesktopZoomChangeHandler,
} from "@omnyo/desktop-contract";
import {
  OMNYO_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  OMNYO_DESKTOP_GET_INFO_CHANNEL,
  OMNYO_DESKTOP_INFO_CHANGED_CHANNEL,
  OMNYO_DESKTOP_INSTALL_UPDATE_CHANNEL,
  OMNYO_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  OMNYO_DESKTOP_SET_THEME_CHANNEL,
  OMNYO_DESKTOP_ZOOM_COMMAND_CHANNEL,
} from "./desktop-update-ipc.js";
import {
  OMNYO_DESKTOP_BROWSER_ATTACH_CHANNEL,
  OMNYO_DESKTOP_BROWSER_TARGET_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_CONTROL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_REVEAL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_DETACH_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_HOST_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  OMNYO_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  OMNYO_DESKTOP_BROWSER_RELOAD_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  OMNYO_DESKTOP_BROWSER_STATE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_STOP_CHANNEL,
  OMNYO_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  OMNYO_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_STATUS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_CONFIGURE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_RUN_CHANNEL,
  OMNYO_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
  OMNYO_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  OMNYO_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import {
  OMNYO_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  OMNYO_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  OMNYO_DESKTOP_SELECT_SERVER_CHANNEL,
  OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
  OMNYO_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
  OMNYO_DESKTOP_RELOAD_WINDOW_CHANNEL,
  OMNYO_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
  OMNYO_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  OMNYO_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  OMNYO_DESKTOP_OPEN_THREAD_REQUEST_CHANNEL,
  OMNYO_DESKTOP_OPEN_THREAD_RESPONSE_CHANNEL,
  OMNYO_DESKTOP_FOCUS_WINDOW_CHANNEL,
  OMNYO_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  OMNYO_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  OMNYO_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL,
  OMNYO_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  OMNYO_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  OMNYO_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
  OMNYO_DESKTOP_RESOLVE_NATIVE_FILES_CHANNEL,
} from "./desktop-window-command-ipc.js";
import {
  getDesktopVersion,
  resolveDesktopPlatform,
} from "./desktop-platform.js";
import { STARTUP_ACTION_CHANNEL } from "./local-view.js";

function createInitialDesktopInfo(): OmnyoDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: resolveDesktopPlatform(process.platform),
    updateAvailable: false,
    updateDownloaded: false,
    version: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
  };
}

function createInitialDesktopWindowState(): OmnyoDesktopWindowState {
  return {
    isFullScreen: false,
  };
}

const serverChoiceListeners = new Set<
  (choices: OmnyoDesktopServerChoice[]) => void
>();

const listeners = new Set<OmnyoDesktopInfoChangeHandler>();

const appCommandListeners = new Set<OmnyoDesktopAppCommandHandler>();

const openThreadListeners = new Set<OmnyoDesktopOpenThreadHandler>();

const openThreadRequestSchema = z.object({
  requestId: z.string(),
  threadId: z.string(),
});

const windowStateListeners = new Set<OmnyoDesktopWindowStateChangeHandler>();

let currentInfo = createInitialDesktopInfo();

let currentWindowState = createInitialDesktopWindowState();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentInfo);
  }
}

function notifyWindowStateListeners(): void {
  for (const listener of windowStateListeners) {
    listener(currentWindowState);
  }
}

function applyDesktopInfoPayload(payload: unknown): OmnyoDesktopInfo | null {
  const parsed = omnyoDesktopInfoSchema.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  currentInfo = parsed.data;
  notifyListeners();

  return currentInfo;
}

function applyDesktopWindowStatePayload(
  payload: unknown,
): OmnyoDesktopWindowState | null {
  const parsed = omnyoDesktopWindowStateSchema.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  currentWindowState = parsed.data;
  notifyWindowStateListeners();

  return currentWindowState;
}

async function invokeDesktopInfo(channel: string): Promise<OmnyoDesktopInfo> {
  try {
    const payload: unknown = await ipcRenderer.invoke(channel);

    return applyDesktopInfoPayload(payload) ?? currentInfo;
  } catch {
    return currentInfo;
  }
}

async function invokeDesktopWindowState(): Promise<OmnyoDesktopWindowState> {
  try {
    const payload: unknown = await ipcRenderer.invoke(
      OMNYO_DESKTOP_GET_WINDOW_STATE_CHANNEL,
    );

    return applyDesktopWindowStatePayload(payload) ?? currentWindowState;
  } catch {
    return currentWindowState;
  }
}

const REMOTE_METHOD_ERROR_PREFIX =
  /^Error invoking remote method '[^']+': (?:Error: )?/u;

async function invokeInstallUpdate(): Promise<void> {
  try {
    await ipcRenderer.invoke(OMNYO_DESKTOP_INSTALL_UPDATE_CHANNEL);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message.replace(REMOTE_METHOD_ERROR_PREFIX, "")
        : "The update did not install.",
    );
  }
}

const browserStateListeners = new Set<OmnyoDesktopBrowserStateHandler>();

const browserControlListeners = new Set<
  (state: OmnyoDesktopBrowserControlState) => void
>();

const browserRevealListeners = new Set<
  (request: OmnyoDesktopBrowserRevealRequest) => void
>();

const browserOpenTabListeners = new Set<OmnyoDesktopBrowserOpenTabHandler>();

const browserScopedOpenTabListeners =
  new Set<OmnyoDesktopBrowserScopedOpenTabHandler>();

const browserFocusListeners = new Set<OmnyoDesktopBrowserFocusHandler>();

const browserPageMessageListeners =
  new Set<OmnyoDesktopBrowserPageMessageHandler>();

const browserSnapshotListeners = new Set<OmnyoDesktopBrowserSnapshotHandler>();

const browserFindResultListeners =
  new Set<OmnyoDesktopBrowserFindResultHandler>();

const closeWindowRequestListeners =
  new Set<OmnyoDesktopCloseWindowRequestHandler>();

const openNewTabListeners = new Set<OmnyoDesktopOpenNewTabHandler>();

const zoomListeners = new Set<OmnyoDesktopZoomChangeHandler>();

let lastZoomFactor = webFrame.getZoomFactor();

function notifyZoomChangeIfChanged(): void {
  const zoomFactor = webFrame.getZoomFactor();

  if (zoomFactor === lastZoomFactor) {
    return;
  }

  lastZoomFactor = zoomFactor;

  for (const listener of zoomListeners) {
    listener(zoomFactor);
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function forwardParsed<T>(
  channel: string,
  schema: z.ZodType<T>,
  listeners: Set<(value: T) => void>,
): void {
  ipcRenderer.on(channel, (_event, payload: unknown) => {
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    for (const listener of listeners) {
      listener(parsed.data);
    }
  });
}

function browserViewBoundsAtWindowScale(
  bounds: OmnyoDesktopBrowserViewBounds,
): OmnyoDesktopBrowserViewBounds {
  const zoomFactor = webFrame.getZoomFactor();

  if (zoomFactor === 1) {
    return bounds;
  }

  const x = Math.round(bounds.x * zoomFactor);
  const y = Math.round(bounds.y * zoomFactor);

  return {
    x,
    y,
    width: Math.max(0, Math.round((bounds.x + bounds.width) * zoomFactor) - x),
    height: Math.max(
      0,
      Math.round((bounds.y + bounds.height) * zoomFactor) - y,
    ),
  };
}

const omnyoBrowserApi: OmnyoDesktopBrowserApi = {
  async getTarget() {
    return omnyoDesktopBrowserTargetSchema
      .nullable()
      .parse(await ipcRenderer.invoke(OMNYO_DESKTOP_BROWSER_TARGET_CHANNEL));
  },
  async getControl(tabId) {
    return omnyoDesktopBrowserControlStateSchema.nullable().parse(
      await ipcRenderer.invoke(OMNYO_DESKTOP_BROWSER_GET_CONTROL_CHANNEL, {
        tabId,
      }),
    );
  },
  releaseControl(tabId) {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL, { tabId });
  },
  onControl(listener) {
    return addListener(browserControlListeners, listener);
  },
  onReveal(listener) {
    return addListener(browserRevealListeners, listener);
  },
  async evaluate(request) {
    return omnyoDesktopBrowserEvaluateResultSchema.parse(
      await ipcRenderer.invoke(OMNYO_DESKTOP_BROWSER_EVALUATE_CHANNEL, request),
    );
  },
  onPageMessage(listener) {
    return addListener(browserPageMessageListeners, listener);
  },
  attach(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_ATTACH_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  detach(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_DETACH_CHANNEL, { tabId });
  },
  navigate(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_NAVIGATE_CHANNEL, request);
  },
  goBack(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_GO_BACK_CHANNEL, { tabId });
  },
  goForward(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_GO_FORWARD_CHANNEL, { tabId });
  },
  reload(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_RELOAD_CHANNEL, { tabId });
  },
  stop(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_STOP_CHANNEL, { tabId });
  },
  focus(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_FOCUS_CHANNEL, { tabId });
  },
  setHostFocus(tabId): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_HOST_FOCUS_CHANNEL, { tabId });
  },
  setBounds(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  setVisible(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL, request);
  },
  setVisibleWithoutFocus(request): void {
    ipcRenderer.send(
      OMNYO_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
      request,
    );
  },
  onState(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserStateListeners, listener);
  },
  onOpenTab(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserOpenTabListeners, listener);
  },
  onScopedOpenTab(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserScopedOpenTabListeners, listener);
  },
  onFocus(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserFocusListeners, listener);
  },
  onSnapshot(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserSnapshotListeners, listener);
  },
  findInPage(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL, request);
  },
  stopFindInPage(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL, request);
  },
  onFindResult(listener): OmnyoDesktopBrowserUnsubscribe {
    return addListener(browserFindResultListeners, listener);
  },
  async listImportSources() {
    const payload: unknown = await ipcRenderer.invoke(
      OMNYO_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    );

    return z
      .object({
        sources: z.array(desktopBrowserImportSourceSchema),
        recommended: desktopBrowserImportSelectionSchema.optional(),
      })
      .parse(payload);
  },
  async importCookies(request) {
    const payload: unknown = await ipcRenderer.invoke(
      OMNYO_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
      request,
    );

    return desktopBrowserImportOutcomeSchema.parse(payload);
  },
  async cookieSyncStatus() {
    return desktopBrowserCookieSyncStatusSchema.parse(
      await ipcRenderer.invoke(
        OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_STATUS_CHANNEL,
      ),
    );
  },
  async configureCookieSync(source) {
    return desktopBrowserCookieSyncStatusSchema.parse(
      await ipcRenderer.invoke(
        OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_CONFIGURE_CHANNEL,
        source,
      ),
    );
  },
  async runCookieSync() {
    return desktopBrowserCookieSyncStatusSchema.parse(
      await ipcRenderer.invoke(OMNYO_DESKTOP_BROWSER_COOKIE_SYNC_RUN_CHANNEL),
    );
  },
  openFullDiskAccessSettings() {
    ipcRenderer.send(
      OMNYO_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    );
  },
};

const omnyoDesktopApi: OmnyoDesktopApi = {
  browser: omnyoBrowserApi,
  async takeWorkflowImport() {
    return workflowImportReferenceSchema
      .nullable()
      .parse(await ipcRenderer.invoke(TAKE_WORKFLOW_IMPORT_CHANNEL));
  },
  onWorkflowImport(listener) {
    const handler = () => listener();
    ipcRenderer.on(WORKFLOW_IMPORT_READY_CHANNEL, handler);

    return () =>
      ipcRenderer.removeListener(WORKFLOW_IMPORT_READY_CHANNEL, handler);
  },
  async getServerChoices() {
    return omnyoDesktopServerChoicesSchema.parse(
      await ipcRenderer.invoke(OMNYO_DESKTOP_GET_SERVER_CHOICES_CHANNEL),
    );
  },
  onServerChoicesChange(listener) {
    return addListener(serverChoiceListeners, listener);
  },
  selectServer(id) {
    ipcRenderer.send(OMNYO_DESKTOP_SELECT_SERVER_CHANNEL, id);
  },
  get lastCheckedAt() {
    return currentInfo.lastCheckedAt;
  },
  get latestVersion() {
    return currentInfo.latestVersion;
  },
  get pendingVersion() {
    return currentInfo.pendingVersion;
  },
  platform: resolveDesktopPlatform(process.platform),
  get serverDaemonLogsAvailable() {
    return currentInfo.serverDaemonLogsAvailable;
  },
  get updateAvailable() {
    return currentInfo.updateAvailable;
  },
  get updateDownloaded() {
    return currentInfo.updateDownloaded;
  },
  version: currentInfo.version,
  checkForUpdates() {
    return invokeDesktopInfo(OMNYO_DESKTOP_CHECK_FOR_UPDATES_CHANNEL);
  },
  getInfo() {
    return invokeDesktopInfo(OMNYO_DESKTOP_GET_INFO_CHANNEL);
  },
  focusWindow() {
    ipcRenderer.send(OMNYO_DESKTOP_FOCUS_WINDOW_CHANNEL);
  },
  getWindowState() {
    return invokeDesktopWindowState();
  },
  installUpdate() {
    return invokeInstallUpdate();
  },
  onChange(
    listener: OmnyoDesktopInfoChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe {
    return addListener(listeners, listener);
  },
  onWindowStateChange(
    listener: OmnyoDesktopWindowStateChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe {
    return addListener(windowStateListeners, listener);
  },
  onZoomChange(listener): OmnyoDesktopInfoUnsubscribe {
    return addListener(zoomListeners, listener);
  },
  zoom(command): void {
    ipcRenderer.send(OMNYO_DESKTOP_ZOOM_COMMAND_CHANNEL, command);
  },
  onOpenNewTab(listener): OmnyoDesktopInfoUnsubscribe {
    return addListener(openNewTabListeners, listener);
  },
  onAppCommand(listener): OmnyoDesktopInfoUnsubscribe {
    return addListener(appCommandListeners, listener);
  },
  onCloseWindowRequest(listener): OmnyoDesktopInfoUnsubscribe {
    return addListener(closeWindowRequestListeners, listener);
  },
  onOpenThread(listener): OmnyoDesktopInfoUnsubscribe {
    return addListener(openThreadListeners, listener);
  },
  openWindowFind(request): void {
    ipcRenderer.send(OMNYO_DESKTOP_OPEN_WINDOW_FIND_CHANNEL, {
      topOffset: Math.round(request.topOffset * webFrame.getZoomFactor()),
    } satisfies OmnyoDesktopWindowFindRequest);
  },
  async openDataDirectory(): Promise<void> {
    await ipcRenderer.invoke(OMNYO_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL);
  },
  openExternalUrl(url: string): void {
    ipcRenderer.send(OMNYO_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL, url);
  },
  async openServerDaemonLogs(): Promise<void> {
    await ipcRenderer.invoke(OMNYO_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL);
  },
  reloadWindow(): void {
    ipcRenderer.send(OMNYO_DESKTOP_RELOAD_WINDOW_CHANNEL);
  },
  setSplitNavigationEnabled(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void {
    ipcRenderer.send(
      OMNYO_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
      enabled,
      directionalCommands,
    );
  },
  setAttention(active: boolean): void {
    ipcRenderer.send(OMNYO_DESKTOP_SET_ATTENTION_CHANNEL, active);
  },
  setTheme(theme: OmnyoDesktopTheme): void {
    ipcRenderer.send(OMNYO_DESKTOP_SET_THEME_CHANNEL, theme);
  },
  async writeClipboard(content: OmnyoDesktopClipboardContent): Promise<void> {
    await ipcRenderer.invoke(OMNYO_DESKTOP_WRITE_CLIPBOARD_CHANNEL, content);
  },
  async resolveNativeFiles(files) {
    if (!Array.isArray(files) || files.length > 64)
      throw new Error("Native file requests accept at most 64 Files");

    const paths = files.flatMap((file, index) => {
      const path = webUtils.getPathForFile(file);

      return path === "" ? [] : [{ index, path }];
    });

    const payload: unknown = await ipcRenderer.invoke(
      OMNYO_DESKTOP_RESOLVE_NATIVE_FILES_CHANNEL,
      { count: files.length, paths },
    );

    const result = omnyoDesktopNativeFileClassificationsSchema.parse(payload);

    if (result.length !== files.length)
      throw new Error("Native file result count changed");

    return result;
  },
};

forwardParsed(
  OMNYO_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  omnyoDesktopServerChoicesSchema,
  serverChoiceListeners,
);

ipcRenderer.on(
  OMNYO_DESKTOP_INFO_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopInfoPayload(payload);
  },
);

ipcRenderer.on(
  OMNYO_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopWindowStatePayload(payload);
  },
);

ipcRenderer.on(OMNYO_DESKTOP_OPEN_NEW_TAB_CHANNEL, () => {
  for (const listener of openNewTabListeners) {
    listener();
  }
});

forwardParsed(
  OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
  appCommandIdSchema,
  appCommandListeners,
);

ipcRenderer.on(OMNYO_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL, () => {
  let handled = false;

  for (const listener of closeWindowRequestListeners) {
    handled = listener() || handled;
  }

  ipcRenderer.send(OMNYO_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, handled);
});

ipcRenderer.on(
  OMNYO_DESKTOP_OPEN_THREAD_REQUEST_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = openThreadRequestSchema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    const handled = openThreadListeners.size > 0;

    for (const listener of openThreadListeners) {
      listener(parsed.data.threadId);
    }

    ipcRenderer.send(OMNYO_DESKTOP_OPEN_THREAD_RESPONSE_CHANNEL, {
      requestId: parsed.data.requestId,
      handled,
    });
  },
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_STATE_CHANNEL,
  omnyoDesktopBrowserStateSchema,
  browserStateListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_CONTROL_CHANNEL,
  omnyoDesktopBrowserControlStateSchema,
  browserControlListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_REVEAL_CHANNEL,
  omnyoDesktopBrowserRevealRequestSchema,
  browserRevealListeners,
);

ipcRenderer.on(
  OMNYO_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = omnyoDesktopBrowserTabRefSchema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    for (const listener of browserFocusListeners) {
      listener(parsed.data.tabId);
    }
  },
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  omnyoDesktopBrowserOpenTabRequestSchema,
  browserOpenTabListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  omnyoDesktopBrowserScopedOpenTabRequestSchema,
  browserScopedOpenTabListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  omnyoDesktopBrowserSnapshotSchema,
  browserSnapshotListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
  omnyoDesktopBrowserPageMessageSchema,
  browserPageMessageListeners,
);

forwardParsed(
  OMNYO_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  omnyoDesktopBrowserFindResultSchema,
  browserFindResultListeners,
);

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("resize", notifyZoomChangeIfChanged);
  window.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll<HTMLElement>(
      "[data-startup-action]",
    )) {
      button.addEventListener("click", () => {
        ipcRenderer.send(STARTUP_ACTION_CHANNEL, button.dataset.startupAction);
      });
    }
  });
}

void invokeDesktopInfo(OMNYO_DESKTOP_GET_INFO_CHANNEL);

void invokeDesktopWindowState();

contextBridge.exposeInMainWorld("omnyoDesktop", omnyoDesktopApi);

contextBridge.exposeInMainWorld("omnyoDesktopNotifications", {
  async deliver(id: string): Promise<boolean> {
    return (
      (await ipcRenderer.invoke(DESKTOP_NOTIFICATION_DELIVER_CHANNEL, id)) ===
      true
    );
  },
});
