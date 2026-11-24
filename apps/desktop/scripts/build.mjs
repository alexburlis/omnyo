import { publicBetaCollectionPlugins } from "../../../scripts/public-beta-collection.mjs";
import { compileDesktopProtectedStoreConsumersV1 } from "./prepare-protected-store-consumers.mjs";
import { execFileSync } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  desktopBuildSelection,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const packageRoot = process.cwd();

const desktopReleaseChannel = resolveDesktopReleaseChannel(process.env);

const selection = desktopBuildSelection(desktopReleaseChannel);

const distDir = resolve(packageRoot, selection.outputDirectory);

const packageJsonPath = resolve(packageRoot, "package.json");

const pluginSdkPackageJsonPath = resolve(
  packageRoot,
  "..",
  "..",
  "packages",
  "plugin-sdk",
  "package.json",
);

function readPackageVersion(packageJsonText, label) {
  const packageJson = JSON.parse(packageJsonText);

  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error(`${label} must define a version`);
  }

  return packageJson.version;
}

function readBuildCommit(env) {
  const injected =
    env.OMNYO_DESKTOP_COMMIT?.trim() ?? env.GITHUB_SHA?.trim() ?? "";

  if (injected.length > 0) {
    return injected;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readBuildDate(env) {
  const injected = env.OMNYO_DESKTOP_BUILD_DATE?.trim() ?? "";

  if (injected.length > 0) {
    return injected;
  }

  return new Date().toISOString();
}

await rm(distDir, { force: true, recursive: true });

const desktopVersion = readPackageVersion(
  await readFile(packageJsonPath, "utf8"),
  "apps/desktop/package.json",
);

const pluginSdkVersion = readPackageVersion(
  await readFile(pluginSdkPackageJsonPath, "utf8"),
  "packages/plugin-sdk/package.json",
);

const desktopCommit = readBuildCommit(process.env);

const desktopBuildDate = readBuildDate(process.env);

const commonOptions = {
  bundle: true,
  plugins: publicBetaCollectionPlugins(),
  define: {
    "process.env.OMNYO_DESKTOP_BUILD_DATE": JSON.stringify(desktopBuildDate),
    "process.env.OMNYO_DESKTOP_COMMIT": JSON.stringify(desktopCommit),
    "process.env.OMNYO_DESKTOP_PLUGIN_SDK_VERSION":
      JSON.stringify(pluginSdkVersion),
    "process.env.OMNYO_DESKTOP_RELEASE_CHANNEL": JSON.stringify(
      desktopReleaseChannel,
    ),
    "process.env.OMNYO_DESKTOP_VERSION": JSON.stringify(desktopVersion),
  },
  legalComments: "none",
  platform: "node",
  sourcemap: true,
  target: "node24",
};

await Promise.all([
  ...(selection.privateContinuity
    ? [
        compileDesktopProtectedStoreConsumersV1(packageRoot, distDir),
        build({
          ...commonOptions,
          entryPoints: [
            resolve(packageRoot, "src", "desktop-profile-adoption-v1.ts"),
          ],
          format: "cjs",
          define: {
            ...commonOptions.define,
            "import.meta.url": "__omnyoProfileRuntimeAnchor",
          },
          banner: {
            js: 'const __omnyoProfileRuntimeAnchor = require("node:url").pathToFileURL(require("node:path").resolve(__dirname, "../node_modules/omnyo-app/package.json")).href;',
          },
          outfile: resolve(distDir, "desktop-profile-adoption-v1.cjs"),
        }),
        build({
          ...commonOptions,
          entryPoints: [
            resolve(
              packageRoot,
              "src",
              "desktop-profile-continuity-entry-v2.ts",
            ),
          ],
          external: ["electron", "original-fs"],
          format: "cjs",
          define: {
            ...commonOptions.define,
            "import.meta.url": "__omnyoContinuityRuntimeAnchor",
          },
          banner: {
            js: 'const __omnyoContinuityRuntimeAnchor = require("node:url").pathToFileURL(require("node:path").resolve(__dirname, "../node_modules/omnyo-app/package.json")).href;',
          },
          outfile: resolve(distDir, "desktop-profile-continuity-entry-v2.cjs"),
        }),
      ]
    : []),
  build({
    ...commonOptions,
    bundle: false,
    entryPoints: [resolve(packageRoot, "src", "startup.ts")],
    format: "cjs",
    outfile: resolve(distDir, "main.js"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "main.ts")],
    external: ["electron", "original-fs", "@aws-sdk/client-s3"],
    format: "cjs",
    outfile: resolve(distDir, "desktop-main.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "preload.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "browser-page-preload.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "browser-page-preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "find-bar-preload.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "find-bar-preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "log-viewer-preload.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "log-viewer-preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "server-url-dialog-preload.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "server-url-dialog-preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [
      resolve(packageRoot, "src", "existing-server-dialog-preload.ts"),
    ],
    external: ["electron"],
    format: "cjs",
    outfile: resolve(distDir, "existing-server-dialog-preload.cjs"),
  }),
  build({
    ...commonOptions,
    entryPoints: [resolve(packageRoot, "src", "omnyo-app-bridge.mts")],
    external: ["omnyo-app", "omnyo-app/*"],
    format: "esm",
    outfile: resolve(distDir, "omnyo-app-bridge.mjs"),
  }),
]);

if (selection.privateContinuity)
  await copyFile(
    resolve(
      packageRoot,
      "..",
      "..",
      "scripts",
      "private-electron-trust-probe.cjs",
    ),
    resolve(distDir, "private-electron-trust-probe.cjs"),
  );

process.stdout.write("@omnyo/desktop: built Electron entries\n");
