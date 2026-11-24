import {
  parseSkillPackImportLink,
  SkillPackImportQueue,
} from "./skill-pack-import.js";
import {
  WorkflowImportQueue,
  parseWorkflowImportLink,
  readWorkflowImportFile,
  workflowImportDestination,
} from "./workflow-import.js";
import {
  TAKE_WORKFLOW_IMPORT_CHANNEL,
  WORKFLOW_IMPORT_READY_CHANNEL,
} from "./workflow-import-ipc.js";
import type { WorkflowImportReference } from "@omnyo/desktop-contract";
import { publicBetaUpdateFeed } from "./public-beta-update.js";
import { createPublicBetaEnvironment } from "./public-beta.js";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
} from "../scripts/desktop-release-channel.mjs";
import {
  desktopProfileStorageNameV1,
  desktopProfileOriginWindowUrlV1Sync,
  desktopProfileOriginWindowV1Sync,
  acceptDesktopProfileOriginWindowV1,
  desktopProfileAdmittedOriginMappingV1Sync,
} from "./desktop-profile-adoption-v1.js";
import { initializeDesktopProfileStorageV1 } from "./desktop-profile-storage-v1.js";
import { profileDesktopRenderer } from "./desktop-renderer-profile.js";
import { registerServerChoiceIpc } from "./server-choice-ipc.js";
import { randomUUID } from "node:crypto";
import { prepareDesktopProfilePathV1 } from "./desktop-profile-v1.js";
import { arch, homedir, release, type as osType } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  nativeTheme,
  net,
  powerMonitor,
  safeStorage,
  session,
  shell,
  webContents as electronWebContents,
  type Event,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  PRIVATE_GATEWAY_ORIGIN,
  readPrivateUpdateConfig,
} from "./private-update-config.js";
import {
  inspectDownloadedPrivateUpdate,
  inspectInstalledPrivateUpdate,
} from "./private-update-artifact.js";
import {
  inspectDownloadedPrivateWindowsUpdate,
  inspectInstalledPrivateWindowsUpdate,
} from "./private-windows-update-artifact.js";
import {
  createPrivateDesktopUpdateInstaller,
  type PrivateDesktopUpdateRuntime,
  type PrivateUpdateArtifact,
} from "./private-update-install.js";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
} from "@omnyo/config/app-surface";
import { resolveProdDataDir } from "@omnyo/config/runtime";
import { findMachineServiceFile } from "@omnyo/config/machine-service";
import {
  deriveConnectBaseUrl,
  type ConnectCredential,
} from "@omnyo/connect-client";
import {
  appCommandIdSchema,
  type AppCommandId,
  type AppKeybindings,
} from "@omnyo/domain";
import {
  omnyoDesktopBrowserImportCookiesRequestSchema,
  omnyoDesktopThemeSchema,
  type OmnyoDesktopInfo,
  type OmnyoDesktopWindowState,
} from "@omnyo/desktop-contract";
import {
  serverMessageLenientSchema,
  type ClientMessage,
} from "@omnyo/server-contract";
import { z } from "zod";
import {
  desktopNotificationGroupId,
  startDesktopNotifications,
  type DesktopPresence,
} from "./desktop-notifications.js";
import { openDesktopNotificationThread } from "./desktop-notification-target.js";
import { DESKTOP_NOTIFICATION_DELIVER_CHANNEL } from "./desktop-notifications-ipc.js";
import { registerDesktopClipboardIpc } from "./desktop-clipboard.js";
import { registerDesktopNativeFilesIpc } from "./desktop-native-files.js";
import { registerDesktopWindowFocusIpc } from "./desktop-window-focus.js";
import { registerDesktopAttentionIpc } from "./desktop-attention.js";
import {
  assertPathExists,
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopMachineInstallerPath,
  type DesktopPathContext,
} from "./app-paths.js";
import {
  keepMovedMachineConnected,
  MACHINE_SERVICE_INSTALL_LOG_FILE_NAME,
  MACHINE_SERVICE_NOTICE_FILE_NAME,
  runMachineInstaller,
} from "./moved-machine-service.js";
import {
  resolveOmnyoAppProcessRuntime,
  type OmnyoAppProcess,
  type OmnyoAppProcessExit,
  startOmnyoAppProcess,
} from "./app-process.js";
import { openExistingServerDialog } from "./existing-server-dialog.js";
import {
  readForeignRuntimeDetails,
  stopForeignRuntime,
} from "./foreign-runtime.js";
import {
  createLocalViewUrl,
  STARTUP_ACTION_CHANNEL,
  startupActionIdSchema,
  type StartupAction,
  type StartupActionId,
} from "./local-view.js";
import {
  createServerMenuItems,
  installApplicationMenu,
  type ServerMenuArgs,
} from "./menu.js";
import {
  DEFAULT_APPLICATION_MENU_ACCELERATORS,
  resolveApplicationMenuAccelerators,
} from "./desktop-menu-shortcuts.js";
import {
  clearOwnedRuntimePidFile,
  reapStaleOwnedRuntime,
  writeOwnedRuntimePidFile,
} from "./owned-runtime-supervisor.js";
import {
  probeOmnyoServer,
  waitForCompatibleServer,
  type CompatibleServerProbeResult,
  type ServerProbeResult,
} from "./server-probe.js";
import { loadRemoteServerPage } from "./remote-server-load.js";
import {
  applyServerMove,
  createServerMovedWatcher,
  createServerMoveNoticeStore,
  ensureServerMovedRuntime,
  hasLiveOmnyoAppLauncher,
  openServerMoveTarget,
  probeLocalServerMove,
  readServerMovedConnectCredential,
  readServerMovedLock,
  SERVER_MOVE_COMMIT_INTERVAL_MS,
  SERVER_MOVE_COMMIT_TIMEOUT_MS,
  SERVER_MOVE_DESTINATION_INTERVAL_MS,
  SERVER_MOVE_DESTINATION_TIMEOUT_MS,
  SERVER_MOVE_NOTICE_FILE_NAME,
  SERVER_MOVED_POLL_INTERVAL_MS,
  SERVER_MOVED_WATCH_DEBOUNCE_MS,
  waitForCommittedServerMove,
  waitForServerMoveDestination,
  type DesktopServerMove,
  type ServerMovedNotice,
  type ServerMovedWatcher,
  type ServerMoveNoticeStore,
} from "./server-moved.js";
import {
  BUILTIN_SERVER_NAME,
  createServerTargetStore,
  SERVER_TARGET_FILE_NAME,
  type ConnectServerRef,
  type ServerTargetStore,
} from "./server-target.js";
import { buildDesktopServerChoices, customServerId } from "./server-list.js";
import { openServerUrlDialog } from "./server-url-dialog.js";
import {
  createConnectServerSync,
  type ConnectAccountServer,
  type ConnectServerSync,
  type ConnectServerSyncSkipReason,
} from "./connect-server-sync.js";
import {
  createAccountCookieSource,
  createCredentialCookieSource,
  createLocalServerCookieSource,
  installConnectDesktopSession,
  type ConnectDesktopSessionResult,
} from "./connect-desktop-session.js";
import { CONNECT_ACCOUNT_SESSION_COOKIE } from "./connect-account-cookie.js";
import {
  createConnectCredentialCache,
  type ConnectCredentialCache,
} from "./connect-credential-cache.js";
import { enrollDesktopMachine } from "./connect-machine-enrollment.js";
import {
  createConnectSessionRenewal,
  type ConnectSessionRenewal,
} from "./connect-session-renewal.js";
import { registerDesktopShutdownSignalHandlers } from "./desktop-shutdown.js";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowFactory,
} from "./desktop-window-factory.js";
import {
  hasLinuxWindowArgument,
  LINUX_FRAMELESS_WINDOW_ARGUMENT,
  LINUX_TRANSPARENT_WINDOW_ARGUMENT,
} from "./desktop-linux-window-options.js";
import {
  createDesktopAboutDialogOptions,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "./desktop-about-panel.js";
import { registerDesktopContextMenu } from "./desktop-context-menu.js";
import {
  getDesktopVersion,
  resolveDesktopPlatform,
} from "./desktop-platform.js";
import {
  DESKTOP_RELEASE_CHANNEL,
  DESKTOP_RELEASE_INFO,
  resolveDesktopUpdateSupport,
  type DesktopAutoUpdateFeedConfig,
} from "./desktop-update-provider.js";
import type { DesktopUpdateService } from "./desktop-update-scheduler.js";
import {
  createDesktopAutoUpdateService,
  createElectronAutoUpdaterAdapter,
  shouldEnableDesktopAutoUpdate,
  type DesktopAutoUpdateLogger,
  type DesktopAutoUpdateService,
} from "./desktop-auto-update.js";
import { mergeDesktopUpdateInfo } from "./desktop-update-info.js";
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
  OMNYO_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
  OMNYO_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
  OMNYO_DESKTOP_RELOAD_WINDOW_CHANNEL,
  OMNYO_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
  OMNYO_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  OMNYO_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  OMNYO_DESKTOP_OPEN_THREAD_REQUEST_CHANNEL,
  OMNYO_DESKTOP_OPEN_THREAD_RESPONSE_CHANNEL,
  OMNYO_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  OMNYO_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  OMNYO_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL,
  OMNYO_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  OMNYO_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  CLOSE_WINDOW_REQUEST_TIMEOUT_MS,
  OPEN_THREAD_REQUEST_TIMEOUT_MS,
} from "./desktop-window-command-ipc.js";
import {
  createDesktopBrowserViewManager,
  type DesktopBrowserViewManager,
} from "./desktop-browser-view.js";
import { resolveDesktopBrowserAppCommand } from "./desktop-browser-shortcuts.js";
import { registerDesktopBrowserIpc } from "./desktop-browser-main-ipc.js";
import { resolveDesktopExternalUrl } from "./desktop-external-url.js";
import {
  createDesktopFindViewManager,
  type DesktopFindViewManager,
} from "./desktop-find-view.js";
import { createBrowserImportService } from "./browser-import/browser-import.js";
import { readMacAppIcon } from "./browser-import/mac-app-icon.js";
import {
  createDesktopBrowserBroker,
  type DesktopBrowserBroker,
} from "./desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "./desktop-browser-broker-client.js";
import {
  omnyoDesktopBrowserTabRefSchema,
  omnyoDesktopZoomCommandSchema,
  omnyoDesktopWindowFindRequestSchema,
  type OmnyoDesktopZoomCommand,
} from "@omnyo/desktop-contract";
import { nextZoomFactor } from "./desktop-zoom.js";
import {
  OMNYO_DESKTOP_BROWSER_TARGET_CHANNEL,
  OMNYO_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  OMNYO_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  OMNYO_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  OMNYO_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
} from "./desktop-browser-ipc.js";
import { parseDesktopSystemConfig } from "./desktop-system-config.js";
import { ensurePackagedUserShellPath } from "./desktop-shell-path.js";
import { resolveDesktopReloadShortcut } from "./desktop-reload-shortcut.js";
import {
  createLogTailer,
  createLogLineBuffer,
  createLogViewerViewUrl,
  LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
  LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
  type LogLineBuffer,
  type LogTailer,
} from "./log-viewer.js";
import {
  LOG_VIEWER_APPEND_CHANNEL,
  LOG_VIEWER_COPY_CHANNEL,
  LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL,
  LOG_VIEWER_SNAPSHOT_CHANNEL,
  LOG_VIEWER_VISIBLE_LINE_LIMIT,
  type LogViewerLine,
  type LogViewerCopyRequest,
  type LogViewerOpenLogsFolderResult,
} from "./log-viewer-contract.js";
import {
  ATTACH_PROBE_TIMEOUT_MS,
  DEFAULT_OMNYO_SERVER_URL,
  PROCESS_LOG_LINE_LIMIT,
  STARTUP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  type RuntimeOwnership,
  type WindowStateKey,
} from "./types.js";

const OWNED_RUNTIME_STOP_TIMEOUT_MS = 6_000;

const OWNED_RUNTIME_KILL_TIMEOUT_MS = 1_000;

const FOREIGN_RUNTIME_STOP_TIMEOUT_MS = 15_000;

const FOREIGN_RUNTIME_KILL_TIMEOUT_MS = 3_000;

const REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface DesktopRuntime {
  appProcess: OmnyoAppProcess | null;
  ownership: RuntimeOwnership;
  serverUrl: string;
  userDataPath: string | null;
}

interface LoadStartupErrorArgs {
  actions: StartupAction[];
  details: string;
  logs: string;
  title: string;
}

const PUBLIC_LOCAL_ADDRESS_BUSY_ERROR: LoadStartupErrorArgs = {
  title: "Local address is busy",
  details: "Close the other instance using port 47431 before opening Omnyo.",
  logs: "",
  actions: [],
};

interface StartupErrorPage {
  actions: StartupActionId[];
  url: string;
}

interface LoadWindowUrlArgs {
  url: string;
}

interface CreateApplicationWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface StartOwnedRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

interface OwnedRuntime {
  appProcess: OmnyoAppProcess;
  runtime: DesktopRuntime;
}

interface SendLogViewerSnapshotArgs {
  browserWindow: BrowserWindow;
  lines: LogViewerLine[];
  logDir: string;
}

interface LoadLogViewerWindowArgs {
  logDir: string;
  preloadPath: string;
}

type StartupRaceResult =
  | ProcessExitedStartupRaceResult
  | ServerProbeStartupRaceResult;

interface ProcessExitedStartupRaceResult {
  exit: OmnyoAppProcessExit;
  kind: "process-exited";
}

interface ServerProbeStartupRaceResult {
  kind: "server-probe";
  result: ServerProbeResult;
}

interface ResolveDataDirFromEnvArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveDesktopServerUrlArgs {
  env: NodeJS.ProcessEnv;
}

