import { publicBetaUpdateFeed } from "../src/public-beta-update.js";
import { describe, expect, it, vi } from "vitest";
import type {
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import {
  createDesktopAutoUpdateService,
  shouldEnableDesktopAutoUpdate,
  type DesktopAutoUpdateAvailableHandler,
  type DesktopAutoUpdateDownloadedHandler,
  type DesktopAutoUpdateErrorArgs,
  type DesktopAutoUpdateErrorHandler,
  type DesktopAutoUpdateLogger,
  type DesktopAutoUpdateNotAvailableHandler,
  type DesktopAutoUpdaterAdapter,
} from "../src/desktop-auto-update.js";
import { type DesktopAutoUpdateFeedConfig } from "../src/desktop-update-provider.js";

const checkedAt = "2026-05-21T00:00:00.000Z";

interface LoggerMessages {
  errors: string[];
  infos: string[];
  warnings: string[];
}

class DesktopAutoUpdaterAdapterStub implements DesktopAutoUpdaterAdapter {
  autoDownload: boolean | null = null;
  autoInstallOnAppQuit: boolean | null = null;
  checkForUpdatesCalls = 0;
  downloadUpdateResult: Promise<Array<string>> = Promise.resolve([
    "/tmp/omnyo.zip",
  ]);
  downloadUpdateCalls = 0;
  feedConfigs: DesktopAutoUpdateFeedConfig[] = [];
  forceDevUpdateConfig: boolean | null = null;
  logger: DesktopAutoUpdateLogger | null = null;
  quitAndInstallCalls = 0;
  updateCheckResult: UpdateCheckResult | null = null;
  updateCheckError: Error | null = null;

  private readonly errorHandlers = new Set<DesktopAutoUpdateErrorHandler>();
  private readonly updateAvailableHandlers =
    new Set<DesktopAutoUpdateAvailableHandler>();
  private readonly updateDownloadedHandlers =
    new Set<DesktopAutoUpdateDownloadedHandler>();
  private readonly updateNotAvailableHandlers =
    new Set<DesktopAutoUpdateNotAvailableHandler>();

  checkForUpdates(): Promise<UpdateCheckResult | null> {
    this.checkForUpdatesCalls += 1;

    if (this.updateCheckError !== null) {
      return Promise.reject(this.updateCheckError);
    }

    return Promise.resolve(this.updateCheckResult);
  }

  downloadUpdate(): Promise<Array<string>> {
    this.downloadUpdateCalls += 1;

    return this.downloadUpdateResult;
  }

  emitError(args: DesktopAutoUpdateErrorArgs): void {
    for (const handler of this.errorHandlers) {
      handler(args);
    }
  }

  emitUpdateAvailable(info: UpdateInfo): void {
    for (const handler of this.updateAvailableHandlers) {
      handler(info);
    }
  }

  emitUpdateDownloaded(event: UpdateDownloadedEvent): void {
    for (const handler of this.updateDownloadedHandlers) {
      handler(event);
    }
  }

  emitUpdateNotAvailable(info: UpdateInfo): void {
    for (const handler of this.updateNotAvailableHandlers) {
      handler(info);
    }
  }

  onError(handler: DesktopAutoUpdateErrorHandler): void {
    this.errorHandlers.add(handler);
  }

  onUpdateAvailable(handler: DesktopAutoUpdateAvailableHandler): void {
    this.updateAvailableHandlers.add(handler);
  }

  onUpdateDownloaded(handler: DesktopAutoUpdateDownloadedHandler): void {
    this.updateDownloadedHandlers.add(handler);
  }

  onUpdateNotAvailable(handler: DesktopAutoUpdateNotAvailableHandler): void {
    this.updateNotAvailableHandlers.add(handler);
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }

  setAutoDownload(enabled: boolean): void {
    this.autoDownload = enabled;
  }

  setAutoInstallOnAppQuit(enabled: boolean): void {
    this.autoInstallOnAppQuit = enabled;
  }

  setFeedURL(config: DesktopAutoUpdateFeedConfig): void {
    this.feedConfigs.push(config);
  }

  setForceDevUpdateConfig(enabled: boolean): void {
    this.forceDevUpdateConfig = enabled;
  }

  setLogger(logger: DesktopAutoUpdateLogger): void {
    this.logger = logger;
  }
}

function createUpdateInfo(version: string) {
  return {
    omnyoPrivate: {
      appId: "dev.omnyo.private",
      teamId: "Z7T4C33A35",
      runtimeVersion: version + "+private.2",
      protocolVersion: 234,
    },
    files: [
      {
        sha512: "A".repeat(86) + "==",
        size: 128,
        url: `omnyo-${version}-universal.zip`,
      },
    ],
    path: `omnyo-${version}-universal.zip`,
    releaseDate: checkedAt,
    sha512: "BASE64_SHA512",
    version,
  };
}

function createUpdateCheckResult(version: string): UpdateCheckResult {
  const updateInfo = createUpdateInfo(version);

  return {
    downloadPromise: null,
    isUpdateAvailable: true,
    updateInfo,
    versionInfo: updateInfo,
  };
}

function createDownloadedEvent(version: string): UpdateDownloadedEvent {
  return {
    ...createUpdateInfo(version),
    downloadedFile: "/tmp/omnyo.zip",
  };
}

function createLoggerMessages(): LoggerMessages {
  return {
    errors: [],
    infos: [],
    warnings: [],
  };
}

function createLogger(messages: LoggerMessages): DesktopAutoUpdateLogger {
  return {
    error(message) {
      messages.errors.push(message);
    },
    info(message) {
      messages.infos.push(message);
    },
    warn(message) {
      messages.warnings.push(message);
    },
  };
}

describe("desktop auto-update scheduler integration", () => {
  const feedConfig: DesktopAutoUpdateFeedConfig = {
    provider: "generic",
    channel: "latest",
    url: "https://fixture.invalid/releases/",
  };

  function service(
    updater: DesktopAutoUpdaterAdapterStub,
    messages = createLoggerMessages(),
    now = () => Date.parse(checkedAt),
  ) {
    return createDesktopAutoUpdateService({
      async verifyInstalledArtifact() {},
      currentVersion: "0.0.1",
      enabled: true,
      feedConfig,
      forceDevUpdateConfig: false,
      logger: createLogger(messages),
      now,
      platform: "macos",
      updater,
    });
  }

  it("discovers a newly published update at the next minute and stops scheduled checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const updater = new DesktopAutoUpdaterAdapterStub();
    const owner = service(updater, createLoggerMessages(), () => Date.now());

    try {
      owner.start();
      await owner.checkForUpdates();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(updater.checkForUpdatesCalls).toBe(1);
      expect(owner.getInfo().updateAvailable).toBe(false);

      updater.updateCheckResult = createUpdateCheckResult("0.0.2");
      await vi.advanceTimersByTimeAsync(1);
      expect(updater.checkForUpdatesCalls).toBe(2);
      expect(updater.downloadUpdateCalls).toBe(1);
      expect(owner.getInfo().updateAvailable).toBe(true);

      owner.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updater.checkForUpdatesCalls).toBe(2);
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });

  it("checks again on activation after one minute without checking earlier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const updater = new DesktopAutoUpdaterAdapterStub();
    const owner = service(updater, createLoggerMessages(), () => Date.now());

    try {
      await owner.checkForUpdates();
      updater.updateCheckResult = createUpdateCheckResult("0.0.2");
      await vi.advanceTimersByTimeAsync(59_999);
      await owner.checkAfterActive();
      expect(updater.checkForUpdatesCalls).toBe(1);
      expect(owner.getInfo().updateAvailable).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await owner.checkAfterActive();
      expect(updater.checkForUpdatesCalls).toBe(2);
      expect(updater.downloadUpdateCalls).toBe(1);
      expect(owner.getInfo().updateAvailable).toBe(true);
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });

  it("downloads a validated Windows NSIS candidate without installing on quit", async () => {
    const updater = new DesktopAutoUpdaterAdapterStub();
    const result = createUpdateCheckResult("0.0.2");

    const updateInfo = {
      ...result.updateInfo,
      files: [{ url: "private.exe", size: 128, sha512: "A".repeat(86) + "==" }],
      omnyoPrivate: {
        appId: "dev.bb.private",
        teamId: "",
        platform: "windows",
        runtimeVersion: "0.0.2+private.2",
        protocolVersion: 236,
        runtimeSha256: "a".repeat(64),
        desktopSha256: "b".repeat(64),
        executableSha256: "c".repeat(64),
      },
    };

    updater.updateCheckResult = { ...result, updateInfo };

    const owner = createDesktopAutoUpdateService({
      async verifyInstalledArtifact() {},
      appId: "dev.bb.private",
      currentVersion: "0.0.1",
      enabled: true,
      feedConfig,
      forceDevUpdateConfig: false,
      logger: createLogger(createLoggerMessages()),
      platform: "windows",
      updater,
    });

    await owner.checkForUpdates();
    expect(updater.downloadUpdateCalls).toBe(1);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.quitAndInstallCalls).toBe(0);
  });

  it("holds a verified downloaded candidate across scheduled and active rechecks", async () => {
    const updater = new DesktopAutoUpdaterAdapterStub();
    updater.updateCheckResult = createUpdateCheckResult("0.0.2");
    let time = Date.parse(checkedAt);
    const owner = service(updater, createLoggerMessages(), () => time);
    await owner.checkForUpdates();
    updater.emitUpdateDownloaded(createDownloadedEvent("0.0.2"));
    await owner.checkForUpdates();
    time += 16 * 60 * 1000;
    await owner.checkAfterActive();
    expect(updater.checkForUpdatesCalls).toBe(1);
    expect(owner.getInfo()).toMatchObject({
      pendingVersion: "0.0.2",
      updateDownloaded: true,
    });
  });
  it("reports failed checks without echoing the upstream payload and permits a later verified check", async () => {
    const updater = new DesktopAutoUpdaterAdapterStub();
    updater.updateCheckError = new Error("synthetic-private-url");
    const messages = createLoggerMessages();
    const owner = service(updater, messages);
    await owner.checkForUpdates();
    expect(owner.getInfo().updateAvailable).toBe(false);
    expect(messages.errors.join(" ")).not.toContain("synthetic-private-url");
    updater.updateCheckError = null;
    updater.updateCheckResult = createUpdateCheckResult("0.0.2");
    await owner.checkForUpdates();
    expect(owner.getInfo().updateAvailable).toBe(true);
  });
  it("reports rejected downloads and clears installation eligibility", async () => {
    const updater = new DesktopAutoUpdaterAdapterStub();
    updater.updateCheckResult = createUpdateCheckResult("0.0.2");
    updater.downloadUpdateResult = Promise.reject(
      new Error("synthetic-private-url"),
    );
    void updater.downloadUpdateResult.catch(() => {});
    const messages = createLoggerMessages();
    const owner = service(updater, messages);
    await owner.checkForUpdates();
    expect(owner.getInfo().downloadState).toBe("failed");
    expect(owner.getInfo().updateDownloaded).toBe(false);
    expect(messages.errors.join(" ")).not.toContain("synthetic-private-url");
  });
  it("does not initialize updater in development without the explicit override", async () => {
    const updater = new DesktopAutoUpdaterAdapterStub();

    const enabled = shouldEnableDesktopAutoUpdate({
      env: {},
      isPackaged: false,
    });

    const owner = createDesktopAutoUpdateService({
      async verifyInstalledArtifact() {},
      currentVersion: "0.0.1",
      enabled,
      feedConfig,
      forceDevUpdateConfig: false,
      logger: createLogger(createLoggerMessages()),
      platform: "macos",
      updater,
    });

    owner.start();
    await owner.checkForUpdates();
    expect(updater.feedConfigs).toEqual([]);
    expect(updater.checkForUpdatesCalls).toBe(0);
  });
  it("allows the explicit development override", () => {
    expect(
      shouldEnableDesktopAutoUpdate({
        env: { OMNYO_DESKTOP_AUTO_UPDATE: "1" },
        isPackaged: false,
      }),
    ).toBe(true);
  });
});

