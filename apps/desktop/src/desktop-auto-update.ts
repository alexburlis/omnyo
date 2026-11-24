import { assertPublicBetaUpdatePolicy } from "./public-beta-update.js";
import type {
  AppUpdater,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import type { OmnyoDesktopInfo } from "@omnyo/desktop-contract";
import { type DesktopAutoUpdateFeedConfig } from "./desktop-update-provider.js";
import {
  parsePrivateReleaseInfo,
  type PrivateReleaseInfo,
} from "./private-update-config.js";
import {
  createDesktopUpdateScheduler,
  type DesktopUpdateService,
} from "./desktop-update-scheduler.js";

export interface DesktopAutoUpdateLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export type DesktopAutoUpdateAvailableHandler = (info: UpdateInfo) => void;

export type DesktopAutoUpdateDownloadedHandler = (
  event: UpdateDownloadedEvent,
) => void;

export type DesktopAutoUpdateNotAvailableHandler = (info: UpdateInfo) => void;

export interface DesktopAutoUpdateErrorArgs {
  error: Error;
  message: string | null;
}

export type DesktopAutoUpdateErrorHandler = (
  args: DesktopAutoUpdateErrorArgs,
) => void;

export interface DesktopAutoUpdaterAdapter {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<Array<string>>;
  onError(handler: DesktopAutoUpdateErrorHandler): void;
  onUpdateAvailable(handler: DesktopAutoUpdateAvailableHandler): void;
  onUpdateDownloaded(handler: DesktopAutoUpdateDownloadedHandler): void;
  onUpdateNotAvailable(handler: DesktopAutoUpdateNotAvailableHandler): void;
  quitAndInstall(): void;
  setAutoDownload(enabled: boolean): void;
  setAutoInstallOnAppQuit(enabled: boolean): void;
  setFeedURL(config: DesktopAutoUpdateFeedConfig): void;
  setForceDevUpdateConfig(enabled: boolean): void;
  setLogger(logger: DesktopAutoUpdateLogger): void;
}

interface CreateDesktopAutoUpdateServiceArgs {
  verifyInstalledArtifact(): Promise<void>;
  currentVersion: string;
  enabled: boolean;
  feedConfig?: DesktopAutoUpdateFeedConfig | null;
  appId?: string;
  forceDevUpdateConfig: boolean;
  logger: DesktopAutoUpdateLogger;
  now?: () => number;
  platform: OmnyoDesktopInfo["platform"];
  updater: DesktopAutoUpdaterAdapter;
}

interface ShouldEnableDesktopAutoUpdateArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

export interface PrivateInstallLifecycle {
  acquireInstallHold(): Promise<void>;
  stageNativeUpdate(): Promise<void>;
  finishQuit(): Promise<void>;
}

export interface DesktopAutoUpdateService extends DesktopUpdateService {
  getDownloadedCandidate(): { file: string; release: PrivateReleaseInfo };
  installUpdate(lifecycle: PrivateInstallLifecycle): Promise<void>;
}

function createBaseInfo(
  currentVersion: string,
  platform: OmnyoDesktopInfo["platform"],
): OmnyoDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform,
    updateAvailable: false,
    updateDownloaded: false,
    version: currentVersion,
  };
}

export function shouldEnableDesktopAutoUpdate(
  args: ShouldEnableDesktopAutoUpdateArgs,
): boolean {
  return args.isPackaged || args.env.OMNYO_DESKTOP_AUTO_UPDATE === "1";
}

export function createElectronAutoUpdaterAdapter(
  updater: AppUpdater,
): DesktopAutoUpdaterAdapter {
  return {
    checkForUpdates() {
      return updater.checkForUpdates();
    },
    downloadUpdate() {
      return updater.downloadUpdate();
    },
    onError(handler) {
      updater.on("error", (error, message) => {
        handler({ error, message: message ?? null });
      });
    },
    onUpdateAvailable(handler) {
      updater.on("update-available", handler);
    },
    onUpdateDownloaded(handler) {
      updater.on("update-downloaded", handler);
    },
    onUpdateNotAvailable(handler) {
      updater.on("update-not-available", handler);
    },
    quitAndInstall() {
      updater.quitAndInstall();
    },
    setAutoDownload(enabled) {
      updater.autoDownload = enabled;
    },
    setAutoInstallOnAppQuit(enabled) {
      updater.autoInstallOnAppQuit = enabled;
    },
    setFeedURL(config) {
      if (config.channel === "public-beta")
        updater.disableDifferentialDownload = true;
      updater.setFeedURL(config);
    },
    setForceDevUpdateConfig(enabled) {
      updater.forceDevUpdateConfig = enabled;
    },
    setLogger(logger) {
      updater.logger = logger;
    },
  };
}