interface ResolveDesktopWindowUrlArgs {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface SystemConfigRequestArgs {
  fetchImpl: typeof fetch;
  serverUrl: string;
}

interface SystemConfigSync {
  stop(): void;
}

const logViewerCopyRequestSchema = z
  .object({
    text: z.string(),
  })
  .strict();

let desktopWindowFactory: DesktopWindowFactory | null = null;

let desktopBrowserViewManager: DesktopBrowserViewManager | null = null;

let desktopFindViewManager: DesktopFindViewManager | null = null;

let desktopBrowserBroker: DesktopBrowserBroker | null = null;

let desktopBrowserBrokerClient: ReturnType<
  typeof createDesktopBrowserBrokerClient
> | null = null;

let currentAppKeybindings: AppKeybindings = [];

let currentApplicationMenuAccelerators = DEFAULT_APPLICATION_MENU_ACCELERATORS;

let desktopUpdateService: DesktopUpdateService | null = null;

let desktopAutoUpdateService: DesktopAutoUpdateService | null = null;

let shellPathReady: Promise<void> = Promise.resolve();

let privateUpdateInstaller: ReturnType<
  typeof createPrivateDesktopUpdateInstaller
> | null = null;

let currentRuntime: DesktopRuntime | null = null;

let currentWindowUrl: string | null = null;

let logViewerLineBuffer: LogLineBuffer | null = null;

let logViewerPreloadPath: string | null = null;

let logViewerTailer: LogTailer | null = null;

let logViewerWindow: BrowserWindow | null = null;

let systemConfigSync: SystemConfigSync | null = null;

let systemConfigRefreshToken = 0;

let refreshRemoteSystemConfig: (() => void) | null = null;

const applicationWindowWebContentsIds = new Set<number>();

const applicationWindowNavigationGenerations = new Map<number, number>();

const splitNavigationEnabledWebContentsIds = new Set<number>();

const splitNavigationCommandsByWebContentsId = new Map<
  number,
  readonly AppCommandId[]
>();

let omnyoAppLoaded = false;

const workflowImports = new WorkflowImportQueue();

const skillPackImports = new SkillPackImportQueue();

let workflowImportServerUrl: string | null = null;

async function enqueueWorkflowImport(
  entry: WorkflowImportReference,
): Promise<void> {
  workflowImports.add(entry);

  if (omnyoAppLoaded && workflowImportServerUrl !== null) {
    await loadWindowUrl({
      url: workflowImportDestination(workflowImportServerUrl),
    });
  }
}

async function openSkillPackImport(serverUrl: string): Promise<void> {
  try {
    await skillPackImports.open(serverUrl, (url) => loadWindowUrl({ url }));
  } catch {
    dialog.showErrorBox(
      "Skills",
      "The skill review could not be opened. Open the link again after connecting Omnyo.",
    );
  }
}

function acceptImportArgument(argument: string): void {
  if (process.platform !== "darwin") return;
  const skillPack = parseSkillPackImportLink(argument);

  if (skillPack !== null) {
    skillPackImports.add(skillPack);

    if (omnyoAppLoaded && workflowImportServerUrl !== null)
      void openSkillPackImport(workflowImportServerUrl);

    return;
  }

  const reference = parseWorkflowImportLink(argument);

  const work =
    reference !== null
      ? enqueueWorkflowImport(reference)
      : argument.toLowerCase().endsWith(".omnyoworkflow")
        ? readWorkflowImportFile(argument).then(enqueueWorkflowImport)
        : null;

  if (work !== null)
    void work.catch(() =>
      dialog.showErrorBox(
        "Workflow import",
        "The workflow could not be opened. Use a valid workflow file under 256 KiB.",
      ),
    );
}

let startupErrorPage: StartupErrorPage | null = null;

let startupActionPending = false;

let connectSignInWindow: BrowserWindow | null = null;

let stoppingForQuit = false;

let quitting = false;

let serverTargetStore: ServerTargetStore | null = null;

let connectServerSync: ConnectServerSync | null = null;

let connectCredentialCache: ConnectCredentialCache | null = null;

let cachedConnectCredential: ConnectCredential | null = null;

let enrollingDesktopMachine: Promise<void> | null = null;

let connectSessionRenewal: ConnectSessionRenewal | null = null;

let serverTargetGeneration = 0;

let connectAccountServers: ConnectAccountServer[] = [];

let connectServerSyncSkipReason: ConnectServerSyncSkipReason | null = null;

let builtinServerUrl: string = DEFAULT_OMNYO_SERVER_URL;

let desktopBridgePath: string | null = null;

let desktopUserDataPath: string | null = null;

let builtinDataDir: string | null = null;

let serverMoveNoticeStore: ServerMoveNoticeStore | null = null;

let machineServiceNoticeStore: ServerMoveNoticeStore | null = null;

let movedMachineConnection: Promise<void> | null = null;

let localServerMove: DesktopServerMove | null = null;

let serverMovedWatcher: ServerMovedWatcher | null = null;

let serverUrlDialogPreloadPath: string | null = null;

let existingServerDialogPreloadPath: string | null = null;

function resolveDesktopServerUrl(args: ResolveDesktopServerUrlArgs): string {
  const rawPort = args.env.OMNYO_SERVER_PORT?.trim();

  if (rawPort === undefined || rawPort.length === 0) {
    return DEFAULT_OMNYO_SERVER_URL;
  }

  const port = Number(rawPort);

  if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return `http://127.0.0.1:${port}`;
  }

  throw new Error("OMNYO_SERVER_PORT must be a valid TCP port");
}

function resolveDesktopWindowUrl(args: ResolveDesktopWindowUrlArgs): string {
  const rawAppUrl = args.env.OMNYO_DESKTOP_APP_URL?.trim();

  if (rawAppUrl === undefined || rawAppUrl.length === 0) {
    return args.serverUrl;
  }

  let parsedAppUrl: URL;

  try {
    parsedAppUrl = new URL(rawAppUrl);
  } catch {
    throw new Error("OMNYO_DESKTOP_APP_URL must be a valid URL");
  }

  if (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:") {
    throw new Error("OMNYO_DESKTOP_APP_URL must be an http(s) URL");
  }

  return rawAppUrl;
}

function readDesktopAboutFacts(applicationName: string): DesktopAboutFacts {
  return {
    applicationName,
    buildDate: process.env.OMNYO_DESKTOP_BUILD_DATE ?? "",
    channel: DESKTOP_RELEASE_CHANNEL,
    commit: process.env.OMNYO_DESKTOP_COMMIT ?? "",
    electronVersion: process.versions.electron,
    osArch: arch(),
    osRelease: release(),
    osType: osType(),
    platform: process.platform,
    pluginSdkVersion: process.env.OMNYO_DESKTOP_PLUGIN_SDK_VERSION ?? "",
    version: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
  };
}

function installAboutPanel(applicationName: string): void {
  app.setAboutPanelOptions(
    createDesktopAboutPanelOptions(readDesktopAboutFacts(applicationName)),
  );
}

async function showAboutDialog(): Promise<void> {
  const { copyButtonId, ...messageBoxOptions } =
    createDesktopAboutDialogOptions(
      readDesktopAboutFacts(app.getName()),
      Date.now(),
    );

  const parentWindow = getFocusedApplicationWindow();

  const result =
    parentWindow === null
      ? await dialog.showMessageBox(messageBoxOptions)
      : await dialog.showMessageBox(parentWindow, messageBoxOptions);

  if (result.response === copyButtonId) {
    await clipboard.writeText(messageBoxOptions.detail);
  }
}

function getCurrentDesktopInfo(): OmnyoDesktopInfo | null {
  const info = mergeDesktopUpdateInfo({
    autoInfo: desktopAutoUpdateService?.getInfo() ?? null,
    feedInfo: desktopUpdateService?.getInfo() ?? null,
  });

  if (info === null) {
    return null;
  }

  return {
    ...info,
    serverDaemonLogsAvailable: shouldEnableServerDaemonLogsMenu(),
  };
}

function resolveApplicationWindow(
  webContents: WebContents,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents);
}

function zoomWebContents(
  target: WebContents | null | undefined,
  command: OmnyoDesktopZoomCommand,
): void {
  if (!target) {
    return;
  }

  target.setZoomFactor(nextZoomFactor(target.getZoomFactor(), command));
}

function sendToApplicationRenderer(
  browserWindow: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  if (!browserWindow.webContents.isDestroyed()) {
    browserWindow.webContents.send(channel, payload);
  }
}

function registerApplicationRendererReloadShortcut(
  webContents: WebContents,
): void {
  webContents.on("before-input-event", (event, input) => {
    const shortcut = resolveDesktopReloadShortcut(input);

    if (shortcut === null) {
      return;
    }

    event.preventDefault();
    const browserWindow = resolveApplicationWindow(webContents);

    if (
      browserWindow !== null &&
      desktopBrowserViewManager?.reloadHostFocusedTab(browserWindow) !== true
    ) {
      reloadApplicationWindow(browserWindow, shortcut === "force-reload");
    }
  });
}

function reloadApplicationWindow(
  browserWindow: BrowserWindow,
  ignoreCache: boolean,
): void {
  desktopBrowserViewManager?.prepareWindowReload(browserWindow);

  if (ignoreCache) {
    browserWindow.webContents.reloadIgnoringCache();
  } else {
    browserWindow.webContents.reload();
  }
}

function sendDesktopInfoChanged(): void {
  const info = getCurrentDesktopInfo();

  if (info === null) {
    return;
  }

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        OMNYO_DESKTOP_INFO_CHANGED_CHANNEL,
        info,
      );
    } else {
      browserWindow.webContents.send(OMNYO_DESKTOP_INFO_CHANGED_CHANNEL, info);
    }
  }
}

function getDesktopWindowState(
  browserWindow: Pick<DesktopBrowserWindow, "isFullScreen"> | null,
): OmnyoDesktopWindowState {
  return {
    isFullScreen: browserWindow?.isFullScreen() ?? false,
  };
}

function getSenderDesktopWindowState(
  event: IpcMainInvokeEvent,
): OmnyoDesktopWindowState {
  return getDesktopWindowState(resolveApplicationWindow(event.sender));
}

function sendDesktopWindowStateChanged(
  browserWindow: DesktopBrowserWindow,
): void {
  sendToApplicationRenderer(
    browserWindow as BrowserWindow,
    OMNYO_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
    getDesktopWindowState(browserWindow),
  );
}

const desktopLogger: DesktopAutoUpdateLogger = {
  error(message) {
    process.stderr.write(`${message}\n`);
  },
  info(message) {
    process.stderr.write(`${message}\n`);
  },
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};

function resolveDataDirFromEnv(args: ResolveDataDirFromEnvArgs): string {
  const rawDataDir = args.env.OMNYO_DATA_DIR?.trim();

  if (rawDataDir === undefined || rawDataDir.length === 0) {
    return resolveProdDataDir({ homeDir: args.homeDir });
  }

  if (rawDataDir === "~") {
    return args.homeDir;
  }

  if (rawDataDir.startsWith("~/")) {
    return resolve(args.homeDir, rawDataDir.slice(2));
  }

  return resolve(rawDataDir);
}

function formatLogDirectory(): string {
  return join(
    resolveDataDirFromEnv({
      env: process.env,
      homeDir: homedir(),
    }),
    "logs",
  );
}

function formatExitResult(result: OmnyoAppProcessExit): string {
  if (result.code !== null) {
    return `exit code ${result.code}`;
  }

  return result.signal === null
    ? "without an exit code"
    : `signal ${result.signal}`;
}

function createDesktopPathContext(): DesktopPathContext {
  return {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

function shouldEnableServerDaemonLogsMenu(): boolean {
  return (
    (process.platform === "darwin" || process.platform === "win32") &&
    currentRuntime?.ownership === "spawned"
  );
}

const pendingCloseWindowRequests = new Map<number, NodeJS.Timeout>();

function requestRendererWindowClose(browserWindow: BrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  const pending = pendingCloseWindowRequests.get(webContentsId);

  if (pending !== undefined) {
    clearTimeout(pending);
  }

  pendingCloseWindowRequests.set(
    webContentsId,
    setTimeout(() => {
      pendingCloseWindowRequests.delete(webContentsId);

      if (!browserWindow.isDestroyed()) {
        browserWindow.close();
      }
    }, CLOSE_WINDOW_REQUEST_TIMEOUT_MS),
  );
  sendToApplicationRenderer(
    browserWindow,
    OMNYO_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
    null,
  );
}

const pendingOpenThreadRequests = new Map<string, (handled: boolean) => void>();

const openThreadResponseSchema = z.object({
  requestId: z.string(),
  handled: z.boolean(),
});

function requestRendererOpenThread(
  browserWindow: BrowserWindow,
  threadId: string,
): Promise<boolean> {
  if (browserWindow.isDestroyed() || browserWindow.webContents.isLoading()) {
    return Promise.resolve(false);
  }

  const requestId = randomUUID();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingOpenThreadRequests.delete(requestId);
      resolve(false);
    }, OPEN_THREAD_REQUEST_TIMEOUT_MS);

    pendingOpenThreadRequests.set(requestId, (handled) => {
      clearTimeout(timer);
      pendingOpenThreadRequests.delete(requestId);
      resolve(handled);
    });
    sendToApplicationRenderer(
      browserWindow,
      OMNYO_DESKTOP_OPEN_THREAD_REQUEST_CHANNEL,
      { requestId, threadId },
    );
  });
}

function closeFocusedDetachedDevTools(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.webContents.isDevToolsFocused()) {
      browserWindow.webContents.closeDevTools();

      return;
    }
  }
}

function getFocusedApplicationWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();

  if (
    focused !== null &&
    !focused.isDestroyed() &&
    applicationWindowWebContentsIds.has(focused.webContents.id)
  ) {
    return focused;
  }

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (
      !browserWindow.isDestroyed() &&
      applicationWindowWebContentsIds.has(browserWindow.webContents.id)
    ) {
      return browserWindow;
    }
  }

  return null;
}

