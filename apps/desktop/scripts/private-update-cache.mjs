import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
} from "./desktop-release-channel.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writePrivateUpdateCacheMetadata(
  resourcesPath,
  appId,
  platform,
) {
  const buildPlatform = resolveDesktopBuildPlatform(platform);

  const allowed = ["latest", "nightly"].map(
    (channel) => createDesktopReleaseConfig(channel, buildPlatform).appId,
  );

  if (buildPlatform === "macos") allowed.push("dev.omnyo.beta");

  if (!allowed.includes(appId))
    throw new Error("Private updater cache identity is invalid");
  await mkdir(resourcesPath, { recursive: true });
  await writeFile(
    join(resourcesPath, "app-update.yml"),
    `updaterCacheDirName: ${appId}-updater\n`,
    { mode: 0o644 },
  );
}