it("pins beta before updater setup and rechecks before network", async () => {
  const updater = new DesktopAutoUpdaterAdapterStub();
  const feed = publicBetaUpdateFeed();

  const args = {
    async verifyInstalledArtifact() {},
    currentVersion: "0.46.316+private.1",
    enabled: true,
    feedConfig: feed,
    appId: "dev.omnyo.beta",
    forceDevUpdateConfig: false,
    logger: createLogger(createLoggerMessages()),
    platform: "macos" as const,
    updater,
  };

  expect(() =>
    createDesktopAutoUpdateService({ ...args, appId: "dev.omnyo.private" }),
  ).toThrow("policy differs");
  expect(updater.feedConfigs).toEqual([]);
  const owner = createDesktopAutoUpdateService(args);
  feed.url = "https://github.com/other/repo/releases/download/macos/";
  await owner.checkForUpdates();
  expect(updater.checkForUpdatesCalls).toBe(0);
  expect(updater.downloadUpdateCalls).toBe(0);
  expect(owner.getInfo().downloadState).toBe("failed");
  owner.stop();
});

it("rejects a changed beta distribution on the downloaded event", async () => {
  const updater = new DesktopAutoUpdaterAdapterStub();
  const result = createUpdateCheckResult("0.46.317");

  const updateInfo = {
    ...createUpdateInfo("0.46.317"),
    omnyoPrivate: {
      ...createUpdateInfo("0.46.317").omnyoPrivate,
      appId: "dev.omnyo.beta",
    },
  };

  updater.updateCheckResult = { ...result, updateInfo };
  const feed = publicBetaUpdateFeed();

  const owner = createDesktopAutoUpdateService({
    async verifyInstalledArtifact() {},
    currentVersion: "0.46.316+private.1",
    enabled: true,
    feedConfig: feed,
    appId: "dev.omnyo.beta",
    forceDevUpdateConfig: false,
    logger: createLogger(createLoggerMessages()),
    platform: "macos",
    updater,
  });

  await owner.checkForUpdates();
  expect(updater.downloadUpdateCalls).toBe(1);
  feed.url = "https://github.com/other/repo/releases/download/macos/";
  updater.emitUpdateDownloaded({
    ...updateInfo,
    downloadedFile: "/synthetic/beta.zip",
  });
  expect(owner.getInfo().downloadState).toBe("failed");
  expect(() => owner.getDownloadedCandidate()).toThrow();
  owner.stop();
});
