import { deferred } from "./fixtures/deferred.js";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type {
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import {
  createDesktopAutoUpdateService,
  type DesktopAutoUpdaterAdapter,
  type DesktopAutoUpdateErrorArgs,
  type DesktopAutoUpdateLogger,
} from "../src/desktop-auto-update.js";
import type { DesktopAutoUpdateFeedConfig } from "../src/desktop-update-provider.js";

const feed: DesktopAutoUpdateFeedConfig = {
  channel: "latest",
  provider: "generic",
  url: "https://fixture.invalid/private/",
};

const update: UpdateInfo & {
  omnyoPrivate: {
    appId: string;
    teamId: string;
    runtimeVersion: string;
    protocolVersion: number;
  };
} = {
  path: "Omnyo-Private-0.46.2-arm64.zip",
  sha512: "A".repeat(86) + "==",
  omnyoPrivate: {
    appId: "dev.omnyo.private",
    teamId: "Z7T4C33A35",
    runtimeVersion: "0.46.2+private.2",
    protocolVersion: 234,
  },
  files: [
    {
      url: "Omnyo-Private-0.46.2-arm64.zip",
      sha512: "A".repeat(86) + "==",
      size: 128,
    },
  ],
  releaseDate: "2026-10-13T00:00:00.000Z",
  version: "0.46.2",
};

const logger: DesktopAutoUpdateLogger = {
  error() {},
  info() {},
  warn() {},
};

class FixtureUpdater extends EventEmitter implements DesktopAutoUpdaterAdapter {
  feed: DesktopAutoUpdateFeedConfig | null = null;
  autoInstallOnAppQuit: boolean | null = null;
  downloads = 0;
  installs = 0;
  checks = 0;
  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.checks += 1;

    return { isUpdateAvailable: true, updateInfo: update, versionInfo: update };
  }
  async downloadUpdate(): Promise<string[]> {
    this.downloads += 1;

    return ["/owned-fixture/update.zip"];
  }
  onError(handler: (args: DesktopAutoUpdateErrorArgs) => void): void {
    this.on("failure", handler);
  }
  onUpdateAvailable(handler: (info: UpdateInfo) => void): void {
    this.on("available", handler);
  }
  onUpdateDownloaded(handler: (event: UpdateDownloadedEvent) => void): void {
    this.on("downloaded", handler);
  }
  onUpdateNotAvailable(handler: (info: UpdateInfo) => void): void {
    this.on("unavailable", handler);
  }
  quitAndInstall(): void {
    this.installs += 1;
  }
  setAutoDownload(): void {}
  setAutoInstallOnAppQuit(enabled: boolean): void {
    this.autoInstallOnAppQuit = enabled;
  }
  setFeedURL(value: DesktopAutoUpdateFeedConfig): void {
    this.feed = value;
  }
  setForceDevUpdateConfig(): void {}
  setLogger(): void {}
}

function createService(
  updater: FixtureUpdater,
  configuredFeed: DesktopAutoUpdateFeedConfig | null = feed,
  verifyInstalledArtifact: () => Promise<void> = async () => {},
) {
  return createDesktopAutoUpdateService({
    verifyInstalledArtifact,
    currentVersion: "0.46.1",
    enabled: true,
    feedConfig: configuredFeed,
    forceDevUpdateConfig: false,
    logger,
    platform: "macos",
    updater,
  });
}

async function downloadCandidate(
  updater: FixtureUpdater,
  service: ReturnType<typeof createService>,
): Promise<void> {
  await service.checkForUpdates();
  updater.emit("downloaded", {
    ...update,
    downloadedFile: "/owned-fixture/update.zip",
  });
}

function lifecycle(calls: string[], refusal: string | null = null) {
  return {
    async acquireInstallHold(): Promise<void> {
      calls.push("hold");

      if (refusal !== null) throw new Error(refusal);
    },
    async stageNativeUpdate(): Promise<void> {
      calls.push("native-ready");
    },
    async finishQuit(): Promise<void> {
      calls.push("shutdown");
    },
  };
}