function listMenuConnectServers(): ConnectServerRef[] {
  const servers: ConnectServerRef[] = connectAccountServers.map((server) => ({
    handle: server.handle,
    name: server.name,
    url: server.url,
  }));

  const selected = serverTargetStore?.getConnectServer() ?? null;

  if (
    selected !== null &&
    !servers.some((server) => server.handle === selected.handle)
  ) {
    servers.push(selected);
  }

  return servers;
}

function listServerChoices() {
  return buildDesktopServerChoices(serverTargetStore, listMenuConnectServers());
}

function buildMenuServerItems(connectServers: ConnectServerRef[]) {
  return buildDesktopServerChoices(serverTargetStore, connectServers).map(
    ({ active, id, name }) => ({ checked: active, id, name }),
  );
}

function buildServerMenuArgs(): ServerMenuArgs {
  const connectServers = listMenuConnectServers();

  return {
    addServer() {
      void openSetServerUrlDialog(true);
    },
    connectServersSkipReason:
      connectServers.length === 0 ? connectServerSyncSkipReason : null,
    selectServer(serverId) {
      void setActiveServerTarget(serverId);
    },
    servers: buildMenuServerItems(connectServers),
    setServerUrl() {
      void openSetServerUrlDialog();
    },
  };
}

function popupServerMenu(browserWindow: BrowserWindow | null): void {
  connectServerSync?.onListRequested();
  Menu.buildFromTemplate(createServerMenuItems(buildServerMenuArgs())).popup(
    browserWindow === null ? {} : { window: browserWindow },
  );
}

function refreshApplicationMenu(): void {
  const choices = listServerChoices();

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        OMNYO_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
        choices,
      );
    }
  }

  installApplicationMenu({
    ...buildServerMenuArgs(),
    accelerators: currentApplicationMenuAccelerators,
    isMac: process.platform === "darwin",
    createNewWindow() {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    },
    openAbout() {
      void showAboutDialog();
    },
    version: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
    openNewTab() {
      const browserWindow = getFocusedApplicationWindow();

      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          OMNYO_DESKTOP_OPEN_NEW_TAB_CHANNEL,
          null,
        );
        sendToApplicationRenderer(
          browserWindow,
          OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.newTab",
        );
      }
    },
    openNewThread() {
      const browserWindow = getFocusedApplicationWindow();

      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
          "thread.new",
        );
      }
    },
    reopenClosedTab() {
      const browserWindow = getFocusedApplicationWindow();

      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.reopenClosedTab",
        );
      }
    },
    openSettings() {
      const browserWindow = getFocusedApplicationWindow();

      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
          "settings.open",
        );
      }
    },
    zoomFocusedPage(command) {
      zoomWebContents(electronWebContents.getFocusedWebContents(), command);
    },
    reloadWindow(browserWindow, ignoreCache) {
      if (!(browserWindow instanceof BrowserWindow)) {
        return;
      }

      reloadApplicationWindow(browserWindow, ignoreCache);
    },
    closeWindowOrSideTab(browserWindow) {
      if (browserWindow === undefined) {
        closeFocusedDetachedDevTools();

        return;
      }

      if (
        !(browserWindow instanceof BrowserWindow) ||
        browserWindow === logViewerWindow
      ) {
        browserWindow.close();

        return;
      }

      requestRendererWindowClose(browserWindow);
    },
    openServerDaemonLogs() {
      void openServerDaemonLogs();
    },
    onServerMenuWillShow() {
      connectServerSync?.onListRequested();
    },
    serverDaemonLogsMenuEnabled: shouldEnableServerDaemonLogsMenu(),
  });
}

function setCurrentRuntime(runtime: DesktopRuntime | null): void {
  currentRuntime = runtime;

  if (runtime === null) {
    stopSystemConfigSync();
  } else {
    connectServerSync?.onRuntimeReady();
  }

  refreshApplicationMenu();

  if (runtime?.ownership !== "spawned") {
    closeServerDaemonLogsWindow();
  }

  sendDesktopInfoChanged();
}

function formatApiUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/api/v1/system/config";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function formatRealtimeUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";

  return url.toString();
}

async function fetchSystemConfig(args: SystemConfigRequestArgs) {
  const response = await args.fetchImpl(formatApiUrl(args.serverUrl));

  if (!response.ok) {
    throw new Error(
      `System config request failed with HTTP ${response.status}`,
    );
  }

  const payload: unknown = await response.json();

  return parseDesktopSystemConfig(payload);
}

function createSystemConfigSync(serverUrl: string): SystemConfigSync {
  const realtimeUrl = formatRealtimeUrl(serverUrl);

  const subscribeMessage: ClientMessage = {
    type: "subscribe",
    target: { kind: "system" },
  };

  let reconnectTimer: NodeJS.Timeout | null = null;
  let socket: WebSocket | null = null;
  let stopped = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    try {
      const parsed = serverMessageLenientSchema.safeParse(
        JSON.parse(event.data),
      );

      if (!parsed.success) {
        return;
      }

      if (
        parsed.data.entity === "system" &&
        parsed.data.changes.includes("config-changed")
      ) {
        void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
      }
    } catch {
      return;
    }
  }

  function connect(): void {
    if (stopped) {
      return;
    }

    socket = new WebSocket(realtimeUrl);
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify(subscribeMessage));
      void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
}

