import { app, BrowserWindow, safeStorage, session } from "electron";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  compareDesktopCookiesV2,
  desktopContinuityExecutableV2,
  desktopContinuityFencePathV2,
  desktopContinuityReportSchemaV2,
  readDesktopContinuityPreEntryV2,
  verifyDesktopContinuityArtifactV2,
  verifyDesktopEncryptedFileV2,
} from "./desktop-profile-continuity-v2.js";

const requireNative = createRequire(__filename);

const fenceSchema = z
  .object({
    interactionNotAllowed: z.literal(true),
    processId: z.literal(process.pid),
  })
  .passthrough();

export async function runDesktopProfileContinuityEntryV2(
  argv: string[],
): Promise<void> {
  const [flag, jobDir] = argv;

  if (
    argv.length !== 2 ||
    flag !== "--omnyo-profile-continuity-v2" ||
    jobDir === undefined ||
    resolve(jobDir) !== jobDir ||
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.execPath !== desktopContinuityExecutableV2 ||
    !app.isPackaged ||
    process.defaultApp === true ||
    app.isReady() ||
    app.commandLine.hasSwitch("use-mock-keychain")
  )
    throw new Error(
      "Desktop continuity requires its exact packaged pre-entry owner",
    );

  const selected = readDesktopContinuityPreEntryV2(jobDir, process.ppid);

  if (
    selected.consumers.qualification.selected.sourceCommit !==
      process.env.OMNYO_DESKTOP_COMMIT ||
    selected.consumers.qualification.selected.runtimeVersion !==
      process.env.OMNYO_DESKTOP_VERSION ||
    process.env.OMNYO_DESKTOP_RELEASE_CHANNEL !== "latest" ||
    basename(process.execPath) !== "Omnyo"
  )
    throw new Error("Desktop continuity selected build differs");
  const value: unknown = requireNative(desktopContinuityFencePathV2);

  if (
    value === null ||
    typeof value !== "object" ||
    !("fence" in value) ||
    typeof value.fence !== "function"
  )
    throw new Error("Desktop continuity native process fence is unavailable");
  const nativeFence = value.fence;
  const fence = () => fenceSchema.parse(Reflect.apply(nativeFence, value, []));
  fence();
  const { context, requestSha256 } = selected;
  const contexts = selected.request.contexts;

  app.setName("Omnyo Private");
  app.setPath("userData", context.probe);
  app.setActivationPolicy("prohibited");
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
  let networkChildObserved = false;
  app.on("child-process-gone", (_event, details) => {
    if (/network/iu.test(details.serviceName || details.name || ""))
      networkChildObserved = true;
  });

  const assertRuntime = () => {
    fence();

    if (
      networkChildObserved ||
      BrowserWindow.getAllWindows().length !== 0 ||
      app
        .getAppMetrics()
        .some(
          (entry) =>
            entry.type === "Utility" &&
            /network/iu.test(entry.serviceName || entry.name || ""),
        )
    )
      throw new Error("Desktop continuity operational process closure differs");
  };

  await verifyDesktopContinuityArtifactV2(jobDir, selected.request.artifact);
  await app.whenReady();
  assertRuntime();

  const encryptedFileWitness = await verifyDesktopEncryptedFileV2(
    context.sourceProbe,
    context.probe,
    safeStorage,
  );

  let cookieCount = 0;
  let encryptedCookieCount = 0;
  let encryptedCookieWitness = false;
  const snapshots = [];

  for (let offset = 0; offset < contexts.length; offset += 4) {
    const batch = await Promise.all(
      contexts.slice(offset, offset + 4).map(async (entry) => {
        const [sourceValue, targetValue] = await Promise.all([
          session.fromPath(entry.source).cookies.get({}),
          session.fromPath(entry.target).cookies.get({}),
        ]);

        return {
          key: entry.key,
          checked: compareDesktopCookiesV2(
            entry.sourceCookies,
            entry.targetCookies,
            sourceValue,
            targetValue,
          ),
        };
      }),
    );

    for (const { key, checked } of batch) {
      cookieCount += checked.count;
      encryptedCookieCount += checked.encrypted;
      encryptedCookieWitness ||= checked.encryptedWitness;
      snapshots.push({ key, sha256: checked.sha256 });
    }
  }

  assertRuntime();

  const report = desktopContinuityReportSchemaV2.parse({
    version: 2,
    processId: process.pid,
    requestSha256,
    bindingSha256: context.bindingSha256,
    nativeOwnerSha256: context.nativeOwnerSha256,
    protectedStore: true,
    cookies: true,
    contextCount: contexts.length,
    cookieCount,
    encryptedCookieCount,
    encryptedFileWitness,
    encryptedCookieWitness,
    snapshotsSha256: createHash("sha256")
      .update(JSON.stringify(snapshots))
      .digest("hex"),
    interactionNotAllowed: true,
    networkServices: 0,
    windows: 0,
  });

  if (
    (await readFile(join(jobDir, "desktop-profile-admission"), "utf8")) !== "0"
  )
    throw new Error("Desktop continuity first-write admission changed");

  const handle = await open(
    join(jobDir, "desktop-profile-continuity-report-v2.json"),
    "wx",
    0o600,
  );

  try {
    await handle.writeFile(JSON.stringify(report) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }

  app.quit();
}