export function createDesktopAutoUpdateService(
  args: CreateDesktopAutoUpdateServiceArgs,
): DesktopAutoUpdateService {
  const now = args.now ?? (() => Date.now());
  const feed = args.feedConfig ?? null;

  if (feed !== null)
    assertPublicBetaUpdatePolicy(feed, args.appId, args.platform);

  const enabled =
    args.enabled &&
    feed !== null &&
    (args.platform === "macos" || args.platform === "windows");

  let selected: PrivateReleaseInfo | null = null;
  let downloaded: { file: string; release: PrivateReleaseInfo } | null = null;
  let generation = 0;
  let installing: Promise<void> | null = null;

  const scheduler = createDesktopUpdateScheduler({
    enabled,
    initialInfo: createBaseInfo(args.currentVersion, args.platform),
    now,
    runCheck,
    shouldSkipCheck: () => downloaded !== null || installing !== null,
  });

  function fail(message: string): void {
    generation += 1;
    selected = null;
    downloaded = null;
    scheduler.updateInfo({
      ...scheduler.getInfo(),
      downloadState: "failed",
      pendingVersion: null,
      updateDownloaded: false,
      updateAvailable: false,
    });
    args.logger.error(message);
  }

  async function runCheck(checkedAt: string): Promise<void> {
    const checkGeneration = ++generation;
    selected = null;
    downloaded = null;

    try {
      await args.verifyInstalledArtifact();

      if (feed !== null)
        assertPublicBetaUpdatePolicy(feed, args.appId, args.platform);
      const result = await args.updater.checkForUpdates();

      if (generation !== checkGeneration || result === null || feed === null)
        return;

      const candidate = parsePrivateReleaseInfo(
        result.updateInfo,
        feed.url,
        args.currentVersion,
        args.appId,
        args.platform,
      );

      if (!result.isUpdateAvailable || candidate === null) {
        scheduler.updateInfo({
          ...scheduler.getInfo(),
          lastCheckedAt: checkedAt,
          latestVersion: args.currentVersion,
          downloadState: "idle",
          pendingVersion: null,
          updateAvailable: false,
          updateDownloaded: false,
        });

        return;
      }

      selected = candidate;
      scheduler.updateInfo({
        ...scheduler.getInfo(),
        lastCheckedAt: checkedAt,
        latestVersion: candidate.version,
        downloadState: "downloading",
        updateAvailable: true,
      });
      assertPublicBetaUpdatePolicy(feed, args.appId, args.platform);
      await args.updater.downloadUpdate();
    } catch {
      if (generation === checkGeneration)
        fail(
          "Private update check or download failed; installation is unavailable.",
        );
    }
  }

  args.updater.setAutoInstallOnAppQuit(false);

  if (enabled && feed !== null) {
    args.updater.setLogger({
      error: () => args.logger.error("Private updater reported an error."),
      info: () => {},
      warn: () => args.logger.warn("Private updater reported a warning."),
    });
    args.updater.setFeedURL(feed);
    args.updater.setAutoDownload(false);
    args.updater.setForceDevUpdateConfig(args.forceDevUpdateConfig);
    args.updater.onUpdateDownloaded((event) => {
      if (selected === null || feed === null || installing !== null) return;

      try {
        assertPublicBetaUpdatePolicy(feed, args.appId, args.platform);

        const candidate = parsePrivateReleaseInfo(
          event,
          feed.url,
          args.currentVersion,
          args.appId,
          args.platform,
        );

        if (
          candidate === null ||
          candidate.version !== selected.version ||
          JSON.stringify(candidate.files) !== JSON.stringify(selected.files) ||
          JSON.stringify(candidate.omnyoPrivate) !==
            JSON.stringify(selected.omnyoPrivate) ||
          !event.downloadedFile
        )
          return;
        downloaded = { file: event.downloadedFile, release: candidate };
        scheduler.updateInfo({
          ...scheduler.getInfo(),
          downloadState: "downloaded",
          pendingVersion: candidate.version,
          updateDownloaded: true,
        });
      } catch {
        fail(
          "Private downloaded candidate is invalid; installation is unavailable.",
        );
      }
    });
    args.updater.onError(() =>
      fail("Private updater failed; installation is unavailable."),
    );
  }

  function getDownloadedCandidate() {
    if (downloaded === null)
      throw new Error("No verified private update is downloaded");

    return downloaded;
  }

  return {
    ...scheduler,
    getDownloadedCandidate,
    installUpdate(lifecycle) {
      if (installing !== null) return installing;

      const operation = (async () => {
        await args.verifyInstalledArtifact();
        const candidate = getDownloadedCandidate();
        await lifecycle.acquireInstallHold();
        await lifecycle.stageNativeUpdate();

        if (downloaded !== candidate)
          throw new Error("Private update candidate was invalidated");
        await lifecycle.finishQuit();
        args.updater.quitAndInstall();
      })();

      installing = operation;
      void operation
        .finally(() => {
          if (installing === operation) installing = null;
        })
        .catch(() => {});

      return operation;
    },
  };
}
