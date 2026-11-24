import { app, autoUpdater as nativeUpdater } from "electron";
import { MacUpdater } from "electron-updater";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectDownloadedPrivateUpdate,
  inspectInstalledPrivateUpdate,
} from "../../src/private-update-artifact.js";
import { z } from "zod";
import { redactCredentialText } from "@omnyo/domain";
import { nativeNumericVersion } from "../../src/private-update-config.js";
import type { PrivateUpdateArtifact } from "../../src/private-update-install.js";
import {
  createDesktopAutoUpdateService,
  createElectronAutoUpdaterAdapter,
} from "../../src/desktop-auto-update.js";

const fixtureConfigSchema = z
  .object({
    reportDirectory: z.string(),
    userData: z.string(),
    feedUrl: z.string(),
    appId: z.string(),
    scenario: z.enum([
      "baseline",
      "digest-rejection",
      "signature-rejection",
      "active-work",
      "ordinary-quit",
      "install",
    ]),
  })
  .strict();

type FixtureReportValue =
  | string
  | number
  | boolean
  | string[]
  | PrivateUpdateArtifact;

type FixtureReport = Record<string, FixtureReportValue>;

async function main(): Promise<void> {
  const configPath = process.env.OMNYO_PRIVATE_UPDATER_FIXTURE_CONFIG;

  if (configPath === undefined)
    throw new Error("Owned fixture configuration is required");

  const config = fixtureConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  app.setPath("userData", config.userData);
  app.setName("Omnyo Updater Fixture");
  app.setActivationPolicy("prohibited");

  const calls: string[] = [];
  let nativeChecks = 0;
  let nativeReady = false;
  let shutdowns = 0;
  let hold = false;
  let nativeFailure = false;
  let serviceFailure = false;

  async function report(name: string, result: FixtureReport): Promise<void> {
    await writeFile(
      join(config.reportDirectory, name + ".json"),
      JSON.stringify(
        { version: nativeNumericVersion(app.getVersion()), ...result },
        null,
        2,
      ) + "\n",
    );
  }

  nativeUpdater.on("checking-for-update", () => {
    nativeChecks += 1;
  });
  nativeUpdater.on("update-downloaded", () => {
    nativeReady = true;
    calls.push("native-accepted");
  });
  nativeUpdater.on("error", () => {
    nativeFailure = true;
    calls.push("native-rejected");
  });

  await app.whenReady();
  await report("started", {
    packaged: app.isPackaged,
    pid: process.pid,
    executable: app.getPath("exe"),
  });
  await report("started-" + process.pid, {
    packaged: app.isPackaged,
    pid: process.pid,
    executable: app.getPath("exe"),
  });

  if (nativeNumericVersion(app.getVersion()) === "0.46.2") {
    const installed = await inspectInstalledPrivateUpdate(
      resolve(app.getPath("exe"), "../../.."),
    );

    if (
      installed.appId !== config.appId ||
      installed.protocolVersion !== 234 ||
      installed.runtimeVersion !== "0.46.2+private.2"
    )
      throw new Error("Replacement fixture identity mismatch");
    await report("relaunch", {
      installedArtifact: installed,
      nativeInstallCompleted: true,
      pid: process.pid,
      executable: app.getPath("exe"),
    });
    app.quit();
  } else {
    const updater = new MacUpdater({
      provider: "generic",
      channel: "latest",
      url: config.feedUrl,
    });

    updater.disableDifferentialDownload = true;
    updater.allowDowngrade = false;

    const service = createDesktopAutoUpdateService({
      async verifyInstalledArtifact() {},
      currentVersion: app.getVersion(),
      appId: config.appId,
      enabled: true,
      feedConfig: {
        provider: "generic",
        channel: "latest",
        url: config.feedUrl,
      },
      forceDevUpdateConfig: false,
      logger: {
        error() {
          serviceFailure = true;
        },
        info() {},
        warn() {},
      },
      platform: "macos",
      updater: createElectronAutoUpdaterAdapter(updater),
    });

    if (config.scenario === "baseline") {
      await report("result", {
        autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
        nativeChecks,
        shutdowns,
        passed: !updater.autoInstallOnAppQuit,
      });
      app.quit();
    } else {
      const deadline = Date.now() + 60_000;
      await service.checkForUpdates();

      while (
        !service.getInfo().updateDownloaded &&
        !serviceFailure &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (config.scenario === "digest-rejection") {
        await report("result", {
          serviceFailure,
          nativeChecks,
          shutdowns,
          hold,
          downloaded: service.getInfo().updateDownloaded,
          passed:
            serviceFailure &&
            nativeChecks === 0 &&
            shutdowns === 0 &&
            !hold &&
            !service.getInfo().updateDownloaded,
        });
        app.quit();
      } else if (config.scenario === "ordinary-quit") {
        await report("result", {
          nativeChecks,
          shutdowns,
          hold,
          downloaded: service.getInfo().updateDownloaded,
          passed:
            service.getInfo().updateDownloaded &&
            nativeChecks === 0 &&
            shutdowns === 0 &&
            !hold,
        });
        app.quit();
      } else {
        try {
          const artifact = await inspectDownloadedPrivateUpdate({
            ...service.getDownloadedCandidate(),
            currentVersion: app.getVersion(),
            expectedAppId: config.appId,
            expectedProtocolVersion: 234,
          });

          await report("artifact", { artifact, verifiedAsData: true });
          await service.installUpdate({
            async acquireInstallHold() {
              calls.push("hold");

              if (config.scenario === "active-work")
                throw new Error("Owned synthetic active work");
              hold = true;
              await report("hold", {
                owner: "fixture-only",
                artifactVersion: "0.46.2",
              });
            },
            async stageNativeUpdate() {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                  () => done(new Error("Native fixture staging timed out")),
                  60_000,
                );

                function accepted(): void {
                  done();
                }

                function rejected(): void {
                  done(new Error("Native fixture signature rejected"));
                }

                function done(error?: Error): void {
                  clearTimeout(timeout);
                  nativeUpdater.removeListener("update-downloaded", accepted);
                  nativeUpdater.removeListener("error", rejected);

                  if (error === undefined) resolve();
                  else reject(error);
                }

                nativeUpdater.once("update-downloaded", accepted);
                nativeUpdater.once("error", rejected);
                nativeUpdater.checkForUpdates();
              });
            },
            async finishQuit() {
              if (!nativeReady || !hold)
                throw new Error(
                  "Native readiness/hold missing before fixture shutdown",
                );
              shutdowns += 1;
              calls.push("shutdown");
              await report("handoff", { calls, shutdowns, nativeReady, hold });
            },
          });
        } catch {
          await report("result", {
            calls,
            shutdowns,
            hold,
            nativeChecks,
            nativeReady,
            nativeFailure,
            passed:
              config.scenario === "active-work"
                ? calls.includes("hold") &&
                  !hold &&
                  nativeChecks === 0 &&
                  shutdowns === 0
                : config.scenario === "signature-rejection" &&
                  nativeFailure &&
                  hold &&
                  !nativeReady &&
                  shutdowns === 0,
          });
          app.quit();
        }
      }
    }
  }
}

void main().catch(async (error) => {
  const path = process.env.OMNYO_PRIVATE_UPDATER_FIXTURE_CONFIG;

  if (path !== undefined) {
    const config = fixtureConfigSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );

    await writeFile(
      join(config.reportDirectory, "fixture-failure.json"),
      JSON.stringify({
        failure: redactCredentialText(
          error instanceof Error ? error.message : "Native fixture failed",
        ),
      }),
    );
  }

  process.exitCode = 1;
  app.quit();
});