async function refreshSystemConfig(
  args: SystemConfigRequestArgs,
): Promise<void> {
  const token = systemConfigRefreshToken + 1;
  systemConfigRefreshToken = token;

  try {
    const config = await fetchSystemConfig(args);

    if (token !== systemConfigRefreshToken) {
      return;
    }

    currentAppKeybindings = config.keybindings;
    currentApplicationMenuAccelerators = resolveApplicationMenuAccelerators(
      currentAppKeybindings,
    );
    refreshApplicationMenu();
  } catch (error) {
    if (token !== systemConfigRefreshToken) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not refresh system config: ${message}\n`);
  }
}

function createRemoteSystemConfigSync(serverUrl: string): SystemConfigSync {
  function refresh(): void {
    void refreshSystemConfig({
      fetchImpl: (input, init) =>
        net.fetch(input as string | Request, {
          ...init,
          credentials: "include",
        }),
      serverUrl,
    });
  }

  const timer = setInterval(refresh, REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS);
  timer.unref();
  refreshRemoteSystemConfig = refresh;
  refresh();

  return {
    stop(): void {
      clearInterval(timer);
      refreshRemoteSystemConfig = null;
    },
  };
}

const desktopNotificationClientId = randomUUID();

let desktopNotifications: ReturnType<typeof startDesktopNotifications> | null =
  null;

function readDesktopPresence(locked = false): DesktopPresence {
  return {
    idleSeconds: powerMonitor.getSystemIdleTime(),
    locked: locked || powerMonitor.getSystemIdleState(1) === "locked",
  };
}

function watchDesktopPresence(): void {
  const reportCurrent = () => desktopNotifications?.reportPresence();

  const reportAway = () =>
    desktopNotifications?.reportPresence(readDesktopPresence(true));

  powerMonitor.on("lock-screen", reportAway);
  powerMonitor.on("suspend", reportAway);
  powerMonitor.on("user-did-resign-active", reportAway);
  powerMonitor.on("unlock-screen", reportCurrent);
  powerMonitor.on("resume", reportCurrent);
  powerMonitor.on("user-did-become-active", reportCurrent);
}

function startSystemNotifications(serverUrl: string): void {
  desktopNotifications?.stop();
  desktopNotifications = startDesktopNotifications({
    serverUrl,
    clientId: desktopNotificationClientId,
    fetchImpl: (input, init) =>
      net.fetch(input as string | Request, { ...init, credentials: "include" }),
    async getCookie() {
      const cookies = await session.defaultSession.cookies.get({
        url: serverUrl,
      });

      return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    },
    readPresence: () => readDesktopPresence(),
    isSupported: () => !quitting && Notification.isSupported(),
    createNotification: ({ title, body, threadId }) =>
      new Notification({
        title,
        body,
        ...(threadId === null
          ? {}
          : { groupId: desktopNotificationGroupId(threadId) }),
      }),
    removeThreadNotifications(threadId) {
      if (process.platform === "darwin")
        Notification.removeGroup(desktopNotificationGroupId(threadId));
    },
    openThread(threadId) {
      void openDesktopNotificationThread({
        serverUrl,
        threadId,
        window: getFocusedApplicationWindow(),
        createWindow: (url) =>
          createApplicationWindow({ initialUrl: url, stateKey: null }),
        async openThreadInWindow(browserWindow, openedThreadId) {
          const handled = await requestRendererOpenThread(
            browserWindow,
            openedThreadId,
          );

          desktopLogger.info(
            handled
              ? "Notification opened its chat in the running window"
              : "Notification chat open fell back to reloading the window",
          );

          return handled;
        },
        async navigateWindow(browserWindow, url) {
          if (browserWindow.webContents.getURL() === url) return;
          desktopBrowserViewManager?.prepareWindowReload(browserWindow);
          await browserWindow.loadURL(url);
        },
      }).catch((error: unknown) => desktopLogger.warn(String(error)));
    },
    onError: (error) =>
      desktopLogger.warn(
        `Desktop notification delivery failed: ${String(error)}`,
      ),
  });
}

function stopSystemConfigSync(): void {
  desktopNotifications?.stop();
  desktopNotifications = null;
  systemConfigSync?.stop();
  systemConfigSync = null;
}

function startSystemConfigSync(serverUrl: string): void {
  startSystemNotifications(serverUrl);
  systemConfigSync?.stop();
  systemConfigSync = createSystemConfigSync(serverUrl);
  void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
}

function startRemoteSystemConfigSync(serverUrl: string): void {
  startSystemNotifications(serverUrl);
  systemConfigSync?.stop();
  systemConfigSync = createRemoteSystemConfigSync(serverUrl);
}

function registerApplicationWindow(browserWindow: DesktopBrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  applicationWindowWebContentsIds.add(webContentsId);
  browserWindow.webContents.on("did-finish-load", () => {
    if (workflowImports.pending)
      electronWebContents
        .fromId(webContentsId)
        ?.send(WORKFLOW_IMPORT_READY_CHANNEL);
  });
  applicationWindowNavigationGenerations.set(webContentsId, 0);
  const nativeWindow = BrowserWindow.fromId(browserWindow.id);

  if (nativeWindow !== null) {
    desktopBrowserBroker?.registerWindow(nativeWindow);
    nativeWindow.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame) {
          applicationWindowNavigationGenerations.set(
            webContentsId,
            (applicationWindowNavigationGenerations.get(webContentsId) ?? 0) +
              1,
          );
        }

        if (isMainFrame && !isInPlace) {
          splitNavigationEnabledWebContentsIds.delete(webContentsId);
          splitNavigationCommandsByWebContentsId.delete(webContentsId);
          desktopFindViewManager?.close(nativeWindow);
        }
      },
    );

    const layoutFindView = () => {
      desktopFindViewManager?.layout(nativeWindow);
    };

    nativeWindow.on("resize", layoutFindView);
    nativeWindow.on("enter-full-screen", layoutFindView);
    nativeWindow.on("leave-full-screen", layoutFindView);
  }

  registerApplicationRendererReloadShortcut(
    (browserWindow as BrowserWindow).webContents,
  );
  registerDesktopContextMenu({ webContents: browserWindow.webContents });
  browserWindow.on("enter-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("leave-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("closed", () => {
    desktopFindViewManager?.releaseWindow(webContentsId);
    desktopBrowserBroker?.releaseWindow(webContentsId);
    applicationWindowWebContentsIds.delete(webContentsId);
    applicationWindowNavigationGenerations.delete(webContentsId);
    splitNavigationEnabledWebContentsIds.delete(webContentsId);
    splitNavigationCommandsByWebContentsId.delete(webContentsId);
  });
}

async function ensureBuiltinRuntimeAttached(): Promise<boolean> {
  if (localServerMove !== null) {
    return false;
  }

  if (currentRuntime !== null) {
    return true;
  }

  if (desktopBridgePath === null || desktopUserDataPath === null) {
    return false;
  }

  const existingProbe = await probeOmnyoServer({
    expectedAppVersion: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
    serverUrl: builtinServerUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (
    DESKTOP_RELEASE_CHANNEL === "public-beta" &&
    existingProbe.kind !== "unavailable"
  ) {
    await loadStartupError(PUBLIC_LOCAL_ADDRESS_BUSY_ERROR);

    return false;
  }

  if (existingProbe.kind === "compatible") {
    setCurrentRuntime({
      appProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });

    return true;
  }

  if (existingProbe.kind === "incompatible") {
    await loadStartupError({
      details: existingProbe.reason,
      logs: "",
      actions: [],
      title: "Could not connect Omnyo",
    });

    return false;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: desktopBridgePath,
    serverUrl: builtinServerUrl,
    userDataPath: desktopUserDataPath,
  });

  return runtime !== null;
}

async function authenticateConnectTarget(
  remoteServerUrl: string,
  targetHandle: string,
  isCurrent: () => boolean,
): Promise<ConnectDesktopSessionResult> {
  const cookieStore = session.defaultSession.cookies;
  let cachedFailure: ConnectDesktopSessionResult | null = null;

  if (cachedConnectCredential !== null) {
    const cachedResult = await installConnectDesktopSession({
      cookieStore,
      mintCookie: createCredentialCookieSource({
        credential: cachedConnectCredential,
      }),
      remoteServerUrl,
    });

    if (cachedResult.ok) {
      return cachedResult;
    }

    if (cachedResult.code === "unauthorized") {
      desktopLogger.info(
        "[desktop] Omnyo Connect refused the cached machine credential — dropping it",
      );
      await clearCachedConnectCredential();
    } else if (cachedResult.code === "network") {
      return cachedResult;
    }

    cachedFailure = cachedResult;
  }

  if (!isCurrent()) {
    return (
      cachedFailure ?? {
        code: "network",
        detail: "the app no longer targets this server",
        ok: false,
      }
    );
  }

  const movedCredential = await readLocalServerMoveCredential(remoteServerUrl);

  if (movedCredential !== null) {
    const movedResult = await installConnectDesktopSession({
      cookieStore,
      mintCookie: createCredentialCookieSource({
        credential: movedCredential,
      }),
      remoteServerUrl,
    });

    if (movedResult.ok || movedResult.code !== "unauthorized") {
      return movedResult;
    }

    cachedFailure = movedResult;
  }

  const accountUrl = deriveConnectBaseUrl(remoteServerUrl);

  const accountCookieName = CONNECT_ACCOUNT_SESSION_COOKIE;

  const accountCookies = await cookieStore.get({
    name: accountCookieName,
    url: accountUrl,
  });

  const accountCookie = accountCookies.find(
    (cookie) => cookie.name === accountCookieName,
  );

  if (accountCookie !== undefined) {
    const accountResult = await installConnectDesktopSession({
      cookieStore,
      mintCookie: createAccountCookieSource({
        accountCookie,
        remoteServerUrl,
        targetHandle,
      }),
      remoteServerUrl,
    });

    if (accountResult.ok || accountResult.code !== "unauthorized") {
      return accountResult;
    }

    cachedFailure = accountResult;
  }

  if (movedCredential !== null) {
    return (
      cachedFailure ?? {
        code: "unauthorized",
        detail: "Omnyo Connect rejected this app",
        ok: false,
      }
    );
  }

  const localRuntimeReady = await ensureBuiltinRuntimeAttached();

  if (!localRuntimeReady || currentRuntime === null) {
    return (
      cachedFailure ?? {
        code: "network",
        detail:
          "the local Omnyo server is unavailable, and this app has no stored Omnyo Connect credential",
        ok: false,
      }
    );
  }

  const localResult = await installConnectDesktopSession({
    cookieStore,
    mintCookie: createLocalServerCookieSource({
      localServerUrl: currentRuntime.serverUrl,
    }),
    remoteServerUrl,
  });

  if (localResult.ok) {
    void ensureDesktopMachineEnrolled();
  }

  return localResult;
}

async function clearCachedConnectCredential(): Promise<void> {
  cachedConnectCredential = null;
  await connectCredentialCache?.clear();
}

async function readLocalServerMoveCredential(
  remoteServerUrl: string,
): Promise<ConnectCredential | null> {
  if (localServerMove === null || builtinDataDir === null) {
    return null;
  }

  return readServerMovedConnectCredential({
    dataDir: builtinDataDir,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    move: localServerMove,
    remoteServerUrl,
  });
}

function showServerMovedNotice(notice: ServerMovedNotice): void {
  const options: MessageBoxOptions = {
    buttons: ["OK"],
    detail: notice.detail,
    message: notice.message,
    type: "info",
  };

  const parentWindow = getFocusedApplicationWindow();

  const shown =
    parentWindow === null
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(parentWindow, options);

  shown.catch((error: unknown) => {
    desktopLogger.warn(
      `[desktop] could not show the server move notice: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function activateLocalServerMove(move: DesktopServerMove): Promise<void> {
  if (
    serverTargetStore === null ||
    serverMoveNoticeStore === null ||
    machineServiceNoticeStore === null ||
    desktopBridgePath === null ||
    desktopUserDataPath === null ||
    builtinDataDir === null
  ) {
    return;
  }

  const bridgePath = desktopBridgePath;
  const userDataPath = desktopUserDataPath;
  localServerMove = move;
  stopServerMovedWatcher();
  desktopLogger.info(
    `[desktop] this computer's Omnyo server moved to ${move.toHostName}; the app now opens that server and runs this computer as a regular machine`,
  );
  await applyServerMove({
    move,
    noticeStore: serverMoveNoticeStore,
    showNotice: showServerMovedNotice,
    targetStore: serverTargetStore,
  });
  refreshApplicationMenu();
  connectMovedMachine({
    bridgePath,
    dataDir: builtinDataDir,
    move,
    noticeStore: machineServiceNoticeStore,
    userDataPath,
  });
}

function connectMovedMachine(args: {
  bridgePath: string;
  dataDir: string;
  move: DesktopServerMove;
  noticeStore: ServerMoveNoticeStore;
  userDataPath: string;
}): void {
  if (movedMachineConnection !== null) {
    return;
  }

  const logPath = join(
    args.dataDir,
    "logs",
    MACHINE_SERVICE_INSTALL_LOG_FILE_NAME,
  );

  movedMachineConnection = (async () => {
    const connection = await keepMovedMachineConnected({
      findService: () =>
        findMachineServiceFile({
          dataDir: args.dataDir,
          homeDir: homedir(),
          platform: process.platform,
        }),
      install: async () => {
        await shellPathReady;

        if (quitting) throw new Error("Desktop app is quitting");

        return runMachineInstaller({
          dataDir: args.dataDir,
          env: process.env,
          installerPath: resolveDesktopMachineInstallerPath(args.bridgePath),
          logPath,
        });
      },
      logInfo: (message) => {
        desktopLogger.info(message);
      },
      logPath,
      move: args.move,
      noticeStore: args.noticeStore,
      showNotice: showServerMovedNotice,
      stopLocalRuntime: stopOwnedRuntime,
    });

    if (quitting) {
      return;
    }

    await ensureServerMovedRuntime({
      hasLocalRuntime: () => currentRuntime !== null,
      machineServiceConnected:
        connection !== "install-failed" &&
        serverTargetStore !== null &&
        serverTargetStore.getTarget().kind !== "builtin",
      async isLocalAddressFree() {
        const probe = await probeOmnyoServer({
          serverUrl: builtinServerUrl,
          timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
        });

        return probe.kind === "unavailable";
      },
      localServerUrl: builtinServerUrl,
      logInfo: (message) => {
        desktopLogger.info(message);
      },
      async startLocalRuntime() {
        await spawnOwnedRuntime({
          bridgePath: args.bridgePath,
          serverUrl: builtinServerUrl,
          userDataPath: args.userDataPath,
        });
      },
    });
    refreshApplicationMenu();
  })()
    .catch((error: unknown) => {
      desktopLogger.warn(
        `[desktop] could not keep this computer connected as a machine: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      movedMachineConnection = null;
    });
}

async function confirmLocalServerMove(
  move: DesktopServerMove,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  const dataDir = builtinDataDir;

  if (dataDir === null) {
    return false;
  }

  const result = await waitForCommittedServerMove({
    dataDir,
    async hasLiveLocalLauncher() {
      return (
        currentRuntime?.ownership === "spawned" ||
        (await hasLiveOmnyoAppLauncher({ dataDir }))
      );
    },
    intervalMs: SERVER_MOVE_COMMIT_INTERVAL_MS,
    isCancelled: () => quitting || isCancelled(),
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    move,
    probeLocalServer: () =>
      probeLocalServerMove({
        serverUrl: builtinServerUrl,
        timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
      }),
    timeoutMs,
  });

  if (result === "withdrawn") {
    desktopLogger.info(
      `[desktop] server move ${move.moveId} was withdrawn before it finished; staying on ${BUILTIN_SERVER_NAME}`,
    );
  } else if (result === "timed-out" && timeoutMs > 0) {
    desktopLogger.warn(
      `[desktop] server move ${move.moveId} is locked, but ${builtinServerUrl} did not report server_moved within ${timeoutMs}ms; staying on ${BUILTIN_SERVER_NAME}`,
    );
  }

  return result === "committed";
}

async function readCommittedLocalServerMove(): Promise<DesktopServerMove | null> {
  if (builtinDataDir === null) {
    return null;
  }

  const move = await readServerMovedLock({
    dataDir: builtinDataDir,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
  });

  if (move === null || !(await confirmLocalServerMove(move, 0, () => false))) {
    return null;
  }

  return move;
}

async function activateLocalServerMoveIfLocked(): Promise<void> {
  const move = await readCommittedLocalServerMove();

  if (move === null) {
    localServerMove = null;

    return;
  }

  await activateLocalServerMove(move);
}

function startServerMovedWatcher(): void {
  if (
    serverMovedWatcher !== null ||
    localServerMove !== null ||
    builtinDataDir === null
  ) {
    return;
  }

  serverMovedWatcher = createServerMovedWatcher({
    confirmMove: (move, isCancelled) =>
      confirmLocalServerMove(move, SERVER_MOVE_COMMIT_TIMEOUT_MS, isCancelled),
    dataDir: builtinDataDir,
    debounceMs: SERVER_MOVED_WATCH_DEBOUNCE_MS,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    onMove(move) {
      void handleWatchedServerMove(move);
    },
    pollIntervalMs: SERVER_MOVED_POLL_INTERVAL_MS,
  });
  serverMovedWatcher.start();
}

function stopServerMovedWatcher(): void {
  serverMovedWatcher?.stop();
  serverMovedWatcher = null;
}

async function handleWatchedServerMove(move: DesktopServerMove): Promise<void> {
  if (
    localServerMove !== null ||
    serverTargetStore?.getTarget().kind !== "builtin"
  ) {
    stopServerMovedWatcher();

    return;
  }

  try {
    await activateLocalServerMove(move);
  } catch (error) {
    desktopLogger.warn(
      `[desktop] could not switch to the moved Omnyo server: ${error instanceof Error ? error.message : String(error)}`,
    );

    return;
  }

  const generation = serverTargetGeneration;

  if (move.target.kind === "custom") {
    await waitForServerMoveDestination({
      fetchImpl: (input, init) => net.fetch(input, init),
      intervalMs: SERVER_MOVE_DESTINATION_INTERVAL_MS,
      isCancelled: () => quitting || serverTargetGeneration !== generation,
      serverUrl: move.target.url,
      timeoutMs: SERVER_MOVE_DESTINATION_TIMEOUT_MS,
    });
  }

  if (quitting || serverTargetGeneration !== generation) {
    return;
  }

  await applyServerTarget();
  connectServerSync?.syncNow().catch(() => {});
}

function ensureDesktopMachineEnrolled(): void {
  const cache = connectCredentialCache;
  const localServerUrl = currentRuntime?.serverUrl;

  if (
    cache === null ||
    cachedConnectCredential !== null ||
    enrollingDesktopMachine !== null ||
    localServerUrl === undefined
  ) {
    return;
  }

  if (!cache.canPersist()) {
    desktopLogger.info(
      "[desktop] no OS keychain available — keeping the local Omnyo server for Omnyo Connect sessions",
    );

    return;
  }

  enrollingDesktopMachine = (async () => {
    const result = await enrollDesktopMachine({ localServerUrl });

    if (!result.ok) {
      desktopLogger.info(
        `[desktop] could not enroll this app with Omnyo Connect (${result.code}): ${result.detail}`,
      );

      return;
    }

    cachedConnectCredential = result.credential;
    await cache.write(result.credential);
    desktopLogger.info(
      "[desktop] enrolled this app as an Omnyo Connect machine",
    );
  })().finally(() => {
    enrollingDesktopMachine = null;
  });
}

async function runStartupAction(
  action: StartupActionId,
  browserWindow: BrowserWindow | null,
): Promise<void> {
  if (action === "choose-server") {
    popupServerMenu(browserWindow);

    return;
  }

  if (action === "reconnect-connect") {
    openConnectSignIn(browserWindow);

    return;
  }

  if (startupActionPending) {
    return;
  }

  startupActionPending = true;

  try {
    startupErrorPage = null;
    await loadLoadingView();

    if (
      action === "open-moved-server" &&
      localServerMove !== null &&
      serverTargetStore !== null
    ) {
      await openServerMoveTarget({
        move: localServerMove,
        targetStore: serverTargetStore,
      });
    }

    await applyServerTarget();
  } catch (error) {
    await loadStartupError({
      actions: [],
      details: error instanceof Error ? error.message : String(error),
      logs: "",
      title: "Could not open Omnyo",
    });
  } finally {
    startupActionPending = false;
  }
}

function openConnectSignIn(parentWindow: BrowserWindow | null): void {
  const target = serverTargetStore?.getTarget();

  if (target?.kind !== "connect") return;
  const targetUrl = target.server.url;

  if (connectSignInWindow !== null && !connectSignInWindow.isDestroyed()) {
    connectSignInWindow.focus();

    return;
  }

  const accountUrl = deriveConnectBaseUrl(targetUrl);
  const accountHost = new URL(accountUrl).hostname;

  const cookieName = CONNECT_ACCOUNT_SESSION_COOKIE;

  const signInUrl = new URL("/dashboard", accountUrl);
  signInUrl.searchParams.set("returnTo", targetUrl);

  const signInWindow = new BrowserWindow({
    height: 720,
    parent: parentWindow ?? undefined,
    title: "Reconnect Omnyo Connect",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 520,
  });

  connectSignInWindow = signInWindow;
  let completed = false;

  const onCookieChanged = (
    _event: Electron.Event,
    cookie: Electron.Cookie,
    _cause: string,
    removed: boolean,
  ): void => {
    if (
      completed ||
      removed ||
      cookie.name !== cookieName ||
      (cookie.domain ?? "").replace(/^\./u, "") !== accountHost
    )
      return;
    completed = true;
    session.defaultSession.cookies.removeListener("changed", onCookieChanged);

    if (!signInWindow.isDestroyed()) signInWindow.close();
    const currentTarget = serverTargetStore?.getTarget();

    if (
      currentTarget?.kind === "connect" &&
      currentTarget.server.url === targetUrl
    ) {
      void applyServerTarget();
    }
  };

  session.defaultSession.cookies.on("changed", onCookieChanged);
  signInWindow.on("closed", () => {
    session.defaultSession.cookies.removeListener("changed", onCookieChanged);

    if (connectSignInWindow === signInWindow) connectSignInWindow = null;
  });
  void session.defaultSession.cookies
    .remove(accountUrl, cookieName)
    .catch((error: unknown) => {
      desktopLogger.warn(
        `[desktop] could not clear Omnyo Connect sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .then(async () => {
      if (!signInWindow.isDestroyed()) {
        await signInWindow.loadURL(signInUrl.toString());
      }
    })
    .catch((error: unknown) => {
      desktopLogger.warn(
        `[desktop] could not open Omnyo Connect sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (!signInWindow.isDestroyed()) signInWindow.close();
    });
}

async function selectBuiltinServer(): Promise<void> {
  if (serverTargetStore === null) {
    return;
  }

  const move = await readCommittedLocalServerMove();

  if (move !== null) {
    localServerMove = move;
    await loadServerMovedView(move);
    refreshApplicationMenu();

    return;
  }

  const switched = await serverTargetStore.setTarget("builtin");

  if (!switched) {
    refreshApplicationMenu();

    return;
  }

  await applyServerTarget();
}

async function loadServerMovedView(move: DesktopServerMove): Promise<void> {
  await loadActionView({
    actions: [
      { id: "open-moved-server", label: `Open ${move.toHostName}` },
      { id: "choose-server", label: "Choose server…" },
    ],
    details: move.oldCopyKept
      ? "The old copy on this computer is locked after the move."
      : "The old copy on this computer was deleted.",
    logs: "",
    title: `Omnyo moved to ${move.toHostName}`,
  });
}

async function applyServerTarget(): Promise<void> {
  workflowImportServerUrl = null;
  startupErrorPage = null;
  desktopBrowserBrokerClient?.reconnect();

  if (serverTargetStore === null) {
    return;
  }

  connectSessionRenewal?.stop();
  serverTargetGeneration += 1;
  const generation = serverTargetGeneration;
  const isCurrent = (): boolean => serverTargetGeneration === generation;

  if (serverTargetStore.getTarget().kind === "builtin") {
    await activateLocalServerMoveIfLocked();

    if (!isCurrent()) {
      return;
    }
  }

  const target = serverTargetStore.getTarget();

  if (target.kind === "builtin") {
    startServerMovedWatcher();
    const attached = await ensureBuiltinRuntimeAttached();

    if (!isCurrent()) {
      return;
    }

    if (!attached) {
      await loadStartupError({
        actions: [
          { id: "retry", label: "Try again" },
          { id: "choose-server", label: "Choose server…" },
        ],
        details:
          `Could not connect to the local Omnyo server on ${process.platform === "darwin" ? "this Mac" : "this computer"}. ` +
          "Check that the port is free or that a compatible Omnyo server is running.",
        logs: "",
        title: "Could not connect to Omnyo server",
      });
      refreshApplicationMenu();

      return;
    }

    const localServerUrl = currentRuntime?.serverUrl ?? builtinServerUrl;
    startSystemConfigSync(localServerUrl);
    await loadOmnyoApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: localServerUrl,
      }),
    );
  } else if (target.kind === "connect") {
    stopServerMovedWatcher();

    const result = await authenticateConnectTarget(
      target.server.url,
      target.server.handle,
      isCurrent,
    );

    if (!isCurrent()) {
      return;
    }

    if (!result.ok) {
      desktopLogger.warn(
        `[desktop] Connect authentication failed (${result.code}): ${result.detail}`,
      );
      const unauthorized = result.code === "unauthorized";
      await loadStartupError({
        actions: [
          ...(unauthorized
            ? [
                {
                  id: "reconnect-connect" as const,
                  label: "Reconnect",
                },
              ]
            : [{ id: "retry" as const, label: "Try again" }]),
          { id: "choose-server", label: "Choose server…" },
        ],
        details: unauthorized
          ? "The desktop app could not establish a session for this Connect server. " +
            (result.detail === "this account does not own the selected server"
              ? `(unauthorized: This account does not own ${target.server.name}.)`
              : "(unauthorized: The app was rejected.)")
          : "The desktop app could not establish a session for this Connect server. " +
            `(${result.code}: ${result.detail})`,
        logs: "",
        title: "Could not authenticate with Omnyo Connect",
      });
      refreshApplicationMenu();

      return;
    }

    connectSessionRenewal?.start({
      expiresAt: result.expiresAt,
      remoteServerUrl: target.server.url,
    });
    const loaded = await loadRemoteServerTarget(target.server.url, isCurrent);

    if (!isCurrent()) {
      return;
    }

    if (!loaded) {
      connectSessionRenewal?.stop();
    }
  } else {
    stopServerMovedWatcher();
    await loadRemoteServerTarget(target.url, isCurrent);

    if (!isCurrent()) {
      return;
    }
  }

  refreshApplicationMenu();
}

async function loadRemoteServerTarget(
  serverUrl: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const loaded = await loadRemoteServerPage({
    isCurrent,
    loadStartupError,
    loadUrl: loadWindowUrl,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    serverUrl,
  });

  if (!loaded || !isCurrent()) {
    return loaded;
  }

  omnyoAppLoaded = true;
  workflowImportServerUrl = serverUrl;

  if (workflowImports.pending) {
    await loadWindowUrl({ url: workflowImportDestination(serverUrl) });
  } else {
    await openSkillPackImport(serverUrl);
  }

  startRemoteSystemConfigSync(serverUrl);

  return true;
}

async function setActiveServerTarget(serverId: string): Promise<void> {
  if (
    serverTargetStore === null ||
    !listServerChoices().some(
      (choice) => choice.id === serverId && !choice.active,
    )
  ) {
    return;
  }

  if (serverId.startsWith("connect:")) {
    const handle = serverId.slice("connect:".length);

    const server = listMenuConnectServers().find(
      (candidate) => candidate.handle === handle,
    );

    if (server === undefined) {
      refreshApplicationMenu();

      return;
    }

    await serverTargetStore.setConnectServer(server);
    await applyServerTarget();

    return;
  }

  if (serverId.startsWith("custom:")) {
    const url = serverTargetStore
      .getCustomServerUrls()
      .find((url) => customServerId(url) === serverId);

    if (url === undefined) {
      return;
    }

    await serverTargetStore.setCustomServerUrl(url);
    await applyServerTarget();

    return;
  }

  if (serverId === "builtin") await selectBuiltinServer();
}

async function openSetServerUrlDialog(add = false): Promise<void> {
  if (serverTargetStore === null || serverUrlDialogPreloadPath === null) {
    return;
  }

  const previousUrl = add ? null : serverTargetStore.getCustomServerUrl();

  const result = await openServerUrlDialog({
    initialUrl: previousUrl,
    parentWindow: getFocusedApplicationWindow(),
    preloadPath: serverUrlDialogPreloadPath,
  });

  if (result.kind === "cancelled") {
    return;
  }

  if (
    result.kind === "clear" &&
    serverTargetStore.getCustomServerUrl() === null
  ) {
    return;
  }

  await serverTargetStore.setCustomServerUrl(
    result.kind === "set" ? result.url : null,
    previousUrl ?? undefined,
  );
  await applyServerTarget();
}

function sendLogViewerSnapshot(args: SendLogViewerSnapshotArgs): void {
  if (args.browserWindow.isDestroyed()) {
    return;
  }

  args.browserWindow.webContents.send(LOG_VIEWER_SNAPSHOT_CHANNEL, {
    lines: args.lines,
    logDir: args.logDir,
  });
}

function closeServerDaemonLogsWindow(): void {
  logViewerTailer?.stop();
  logViewerTailer = null;
  logViewerLineBuffer?.stop();
  logViewerLineBuffer = null;

  const browserWindow = logViewerWindow;
  logViewerWindow = null;

  if (browserWindow !== null && !browserWindow.isDestroyed()) {
    browserWindow.close();
  }
}

async function handleOpenLogsFolder(): Promise<LogViewerOpenLogsFolderResult> {
  if (!shouldEnableServerDaemonLogsMenu()) {
    throw new Error(
      "Server and daemon logs are only available for owned runtimes",
    );
  }

  const logDir = formatLogDirectory();
  const errorMessage = await shell.openPath(logDir);

  if (errorMessage.length > 0) {
    throw new Error(errorMessage);
  }

  return { path: logDir };
}

function installLogViewerIpcHandlers(): void {
  ipcMain.handle(
    LOG_VIEWER_COPY_CHANNEL,
    (_event, request: LogViewerCopyRequest) => {
      return clipboard.writeText(
        logViewerCopyRequestSchema.parse(request).text,
      );
    },
  );
  ipcMain.handle(LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL, () =>
    handleOpenLogsFolder(),
  );
}

async function loadLogViewerWindow(
  args: LoadLogViewerWindowArgs,
): Promise<void> {
  const browserWindow = new BrowserWindow({
    height: 720,
    minHeight: 520,
    minWidth: 840,
    show: false,
    title: "Omnyo - Server & Daemon Logs",
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
    },
    width: 1180,
  });

  const tailer = createLogTailer({
    shellPathReady,
    logDir: args.logDir,
    onLines(lines) {
      logViewerLineBuffer?.append(lines);
    },
  });

  const lineBuffer = createLogLineBuffer({
    flushIntervalMs: LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
    flushLineCount: LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
    maxLines: LOG_VIEWER_VISIBLE_LINE_LIMIT,
    onFlush(lines) {
      if (logViewerWindow === null || logViewerWindow.isDestroyed()) {
        return;
      }

      logViewerWindow.webContents.send(LOG_VIEWER_APPEND_CHANNEL, {
        lines,
      });
    },
  });

  logViewerLineBuffer = lineBuffer;
  logViewerTailer = tailer;
  logViewerWindow = browserWindow;

  browserWindow.once("ready-to-show", () => {
    browserWindow.show();
  });
  browserWindow.on("closed", () => {
    if (logViewerTailer === tailer) {
      logViewerTailer = null;
      tailer.stop();
    }

    if (logViewerWindow === browserWindow) {
      logViewerWindow = null;
    }

    if (logViewerLineBuffer === lineBuffer) {
      logViewerLineBuffer = null;
    }

    lineBuffer.stop();
  });

  await browserWindow.loadURL(createLogViewerViewUrl({ logDir: args.logDir }));
  sendLogViewerSnapshot({
    browserWindow,
    lines: lineBuffer.lines(),
    logDir: args.logDir,
  });
  await tailer.start();
}

async function openServerDaemonLogs(): Promise<void> {
  if (!shouldEnableServerDaemonLogsMenu() || logViewerPreloadPath === null) {
    return;
  }

  if (logViewerWindow !== null && !logViewerWindow.isDestroyed()) {
    logViewerWindow.focus();

    return;
  }

  await loadLogViewerWindow({
    logDir: formatLogDirectory(),
    preloadPath: logViewerPreloadPath,
  });
}

async function openDataDirectory(): Promise<void> {
  const dataDir = resolveDataDirFromEnv({
    env: process.env,
    homeDir: homedir(),
  });

  const errorMessage = await shell.openPath(dataDir);

  if (errorMessage.length > 0) {
    desktopLogger.error(
      `[desktop] could not open the data directory ${dataDir}: ${errorMessage}`,
    );
  }
}

async function loadWindowUrl(args: LoadWindowUrlArgs): Promise<void> {
  startupErrorPage = null;
  currentWindowUrl = args.url;

  if (desktopWindowFactory === null) {
    return;
  }

  await desktopWindowFactory.loadUrl({ url: args.url });
}

async function loadLoadingView(): Promise<void> {
  omnyoAppLoaded = false;
  await loadWindowUrl({
    url: createLocalViewUrl({
      viewModel: {
        kind: "loading",
        message: "Starting local services and opening the Omnyo workspace.",
        title: "Opening Omnyo",
      },
    }),
  });
}

async function loadStartupError(args: LoadStartupErrorArgs): Promise<void> {
  await loadActionView({
    ...args,
    details:
      args.actions.length === 0
        ? `${args.details} Logs are under ${formatLogDirectory()}/.`
        : args.details,
  });
}

async function loadActionView(args: LoadStartupErrorArgs): Promise<void> {
  omnyoAppLoaded = false;

  const url = createLocalViewUrl({
    viewModel: {
      actions: args.actions,
      details: args.details,
      kind: "error",
      logText: args.logs,
      title: args.title,
    },
  });

  const loading = loadWindowUrl({ url });
  startupErrorPage =
    args.actions.length === 0
      ? null
      : { actions: args.actions.map((action) => action.id), url };
  await loading;
}

async function loadOmnyoApp(serverUrl: string): Promise<void> {
  omnyoAppLoaded = true;
  workflowImportServerUrl = serverUrl;
  await loadWindowUrl({
    url: workflowImports.pending
      ? workflowImportDestination(serverUrl)
      : serverUrl,
  });

  if (!workflowImports.pending) await openSkillPackImport(serverUrl);

  if (shouldOpenDevTools()) {
    desktopWindowFactory?.openDevTools();
  }
}

function shouldOpenDevTools(): boolean {
  return process.env.OMNYO_DESKTOP_OPEN_DEVTOOLS === "1";
}

async function createApplicationWindow(
  args: CreateApplicationWindowArgs,
): Promise<DesktopBrowserWindow | null> {
  if (desktopWindowFactory === null) {
    return null;
  }

  const browserWindow = await desktopWindowFactory.createWindow({
    initialUrl: args.initialUrl,
    stateKey: args.stateKey,
  });

  registerApplicationWindow(browserWindow);

  if (omnyoAppLoaded && shouldOpenDevTools()) {
    browserWindow.webContents.openDevTools({ mode: "detach" });
  }

  return browserWindow;
}

async function stopOwnedRuntime(): Promise<void> {
  const runtime = currentRuntime;

  if (runtime === null || runtime.ownership !== "spawned") {
    setCurrentRuntime(null);

    return;
  }

  setCurrentRuntime(null);

  try {
    await runtime.appProcess?.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: OWNED_RUNTIME_KILL_TIMEOUT_MS,
      signal: "SIGTERM",
      timeoutMs: OWNED_RUNTIME_STOP_TIMEOUT_MS,
    });
  } finally {
    if (runtime.userDataPath !== null) {
      await clearOwnedRuntimePidFile({ userDataPath: runtime.userDataPath });
    }
  }
}

function handleBeforeQuit(event: Event): void {
  if (
    !stoppingForQuit &&
    privateUpdateInstaller !== null &&
    !privateUpdateInstaller.canQuitOrdinarily()
  ) {
    event.preventDefault();
    desktopLogger.error(
      "Private update handoff is pending; quit is deferred until compatible recovery.",
    );

    return;
  }

  quitting = true;

  if (stoppingForQuit) {
    return;
  }

  event.preventDefault();
  stoppingForQuit = true;
  void finishQuit().finally(() => {
    app.quit();
  });
}

async function finishQuit(): Promise<void> {
  stopServerMovedWatcher();
  desktopBrowserBrokerClient?.stop();
  desktopBrowserBroker?.dispose();
  stopSystemConfigSync();
  connectSessionRenewal?.stop();
  desktopUpdateService?.stop();
  desktopAutoUpdateService?.stop();
  desktopBrowserViewManager?.destroyAll();
  desktopFindViewManager?.destroyAll();
  await desktopWindowFactory?.persistOpenWindows();
  await stopOwnedRuntime();
}

function registerDesktopUpdateIpc(): void {
  registerServerChoiceIpc({
    applicationWindowWebContentsIds,
    onListRequested: () => connectServerSync?.onListRequested(),
    list: listServerChoices,
    select: setActiveServerTarget,
    onError: (error) =>
      desktopLogger.error(`Could not switch server: ${String(error)}`),
  });
  registerDesktopWindowFocusIpc(applicationWindowWebContentsIds);
  registerDesktopClipboardIpc(applicationWindowWebContentsIds);
  registerDesktopNativeFilesIpc({
    applicationWindowWebContentsIds,
    getApplicationNavigation(webContentsId) {
      const navigationGeneration =
        applicationWindowNavigationGenerations.get(webContentsId);

      if (
        !omnyoAppLoaded ||
        currentWindowUrl === null ||
        navigationGeneration === undefined
      )
        return null;

      return {
        url: currentWindowUrl,
        serverGeneration: serverTargetGeneration,
        navigationGeneration,
      };
    },
  });
  ipcMain.on(OMNYO_DESKTOP_ZOOM_COMMAND_CHANNEL, (event, payload: unknown) => {
    const parsed = omnyoDesktopZoomCommandSchema.safeParse(payload);

    if (parsed.success) {
      zoomWebContents(
        resolveApplicationWindow(event.sender)?.webContents,
        parsed.data,
      );
    }
  });
  ipcMain.handle(OMNYO_DESKTOP_GET_INFO_CHANNEL, () => {
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(OMNYO_DESKTOP_GET_WINDOW_STATE_CHANNEL, (event) => {
    return getSenderDesktopWindowState(event);
  });
  ipcMain.handle(OMNYO_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL, async () => {
    await openServerDaemonLogs();
  });
  ipcMain.handle(OMNYO_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL, async () => {
    await openDataDirectory();
  });
  ipcMain.handle(OMNYO_DESKTOP_CHECK_FOR_UPDATES_CHANNEL, async () => {
    await Promise.all([
      desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null),
      desktopAutoUpdateService?.checkForUpdates() ?? Promise.resolve(null),
    ]);

    return getCurrentDesktopInfo();
  });
  ipcMain.handle(OMNYO_DESKTOP_INSTALL_UPDATE_CHANNEL, async (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Private update installation is unavailable");

    if (privateUpdateInstaller === null)
      throw new Error("Private update installation is unavailable");

    try {
      await privateUpdateInstaller.install();
    } catch {
      desktopLogger.error(
        "Private update installation was deferred or failed; the handoff receipt is retained.",
      );
      throw new Error("Private update installation was deferred or failed");
    }
  });
  ipcMain.on(
    OMNYO_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
    (event, enabled: unknown, directionalCommands: unknown) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame ||
        typeof enabled !== "boolean"
      ) {
        return;
      }

      const parsed = appCommandIdSchema
        .array()
        .safeParse(directionalCommands ?? []);

      if (!parsed.success) return;

      if (enabled) {
        splitNavigationEnabledWebContentsIds.add(event.sender.id);

        if (directionalCommands !== undefined) {
          splitNavigationCommandsByWebContentsId.set(
            event.sender.id,
            parsed.data,
          );
        }
      } else {
        splitNavigationEnabledWebContentsIds.delete(event.sender.id);
        splitNavigationCommandsByWebContentsId.delete(event.sender.id);
      }
    },
  );
  ipcMain.on(OMNYO_DESKTOP_SET_THEME_CHANNEL, (_event, payload: unknown) => {
    const parsed = omnyoDesktopThemeSchema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    nativeTheme.themeSource = parsed.data;
  });
  ipcMain.on(STARTUP_ACTION_CHANNEL, (event, ...payload: unknown[]) => {
    const action = startupActionIdSchema.safeParse(payload[0]);
    const page = startupErrorPage;

    if (
      payload.length !== 1 ||
      !action.success ||
      page === null ||
      !page.actions.includes(action.data) ||
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== page.url
    ) {
      return;
    }

    void runStartupAction(action.data, resolveApplicationWindow(event.sender));
  });

  ipcMain.on(OMNYO_DESKTOP_OPEN_THREAD_RESPONSE_CHANNEL, (_event, payload) => {
    const parsed = openThreadResponseSchema.safeParse(payload);

    if (parsed.success) {
      pendingOpenThreadRequests.get(parsed.data.requestId)?.(
        parsed.data.handled,
      );
    }
  });
  ipcMain.on(OMNYO_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, (event, payload) => {
    const pending = pendingCloseWindowRequests.get(event.sender.id);

    if (pending !== undefined) {
      clearTimeout(pending);
      pendingCloseWindowRequests.delete(event.sender.id);
    }

    if (payload === false) {
      resolveApplicationWindow(event.sender)?.close();
    }
  });
  ipcMain.on(
    OMNYO_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
    (_event, payload: unknown) => {
      const url = resolveDesktopExternalUrl(payload);

      if (url !== null) {
        void shell.openExternal(url);
      }
    },
  );
}

interface DesktopBrowserWindowLifecycleArgs {
  browserWindow: BrowserWindow;
  manager: DesktopBrowserViewManager;
}

const WINDOW_RESIZE_SETTLE_MS = 200;

function registerDesktopBrowserWindowLifecycle({
  browserWindow,
  manager,
}: DesktopBrowserWindowLifecycleArgs): void {
  const hostWebContentsId = browserWindow.webContents.id;
  let resizeSettleTimer: NodeJS.Timeout | null = null;

  const endWindowResize = () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }

    if (!browserWindow.isDestroyed()) {
      manager.endWindowResize(browserWindow);
    }
  };

  browserWindow.on("resize", () => {
    manager.beginWindowResize(browserWindow);

    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
    }

    resizeSettleTimer = setTimeout(endWindowResize, WINDOW_RESIZE_SETTLE_MS);
  });
  browserWindow.on("resized", endWindowResize);
  browserWindow.once("closed", () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }

    manager.releaseWindow(hostWebContentsId);
  });
}

async function spawnOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<OwnedRuntime> {
  await shellPathReady;

  if (quitting) throw new Error("Desktop app is quitting");

  const omnyoProcess = startOmnyoAppProcess({
    bridgePath: args.bridgePath,
    cwd: homedir(),
    env: {
      ...process.env,
      [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP,
    },
    logLineLimit: PROCESS_LOG_LINE_LIMIT,
    runtime: resolveOmnyoAppProcessRuntime({
      env: process.env,
      isPackaged: app.isPackaged,
      platform: process.platform,
      processExecPath: process.execPath,
    }),
  });

  const runtime: DesktopRuntime = {
    appProcess: omnyoProcess,
    ownership: "spawned",
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  };

  await writeOwnedRuntimePidFile({
    bridgePath: args.bridgePath,
    pid: omnyoProcess.pid,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  setCurrentRuntime(runtime);

  void omnyoProcess.exit.then((exit) => {
    void clearOwnedRuntimePidFile({ userDataPath: args.userDataPath });

    if (quitting || currentRuntime !== runtime) {
      return;
    }

    setCurrentRuntime(null);

    if (localServerMove !== null) {
      desktopLogger.warn(
        `[desktop] the Electron-owned omnyo-app process that runs this computer as a machine stopped with ${formatExitResult(exit)}`,
      );

      return;
    }

    void loadStartupError({
      details: `The Electron-owned omnyo-app process stopped with ${formatExitResult(
        exit,
      )}.`,
      logs: omnyoProcess.logs.text(),
      actions: [],
      title: "Omnyo stopped",
    });
  });

  return { appProcess: omnyoProcess, runtime };
}

async function startOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<DesktopRuntime | null> {
  const { appProcess: omnyoProcess, runtime } = await spawnOwnedRuntime(args);

  const raceResult = await Promise.race<StartupRaceResult>([
    waitForCompatibleServer({
      expectedAppVersion: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
      intervalMs: STARTUP_POLL_INTERVAL_MS,
      serverUrl: args.serverUrl,
      timeoutMs: STARTUP_TIMEOUT_MS,
    }).then((result) => ({
      kind: "server-probe",
      result,
    })),
    omnyoProcess.exit.then((exit) => ({
      exit,
      kind: "process-exited",
    })),
  ]);

  if (raceResult.kind === "process-exited") {
    await loadStartupError({
      details: `omnyo-app exited before the server was ready with ${formatExitResult(
        raceResult.exit,
      )}.`,
      logs: omnyoProcess.logs.text(),
      actions: [],
      title: "Could not start Omnyo",
    });
    setCurrentRuntime(null);

    return null;
  }

  if (raceResult.result.kind === "compatible") {
    return runtime;
  }

  await loadStartupError({
    details:
      raceResult.result.kind === "incompatible"
        ? `Port ${args.serverUrl} is responding, but it does not look like Omnyo: ${raceResult.result.reason}.`
        : `Timed out waiting for Omnyo at ${args.serverUrl}: ${raceResult.result.reason}.`,
    logs: omnyoProcess.logs.text(),
    actions: [],
    title: "Could not start Omnyo",
  });
  await stopOwnedRuntime();

  return null;
}

interface InitializeRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

function shouldAskBeforeAttaching(): boolean {
  if (!app.isPackaged || existingServerDialogPreloadPath === null) {
    return false;
  }

  if (process.env.OMNYO_DESKTOP_ATTACH_WITHOUT_PROMPT === "1") {
    return false;
  }

  return (process.env.OMNYO_DESKTOP_APP_URL ?? "").trim().length === 0;
}

async function waitForServerToStop(serverUrl: string): Promise<boolean> {
  const deadline = Date.now() + FOREIGN_RUNTIME_STOP_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const probe = await probeOmnyoServer({
      serverUrl,
      timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
    });

    if (probe.kind === "unavailable") {
      return true;
    }

    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, STARTUP_POLL_INTERVAL_MS);
    });
  }

  return false;
}

type ExistingServerDecision = "attach" | "quit" | "start-fresh";

async function decideOnExistingServer(
  probe: CompatibleServerProbeResult,
): Promise<ExistingServerDecision> {
  if (!shouldAskBeforeAttaching()) {
    return "attach";
  }

  const preloadPath = existingServerDialogPreloadPath;

  if (preloadPath === null) {
    return "attach";
  }

  const details = await readForeignRuntimeDetails({
    dataDir: probe.dataDir,
    serverUrl: probe.serverUrl,
  });

  const choice = await openExistingServerDialog({
    details,
    parentWindow: getFocusedApplicationWindow(),
    preloadPath,
    serverUrl: probe.serverUrl,
  });

  if (choice === "quit") {
    return "quit";
  }

  if (choice === "connect" || details === null) {
    return "attach";
  }

  const stopResult = await stopForeignRuntime({
    details,
    killTimeoutMs: FOREIGN_RUNTIME_KILL_TIMEOUT_MS,
    timeoutMs: FOREIGN_RUNTIME_STOP_TIMEOUT_MS,
  });

  if (stopResult.kind === "unverified") {
    await loadStartupError({
      details:
        `The Omnyo at ${probe.serverUrl} records process ${String(stopResult.pid)}, but that ` +
        "process no longer matches the record. Omnyo did not stop it. Stop it yourself, then open Omnyo again.",
      logs: "",
      actions: [],
      title: "Could not stop the running Omnyo",
    });

    return "quit";
  }

  if (stopResult.kind === "still-running") {
    await loadStartupError({
      details: `Omnyo could not stop process ${String(stopResult.pid)}, even after SIGKILL.`,
      logs: "",
      actions: [],
      title: "Could not stop the running Omnyo",
    });

    return "quit";
  }

  if (stopResult.kind === "replaced") {
    await loadStartupError({
      details:
        `Another Omnyo started at ${probe.serverUrl} while the question was open, so Omnyo stopped nothing. ` +
        "Open Omnyo again to see the copy that runs now.",
      logs: "",
      actions: [],
      title: "Could not stop the running Omnyo",
    });

    return "quit";
  }

  if (!(await waitForServerToStop(probe.serverUrl))) {
    await loadStartupError({
      details: `The Omnyo at ${probe.serverUrl} stopped, but the address is still in use.`,
      logs: "",
      actions: [],
      title: "Could not stop the running Omnyo",
    });

    return "quit";
  }

  return "start-fresh";
}

async function initializeRuntime(args: InitializeRuntimeArgs): Promise<void> {
  const existingProbe = await probeOmnyoServer({
    expectedAppVersion: getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION),
    serverUrl: args.serverUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (
    DESKTOP_RELEASE_CHANNEL === "public-beta" &&
    existingProbe.kind !== "unavailable"
  ) {
    await loadStartupError(PUBLIC_LOCAL_ADDRESS_BUSY_ERROR);

    return;
  }

  if (existingProbe.kind === "compatible") {
    const decision = await decideOnExistingServer(existingProbe);

    if (decision === "quit") {
      app.quit();

      return;
    }

    if (decision === "start-fresh") {
      await loadLoadingView();

      const freshRuntime = await startOwnedRuntime({
        bridgePath: args.bridgePath,
        serverUrl: args.serverUrl,
        userDataPath: args.userDataPath,
      });

      if (freshRuntime !== null) {
        await loadOmnyoApp(freshRuntime.serverUrl);
        startSystemConfigSync(freshRuntime.serverUrl);
        refreshApplicationMenu();
      }

      return;
    }

    setCurrentRuntime({
      appProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    await loadOmnyoApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: existingProbe.serverUrl,
      }),
    );
    startSystemConfigSync(existingProbe.serverUrl);
    refreshApplicationMenu();

    return;
  }

  if (existingProbe.kind === "incompatible") {
    await loadStartupError({
      details: `Port ${args.serverUrl} is already in use, but it is not a compatible Omnyo server: ${existingProbe.reason}.`,
      logs: "",
      actions: [],
      title: "Port conflict",
    });

    return;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: args.bridgePath,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });

  if (runtime !== null) {
    await loadOmnyoApp(runtime.serverUrl);
    startSystemConfigSync(runtime.serverUrl);
    refreshApplicationMenu();
  }
}

async function runDesktopApp(): Promise<void> {
  const applicationName = app.isPackaged
    ? DESKTOP_RELEASE_INFO.profileName
    : "omnyo-dev";

  const displayName = app.isPackaged
    ? DESKTOP_RELEASE_INFO.applicationName
    : applicationName;

  let profilePath: string;
  let profileStorageName: string;

  try {
    if (app.isReady())
      throw new Error(
        "Desktop profile admission must precede Electron readiness",
      );
    profilePath = prepareDesktopProfilePathV1({
      appDataPath: app.getPath("appData"),
      applicationName,
      explicitUserDataPath:
        app.commandLine.getSwitchValue("user-data-dir") || null,
    });

    if (DESKTOP_RELEASE_CHANNEL === "public-beta")
      Object.assign(process.env, createPublicBetaEnvironment(profilePath));
    app.setPath("userData", profilePath);
    profileStorageName =
      applicationName === "Omnyo"
        ? applicationName
        : desktopProfileStorageNameV1(profilePath, applicationName);
    app.setName(profileStorageName);
  } catch (error) {
    process.stderr.write(
      `Desktop profile startup refused: ${error instanceof Error ? error.message : "profile ownership is uncertain"}\n`,
    );
    app.exit(1);

    return;
  }

  installAboutPanel(displayName);

  shellPathReady = ensurePackagedUserShellPath({
    env: process.env,
    isPackaged: app.isPackaged,
    logger: desktopLogger,
    platform: process.platform,
  }).then(() => {});

  if (!app.requestSingleInstanceLock()) {
    app.quit();

    return;
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    acceptImportArgument(url);
  });
  app.on("open-file", (event, path) => {
    event.preventDefault();
    acceptImportArgument(path);
  });

  for (const argument of process.argv.slice(1)) acceptImportArgument(argument);
  ipcMain.handle(TAKE_WORKFLOW_IMPORT_CHANNEL, (event) => {
    if (
      !omnyoAppLoaded ||
      workflowImportServerUrl === null ||
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.sender.getURL() !==
        workflowImportDestination(workflowImportServerUrl)
    )
      return null;

    return workflowImports.take();
  });
  app.on("second-instance", (_event, argv) => {
    for (const argument of argv.slice(1)) acceptImportArgument(argument);

    if (desktopWindowFactory?.focusFirstWindow() === true) {
      return;
    }

    void createApplicationWindow({
      initialUrl: currentWindowUrl,
      stateKey: null,
    });
  });
  app.on("before-quit", handleBeforeQuit);
  ipcMain.handle(
    DESKTOP_NOTIFICATION_DELIVER_CHANNEL,
    async (event, id: unknown) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame
      )
        return false;
      const parsed = z.string().min(1).max(200).safeParse(id);

      if (!parsed.success) return false;

      return desktopNotifications?.deliver(parsed.data) ?? false;
    },
  );
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (desktopWindowFactory?.hasOpenWindows() === false) {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    }
  });
  app.on("did-become-active", () => {
    desktopNotifications?.refresh();
    void desktopUpdateService?.checkAfterActive();
    void desktopAutoUpdateService?.checkAfterActive();
    refreshRemoteSystemConfig?.();
    connectSessionRenewal?.renewIfDue();
  });
  app.on("browser-window-created", (_event, browserWindow) => {
    if (desktopBrowserViewManager === null) {
      return;
    }

    registerDesktopBrowserWindowLifecycle({
      browserWindow,
      manager: desktopBrowserViewManager,
    });
  });
  registerDesktopShutdownSignalHandlers({
    exitProcess(code) {
      process.exitCode = code;
    },
    processEvents: process,
    quitApplication() {
      app.quit();
    },
    async stopOwnedRuntime() {
      quitting = true;
      await stopOwnedRuntime();
    },
  });

  await app.whenReady();
  watchDesktopPresence();
  await initializeDesktopProfileStorageV1({
    storageName: profileStorageName,
    applicationName: displayName,
    encryption: safeStorage,
    async initializeCookies() {
      await session.fromPartition("persist:omnyo-browser").cookies.get({});
    },
    setDisplayName(value) {
      app.setName(value);
    },
  });

  const paths = createDesktopPathContext();

  const iconPath = resolveDesktopIconPath({
    packagedIconFileName: DESKTOP_RELEASE_INFO.iconFileName,
    paths,
  });

  const bridgePath = resolveDesktopBridgePath({ paths });

  const resolvedLogViewerPreloadPath = join(
    paths.appPath,
    "dist",
    "log-viewer-preload.cjs",
  );

  const preloadPath = join(paths.appPath, "dist", "preload.cjs");

  const browserPagePreloadPath = join(
    paths.appPath,
    "dist",
    "browser-page-preload.cjs",
  );

  const findBarPreloadPath = join(
    paths.appPath,
    "dist",
    "find-bar-preload.cjs",
  );

  const resolvedExistingServerDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "existing-server-dialog-preload.cjs",
  );

  const resolvedServerUrlDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "server-url-dialog-preload.cjs",
  );

  const serverUrl = resolveDesktopServerUrl({ env: process.env });
  builtinServerUrl = serverUrl;
  desktopBridgePath = bridgePath;
  const desktopVersion = getDesktopVersion(process.env.OMNYO_DESKTOP_VERSION);
  const desktopPlatform = resolveDesktopPlatform(process.platform);
  const userDataPath = app.getPath("userData");
  desktopUserDataPath = userDataPath;

  assertPathExists({ label: "omnyo-app bridge", path: bridgePath });
  assertPathExists({
    label: "existing server dialog preload script",
    path: resolvedExistingServerDialogPreloadPath,
  });
  assertPathExists({
    label: "log viewer preload script",
    path: resolvedLogViewerPreloadPath,
  });
  assertPathExists({ label: "preload script", path: preloadPath });
  assertPathExists({
    label: "browser page preload script",
    path: browserPagePreloadPath,
  });
  assertPathExists({
    label: "find bar preload script",
    path: findBarPreloadPath,
  });
  assertPathExists({
    label: "server URL dialog preload script",
    path: resolvedServerUrlDialogPreloadPath,
  });
  assertPathExists({ label: "app icon", path: iconPath });

  if (
    process.platform === "darwin" &&
    app.dock !== undefined &&
    !paths.isPackaged
  ) {
    app.dock.setIcon(iconPath);
  }

  if (process.platform === "darwin" && app.dock !== undefined) {
    const dock = app.dock;
    registerDesktopAttentionIpc({
      applicationWindowWebContentsIds,
      onChange: (active) => dock.setBadge(active ? "•" : ""),
    });
  }

  await reapStaleOwnedRuntime({
    signal: "SIGTERM",
    timeoutMs: 5_000,
    userDataPath,
  });

  serverTargetStore = createServerTargetStore({
    storagePath: join(userDataPath, SERVER_TARGET_FILE_NAME),
    defaultCustomServerUrl:
      DESKTOP_RELEASE_CHANNEL !== "public-beta"
        ? PRIVATE_GATEWAY_ORIGIN
        : undefined,
  });
  await serverTargetStore.load();

  const dataDir = resolveDataDirFromEnv({
    env: process.env,
    homeDir: homedir(),
  });

  builtinDataDir = dataDir;
  serverMoveNoticeStore = createServerMoveNoticeStore({
    storagePath: join(userDataPath, SERVER_MOVE_NOTICE_FILE_NAME),
  });
  machineServiceNoticeStore = createServerMoveNoticeStore({
    storagePath: join(userDataPath, MACHINE_SERVICE_NOTICE_FILE_NAME),
  });
  connectCredentialCache = createConnectCredentialCache({
    encryption: safeStorage,
    userDataPath,
  });
  cachedConnectCredential = await connectCredentialCache.read();
  connectServerSync = createConnectServerSync({
    getCredential: () => cachedConnectCredential,
    getLocalServerUrl: () =>
      localServerMove === null ? (currentRuntime?.serverUrl ?? null) : null,
    onUnauthorized() {
      void clearCachedConnectCredential();
    },
    onSkipped(reason) {
      connectServerSyncSkipReason = reason;
      refreshApplicationMenu();
    },
    onServers(servers) {
      connectAccountServers = servers;
      connectServerSyncSkipReason = null;
      const selected = serverTargetStore?.getConnectServer() ?? null;

      const synced = servers.find(
        (server) => server.handle === selected?.handle,
      );

      if (synced !== undefined) {
        void serverTargetStore?.refreshConnectServer({
          handle: synced.handle,
          name: synced.name,
          url: synced.url,
        });
      }

      refreshApplicationMenu();
    },
    log: (message) => {
      desktopLogger.info(`[desktop] ${message}`);
    },
  });
  connectServerSync.start();
  connectSessionRenewal = createConnectSessionRenewal({
    async authenticate(remoteServerUrl, isCurrent) {
      const target = serverTargetStore?.getTarget();

      if (target?.kind !== "connect" || target.server.url !== remoteServerUrl) {
        return { detail: "the app no longer targets this server", ok: false };
      }

      const result = await authenticateConnectTarget(
        remoteServerUrl,
        target.server.handle,
        isCurrent,
      );

      return result.ok
        ? result
        : { detail: `${result.code}: ${result.detail}`, ok: false };
    },
    log: (message) => {
      desktopLogger.warn(`[desktop] ${message}`);
    },
  });

  let privateFeed: DesktopAutoUpdateFeedConfig | null = null;

  const expectedAppId = createDesktopReleaseConfig(
    DESKTOP_RELEASE_CHANNEL,
    resolveDesktopBuildPlatform(process.platform),
  ).appId;

  let installedArtifact: Promise<PrivateUpdateArtifact> | null = null;

  const inspectInstalledArtifact = (): Promise<PrivateUpdateArtifact> => {
    if (installedArtifact !== null) return installedArtifact;
    installedArtifact = (async () => {
      try {
        const installed =
          desktopPlatform === "windows"
            ? await inspectInstalledPrivateWindowsUpdate(
                dirname(process.execPath),
              )
            : await inspectInstalledPrivateUpdate(
                resolve(process.execPath, "../../.."),
              );

        if (
          installed.appId !== expectedAppId ||
          installed.runtimeVersion !== desktopVersion ||
          installed.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
        )
          throw new Error(
            "Private installed update bootstrap identity is invalid",
          );

        return installed;
      } catch (error) {
        desktopLogger.error(
          "Private updates are disabled: configuration or signed bootstrap identity is invalid.",
        );
        throw error;
      }
    })();

    return installedArtifact;
  };

  const verifyInstalledArtifact = async (): Promise<void> => {
    await inspectInstalledArtifact();
  };

  if (
    DESKTOP_RELEASE_CHANNEL !== "public-beta" &&
    (desktopPlatform === "macos" || desktopPlatform === "windows")
  ) {
    try {
      privateFeed = await readPrivateUpdateConfig(
        userDataPath,
        desktopPlatform,
        DESKTOP_RELEASE_CHANNEL,
      );

      if (
        privateFeed !== null &&
        privateFeed.channel !== DESKTOP_RELEASE_CHANNEL
      )
        throw new Error();
    } catch {
      privateFeed = null;
      desktopLogger.error(
        "Private updates are disabled: configuration or signed bootstrap identity is invalid.",
      );
    }
  }

  if (DESKTOP_RELEASE_CHANNEL === "public-beta" && desktopPlatform === "macos")
    privateFeed = publicBetaUpdateFeed();

  const desktopUpdateSupport = resolveDesktopUpdateSupport({
    feedConfig: privateFeed,
    platform: desktopPlatform,
  });

  desktopAutoUpdateService = createDesktopAutoUpdateService({
    verifyInstalledArtifact,
    feedConfig: privateFeed,
    appId: expectedAppId,
    currentVersion: desktopVersion,
    enabled:
      desktopUpdateSupport.autoUpdate &&
      shouldEnableDesktopAutoUpdate({
        env: process.env,
        isPackaged: app.isPackaged,
      }),
    forceDevUpdateConfig:
      !app.isPackaged && process.env.OMNYO_DESKTOP_AUTO_UPDATE === "1",
    logger: desktopLogger,
    platform: desktopPlatform,
    updater: createElectronAutoUpdaterAdapter(autoUpdater),
  });

  if (desktopPlatform === "macos" || desktopPlatform === "windows") {
    let installCandidate: ReturnType<
      DesktopAutoUpdateService["getDownloadedCandidate"]
    > | null = null;

    const assertInstallCandidate = () => {
      if (
        installCandidate === null ||
        desktopAutoUpdateService?.getDownloadedCandidate() !== installCandidate
      )
        throw new Error("Private update candidate changed before installation");
    };

    privateUpdateInstaller = createPrivateDesktopUpdateInstaller({
      verifyInstalledArtifact,
      journalPath: join(userDataPath, "private-update-handoff.json"),
      currentVersion: () => desktopVersion,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      runtime(): PrivateDesktopUpdateRuntime {
        if (currentRuntime === null)
          return serverTargetStore?.getTarget().kind !== "builtin"
            ? { kind: "remote-only" }
            : { kind: "unknown" };

        if (currentRuntime.ownership !== "spawned") return { kind: "attached" };

        if (currentRuntime.appProcess === null || builtinDataDir === null)
          return { kind: "unknown" };

        return {
          kind: "owned",
          child: currentRuntime.appProcess.childProcess,
          dataDir: builtinDataDir,
          serverUrl: currentRuntime.serverUrl,
        };
      },
      async inspectArtifact() {
        if (desktopAutoUpdateService === null)
          throw new Error("Private update is unavailable");

        installCandidate = desktopAutoUpdateService.getDownloadedCandidate();

        const inspect =
          desktopPlatform === "windows"
            ? inspectDownloadedPrivateWindowsUpdate
            : inspectDownloadedPrivateUpdate;

        const artifact = await inspect({
          ...installCandidate,
          currentVersion: desktopVersion,
          expectedAppId,
          expectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        });

        assertInstallCandidate();

        return artifact;
      },
      inspectInstalledArtifact,
      stageNativeUpdate: () =>
        new Promise<void>((resolveStage, rejectStage) => {
          assertInstallCandidate();

          if (desktopPlatform === "windows") {
            resolveStage();

            return;
          }

          const cleanup = () => {
            clearTimeout(timeout);
            nativeAutoUpdater.removeListener("update-downloaded", ready);
            nativeAutoUpdater.removeListener("error", failed);
          };

          const ready = () => {
            cleanup();
            resolveStage();
          };

          const failed = () => {
            cleanup();
            rejectStage(new Error("Private native update acceptance failed"));
          };

          const timeout = setTimeout(failed, 60000);
          nativeAutoUpdater.once("update-downloaded", ready);
          nativeAutoUpdater.once("error", failed);

          try {
            nativeAutoUpdater.checkForUpdates();
          } catch {
            failed();
          }
        }),
      async finishQuit() {
        assertInstallCandidate();
        quitting = true;
        stoppingForQuit = true;
        await finishQuit();
      },
      quitAndInstall: () => autoUpdater.quitAndInstall(),
    });
  }

  let automaticInstallTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleAutomaticInstall = () => {
    if (
      automaticInstallTimer !== null ||
      privateUpdateInstaller === null ||
      !desktopAutoUpdateService?.getInfo().updateDownloaded
    )
      return;
    automaticInstallTimer = setTimeout(() => {
      automaticInstallTimer = null;

      if (
        BrowserWindow.getFocusedWindow() !== null ||
        quitting ||
        !desktopAutoUpdateService?.getInfo().updateDownloaded
      )
        return;
      void privateUpdateInstaller?.install().catch(() => {
        desktopLogger.warn(
          "Private automatic update is waiting for idle runtime ownership.",
        );
        scheduleAutomaticInstall();
      });
    }, 60000);
    automaticInstallTimer.unref();
  };

  app.on("browser-window-blur", scheduleAutomaticInstall);
  app.on("browser-window-focus", () => {
    if (automaticInstallTimer !== null) clearTimeout(automaticInstallTimer);
    automaticInstallTimer = null;
  });
  app.once("before-quit", () => {
    if (automaticInstallTimer !== null) clearTimeout(automaticInstallTimer);
    automaticInstallTimer = null;
  });
  desktopAutoUpdateService.subscribe(() => {
    sendDesktopInfoChanged();
    scheduleAutomaticInstall();
  });
  registerDesktopUpdateIpc();
  desktopFindViewManager = createDesktopFindViewManager({
    preloadPath: findBarPreloadPath,
  });
  ipcMain.on(
    OMNYO_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
    (event, payload: unknown) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        return;
      }

      const parsed = omnyoDesktopWindowFindRequestSchema.safeParse(payload);
      const browserWindow = resolveApplicationWindow(event.sender);

      if (!parsed.success || browserWindow === null) {
        return;
      }

      desktopFindViewManager?.open(browserWindow, parsed.data);
    },
  );
  ipcMain.on(OMNYO_DESKTOP_RELOAD_WINDOW_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return;
    }

    const browserWindow = resolveApplicationWindow(event.sender);

    if (browserWindow !== null) {
      reloadApplicationWindow(browserWindow, false);
    }
  });
  desktopBrowserViewManager = createDesktopBrowserViewManager({
    pagePreloadPath: browserPagePreloadPath,
    dispatchAppCommand({ command, hostWebContentsId }) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );

      if (browserWindow === undefined) {
        return;
      }

      sendToApplicationRenderer(
        browserWindow,
        OMNYO_DESKTOP_APP_COMMAND_CHANNEL,
        command,
      );
    },
    focusHostWebContents(hostWebContentsId) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );

      if (browserWindow !== undefined) {
        browserWindow.webContents.focus();
      }
    },
    resolveAppCommand(input, hostWebContentsId) {
      return resolveDesktopBrowserAppCommand({
        input,
        platform: process.platform,
        keybindings: currentAppKeybindings,
        splitNavigationEnabled:
          splitNavigationEnabledWebContentsIds.has(hostWebContentsId),
        splitNavigationCommands:
          splitNavigationCommandsByWebContentsId.get(hostWebContentsId),
      });
    },
  });
  registerDesktopBrowserIpc(desktopBrowserViewManager);

  const browserImportService = createBrowserImportService({
    shellPathReady,
    context: {
      platform: process.platform,
      home: homedir(),
      configHome: process.env.XDG_CONFIG_HOME,
      excludedDirectories: [app.getPath("userData")],
    },
    resolveIcon: (appPath) => readMacAppIcon(appPath),
    ...(process.platform === "darwin"
      ? {
          resolveDefaultBrowserApp: async () =>
            (await app.getApplicationInfoForProtocol("https://")).path,
        }
      : {}),
    log(message, details) {
      desktopLogger.info(
        `[desktop] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`,
      );
    },
  });

  desktopBrowserBroker = createDesktopBrowserBroker({
    manager: desktopBrowserViewManager,
    product: `Chrome/${process.versions.chrome}`,
    browserImport: browserImportService,
    profileRenderer: ({ webContentsId, durationMs }) => {
      const webContents = electronWebContents.fromId(webContentsId);

      if (
        webContents === undefined ||
        webContents === null ||
        webContents.isDestroyed()
      )
        throw new Error("Desktop renderer is unavailable");

      return profileDesktopRenderer({ webContents, durationMs });
    },
  });
  ipcMain.handle(
    OMNYO_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    async (event) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) return null;

      return browserImportService.listImportSources();
    },
  );
  ipcMain.handle(
    OMNYO_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
    async (event, payload: unknown) => {
      const parsed =
        omnyoDesktopBrowserImportCookiesRequestSchema.safeParse(payload);

      if (
        !parsed.success ||
        !applicationWindowWebContentsIds.has(event.sender.id)
      )
        return null;
      const manager = desktopBrowserViewManager;

      if (!manager) return null;

      return browserImportService.importCookies(
        {
          sourceId: parsed.data.sourceId,
          sourceProfileDirectory: parsed.data.sourceProfileDirectory,
        },
        manager.session(),
      );
    },
  );
  ipcMain.on(
    OMNYO_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    (event) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        process.platform !== "darwin"
      )
        return;
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    },
  );
  ipcMain.handle(OMNYO_DESKTOP_BROWSER_TARGET_CHANNEL, (event) => {
    return applicationWindowWebContentsIds.has(event.sender.id)
      ? (desktopBrowserBroker?.getTarget(event.sender.id) ?? null)
      : null;
  });
  ipcMain.handle(
    OMNYO_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = omnyoDesktopBrowserTabRefSchema.safeParse(payload);

      return parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
        ? (desktopBrowserBroker?.getControl(
            event.sender.id,
            parsed.data.tabId,
          ) ?? null)
        : null;
    },
  );
  ipcMain.on(
    OMNYO_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = omnyoDesktopBrowserTabRefSchema.safeParse(payload);

      if (
        parsed.success &&
        applicationWindowWebContentsIds.has(event.sender.id)
      )
        desktopBrowserBroker?.takeOver(event.sender.id, parsed.data.tabId);
    },
  );
  desktopBrowserBrokerClient = createDesktopBrowserBrokerClient({
    broker: desktopBrowserBroker,
    dataDir,
    homeDir: homedir(),
    getServerUrl() {
      const target = serverTargetStore?.getTarget();

      if (target?.kind === "connect") return target.server.url;

      if (target?.kind === "custom") return target.url;

      return currentRuntime?.serverUrl ?? builtinServerUrl;
    },
  });

  if (desktopUpdateSupport.versionCheck) {
    desktopUpdateService?.start();
  }

  if (desktopUpdateSupport.autoUpdate) {
    desktopAutoUpdateService.start();
  } else {
    desktopLogger.info(
      DESKTOP_RELEASE_CHANNEL === "public-beta"
        ? "Updates are unavailable in this build."
        : "Private updates are disabled until a valid feed and signed bootstrap are configured.",
    );
  }

  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      return new BrowserWindow(options);
    },
  };

  logViewerPreloadPath = resolvedLogViewerPreloadPath;
  serverUrlDialogPreloadPath = resolvedServerUrlDialogPreloadPath;
  existingServerDialogPreloadPath = resolvedExistingServerDialogPreloadPath;
  desktopWindowFactory = createDesktopWindowFactory({
    browserWindowCreator,
    onNavigation({ stateKey, url, webContentsId }) {
      if (applicationName === "Omnyo") return;
      void (async () => {
        const selected = desktopProfileOriginWindowV1Sync({
          profilePath,
          applicationName,
          stateKey,
        });

        if (selected !== null && !selected.admitted) {
          if (
            new URL(url).origin !== selected.ticket.toOrigin ||
            new URL(url).pathname === "/origin-adoption-v1.html"
          )
            return;
          const contents = electronWebContents.fromId(webContentsId);

          if (
            contents === undefined ||
            contents.isDestroyed() ||
            contents.getURL() !== url
          )
            throw new Error(
              "Native origin window changed before its admission receipt",
            );
          const receiptKey = `omnyo.origin-transfer.v1:native-window:${selected.ticket.id}`;

          const controllerReceipt: unknown = await contents.executeJavaScript(
            `JSON.parse(sessionStorage.getItem(${JSON.stringify(receiptKey)}))`,
          );

          const response = await contents.session.fetch(
            selected.ticket.toOrigin +
              "/api/v1/server/maintenance/origin-adoption-v1/check",
            {
              method: "POST",
              credentials: "include",
              headers: {
                "content-type": "application/json",
                origin: selected.ticket.toOrigin,
              },
              body: JSON.stringify({
                ticket: selected.ticket,
                action: "check",
                payloadSha256: null,
              }),
            },
          );

          if (!response.ok)
            throw new Error(
              "Native origin window server admission was refused",
            );
          const serverReceipt: unknown = await response.json();

          if (contents.isDestroyed() || contents.getURL() !== url)
            throw new Error(
              "Native origin window changed during server admission",
            );
          await acceptDesktopProfileOriginWindowV1({
            profilePath,
            applicationName,
            stateKey,
            controllerReceipt,
            serverReceipt,
          });
        }

        const mapping = desktopProfileAdmittedOriginMappingV1Sync({
          profilePath,
          applicationName,
        });

        if (mapping !== null && serverTargetStore !== null) {
          await serverTargetStore.adoptOriginV1(mapping);

          if (currentWindowUrl !== null) {
            const target = new URL(currentWindowUrl);

            if (target.origin === mapping.fromOrigin)
              currentWindowUrl =
                mapping.toOrigin +
                target.pathname +
                target.search +
                target.hash;
          }
        }
      })().catch(() =>
        desktopLogger.warn(
          "Saved native window admission remains pending; retry while the maintenance owner is held.",
        ),
      );
    },
    resolveInitialUrl({ stateKey, initialUrl }) {
      if (applicationName === "Omnyo") return initialUrl;

      return desktopProfileOriginWindowUrlV1Sync({
        profilePath: app.getPath("userData"),
        applicationName,
        stateKey,
        initialUrl,
      });
    },
    createWindowStateKey() {
      return `window-${randomUUID()}`;
    },
    shouldUseDarkColors() {
      return nativeTheme.shouldUseDarkColors;
    },
    displayWorkAreas: null,
    getServerTargetGeneration() {
      return serverTargetGeneration;
    },
    logWarning(message) {
      desktopLogger.warn(message);
    },
    icon: nativeImage.createFromPath(iconPath),
    isLinuxTransparent: hasLinuxWindowArgument({
      argument: LINUX_TRANSPARENT_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isMac: process.platform === "darwin",
    isLinuxFrameless: hasLinuxWindowArgument({
      argument: LINUX_FRAMELESS_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isQuitting() {
      return quitting;
    },
    openExternalUrl(openArgs) {
      void shell.openExternal(openArgs.url);
    },
    preloadPath,
    userDataPath,
  });
  installLogViewerIpcHandlers();

  refreshApplicationMenu();
  await loadLoadingView();

  const restoredWindows = await desktopWindowFactory.restoreSavedWindows({
    initialUrl: currentWindowUrl,
  });

  for (const browserWindow of restoredWindows) {
    registerApplicationWindow(browserWindow);
  }

  await activateLocalServerMoveIfLocked();

  if (
    serverTargetStore.getTarget().kind === "builtin" &&
    localServerMove === null
  ) {
    startServerMovedWatcher();
    await initializeRuntime({ bridgePath, serverUrl, userDataPath });
  } else {
    await applyServerTarget();
    connectServerSync.syncNow().catch(() => {});
  }

  await privateUpdateInstaller?.recover();
}

void runDesktopApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  process.stderr.write(`${message}\n`);
  void loadStartupError({
    details: message,
    logs: "",
    actions: [],
    title: "Could not open Omnyo",
  });
});