describe("private update lifecycle", () => {
  it("shares a pending verification across manual, active and scheduled checks before network or downloads", async () => {
    const updater = new FixtureUpdater();
    const verification = deferred();
    let checks = 0;

    const service = createService(updater, feed, () => {
      checks += 1;

      return verification.promise;
    });

    try {
      service.start();
      const manual = service.checkForUpdates();
      const active = service.checkAfterActive();
      expect(checks).toBe(1);
      expect(updater.checks).toBe(0);
      expect(updater.downloads).toBe(0);
      verification.resolve();
      await Promise.all([manual, active]);
      expect(checks).toBe(1);
      expect(updater.checks).toBe(1);
      expect(updater.downloads).toBe(1);
    } finally {
      verification.resolve();
      service.stop();
    }
  });

  it("refuses rejected bootstrap verification before checks, downloads or an early install action", async () => {
    const updater = new FixtureUpdater();
    const verification = deferred();
    const service = createService(updater, feed, () => verification.promise);
    const calls: string[] = [];
    const check = service.checkForUpdates();
    const install = service.installUpdate(lifecycle(calls));

    const rejected = expect(install).rejects.toThrow(
      "fixture verification failed",
    );

    expect(updater.checks).toBe(0);
    expect(calls).toEqual([]);
    verification.reject(new Error("fixture verification failed"));
    await rejected;
    await check;
    expect(service.getInfo().downloadState).toBe("failed");
    expect(updater.checks).toBe(0);
    expect(updater.downloads).toBe(0);
    expect(updater.installs).toBe(0);
    expect(calls).toEqual([]);
  });

  it("selects only the explicitly configured feed and never stages on ordinary quit", () => {
    const updater = new FixtureUpdater();
    createService(updater);
    expect(updater.feed).toEqual(feed);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("leaves missing configuration disabled without an implicit network destination", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater, null);
    await service.checkForUpdates();
    expect(updater.feed).toBeNull();
    expect(updater.checks).toBe(0);
    expect(updater.downloads).toBe(0);
  });

  it.each([
    "active turn",
    "pending plugin load",
    "unknown local owner",
    "admission hold exists",
    "owner unavailable",
  ])("refuses %s before native staging or runtime shutdown", async (reason) => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await downloadCandidate(updater, service);
    const calls: string[] = [];
    await expect(
      Promise.resolve().then(() =>
        service.installUpdate(lifecycle(calls, reason)),
      ),
    ).rejects.toThrow(reason);
    expect(calls).toEqual(["hold"]);
    expect(updater.installs).toBe(0);
    expect(service.getInfo().updateDownloaded).toBe(true);
  });

  it("waits for native signature acceptance before shutdown and one install", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await downloadCandidate(updater, service);
    const calls: string[] = [];
    await service.installUpdate(lifecycle(calls));
    expect(calls).toEqual(["hold", "native-ready", "shutdown"]);
    expect(updater.installs).toBe(1);
  });

  it("keeps Omnyo running when native staging rejects the signature", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await downloadCandidate(updater, service);
    const calls: string[] = [];
    const install = lifecycle(calls);
    install.stageNativeUpdate = async () => {
      calls.push("native-rejected");
      throw new Error("fixture signature rejected");
    };

    await expect(
      Promise.resolve().then(() => service.installUpdate(install)),
    ).rejects.toThrow("fixture signature rejected");
    expect(calls).toEqual(["hold", "native-rejected"]);
    expect(updater.installs).toBe(0);
  });

  it("does not install after an error invalidates the downloaded candidate", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await downloadCandidate(updater, service);
    updater.emit("failure", {
      error: new Error("fixture digest mismatch"),
      message: null,
    });
    const calls: string[] = [];
    await expect(
      Promise.resolve().then(() => service.installUpdate(lifecycle(calls))),
    ).rejects.toThrow();
    expect(service.getInfo().updateDownloaded).toBe(false);
    expect(calls).toEqual([]);
    expect(updater.installs).toBe(0);
  });

  it("serializes duplicate install requests while native acceptance is pending", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await downloadCandidate(updater, service);
    const calls: string[] = [];
    let accept: (() => void) | undefined;

    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });

    const install = lifecycle(calls);
    install.stageNativeUpdate = async () => {
      calls.push("native-pending");
      await pending;
    };

    const first = service.installUpdate(install);
    const second = service.installUpdate(install);
    await expect.poll(() => calls).toEqual(["hold", "native-pending"]);
    expect(updater.installs).toBe(0);
    expect(calls).toEqual(["hold", "native-pending"]);
    accept?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(["hold", "native-pending", "shutdown"]);
    expect(updater.installs).toBe(1);
  });
  it("ignores an unsolicited downloaded event before a verified check", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    updater.emit("downloaded", {
      ...update,
      downloadedFile: "/owned-fixture/update.zip",
    });
    expect(service.getInfo().updateDownloaded).toBe(false);
    await expect(
      Promise.resolve().then(() => service.installUpdate(lifecycle([]))),
    ).rejects.toThrow();
    expect(updater.installs).toBe(0);
  });

  it("ignores a late downloaded event after candidate invalidation", async () => {
    const updater = new FixtureUpdater();
    const service = createService(updater);
    await service.checkForUpdates();
    updater.emit("failure", {
      error: new Error("synthetic failed download"),
      message: null,
    });
    updater.emit("downloaded", {
      ...update,
      downloadedFile: "/owned-fixture/update.zip",
    });
    expect(service.getInfo().updateDownloaded).toBe(false);
    await expect(
      Promise.resolve().then(() => service.installUpdate(lifecycle([]))),
    ).rejects.toThrow();
    expect(updater.installs).toBe(0);
  });
});
