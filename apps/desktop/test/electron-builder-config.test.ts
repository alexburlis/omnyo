import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { macBundleVersion } from "@omnyo/config/release-version";
import { desktopNativeVersion } from "../scripts/desktop-release-channel.mjs";
import { createDesktopReleaseInfo } from "../src/desktop-update-provider.js";

describe("desktop native version identity", () => {
  it.each([
    [
      "0.46.378+private.1",
      {
        shortVersion: "0.46.378",
        bundleVersion: "1",
        buildNumber: "1",
        buildVersion: "0.46.378.1",
      },
    ],
    [
      "1.0.0+private.1",
      {
        shortVersion: "1.0.0",
        bundleVersion: "1",
        buildNumber: "1",
        buildVersion: "1.0.0.1",
      },
    ],
    [
      "1.0.1",
      {
        shortVersion: "1.0.1",
        bundleVersion: "1.0.1",
        buildNumber: "0",
        buildVersion: "1.0.1.0",
      },
    ],
  ])("derives the native identity of %s", (version, expected) => {
    expect(desktopNativeVersion(version)).toEqual(expected);
  });

  it.each(["1.0", "1.0.1-beta", "1.0.1+build.1", "01.0.0"])(
    "refuses the non-release version %s",
    (version) => {
      expect(() => desktopNativeVersion(version)).toThrow(
        "X.Y.Z or X.Y.Z+private.N",
      );
    },
  );
});

const desktopPackageRoot = process.cwd();

const require = createRequire(resolve(desktopPackageRoot, "package.json"));

describe("desktop release channel module", () => {
  it("loads from a source copy that has no installed dependencies", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "desktop-release-channel-"));

    try {
      const scriptsDirectory = resolve(root, "apps/desktop/scripts");
      const configDirectory = resolve(root, "packages/config/src");
      await mkdir(scriptsDirectory, { recursive: true });
      await mkdir(configDirectory, { recursive: true });
      await cp(
        resolve(desktopPackageRoot, "scripts/desktop-release-channel.mjs"),
        resolve(scriptsDirectory, "desktop-release-channel.mjs"),
      );
      await cp(
        resolve(
          desktopPackageRoot,
          "../../packages/config/src/release-version.mjs",
        ),
        resolve(configDirectory, "release-version.mjs"),
      );

      const result = await new Promise<{ code: number | null; output: string }>(
        (resolvePromise, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              'const { desktopNativeVersion } = await import(process.argv[1]); process.stdout.write(desktopNativeVersion("1.0.0+private.1").buildVersion);',
              resolve(scriptsDirectory, "desktop-release-channel.mjs"),
            ],
            { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
          );

          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.once("error", reject);
          child.once("close", (code) => resolvePromise({ code, output }));
        },
      );

      expect(result).toEqual({ code: 0, output: "1.0.0.1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
  restorePackagedRuntimeDependencyManifests(
    runtimeRoot: string,
    sourceRoot: string,
    runtimeIdentity: { files: Array<{ path: string; sha256: string }> },
  ): Promise<void>;
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    signIgnore: z.array(z.string().min(1)),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["omnyo-private", "omnyo-private-nightly"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    publish: z.array(
      z
        .object({
          channel: z.enum(["latest", "nightly"]),
          provider: z.literal("generic"),
          url: z.string().min(1),
        })
        .passthrough(),
    ),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
];

const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;

type EnvironmentOverrides = Record<string, string | undefined>;

type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};

type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;

type RunConfigScript = (
  overrides: EnvironmentOverrides,
  args?: string[],
) => Promise<ScriptRunResult>;

type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
) => Promise<ReadResolvedConfigResult>;

type RunNativePrepScript = (
  appOutDir: string,
  args?: string[],
) => Promise<ScriptRunResult>;

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env = { ...process.env };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (overrides, args = []) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config", ...args],
    {
      cwd: desktopPackageRoot,
      env: createScriptEnvironment(overrides),
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScript: RunNativePrepScript = async (
  appOutDir,
  args = [],
) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir, ...args],
    {
      cwd: desktopPackageRoot,
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

async function readStaticConfig(): Promise<ElectronBuilderConfig> {
  const configText = await readFile(
    resolve(desktopPackageRoot, "electron-builder.config.json"),
    "utf8",
  );

  return electronBuilderConfigSchema.parse(JSON.parse(configText));
}

const readResolvedConfig: ReadResolvedConfig = async (overrides) => {
  const result = await runConfigScript(overrides);

  expect(result.exitCode).toBe(0);

  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );

    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );

    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM omnyo-app bridge with an explicit module extension", async () => {
    const config = await readStaticConfig();

    expect(config.asarUnpack).toContain("dist/omnyo-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/omnyo-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const config = await readStaticConfig();
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);

    const electronVersion = options.electronVersion;

    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "44.3.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );

    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const config = await readStaticConfig();

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps from packaged app files", async () => {
    const config = await readStaticConfig();

    expect(config.files).toContain("!**/*.map");
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const config = await readStaticConfig();

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/omnyo-app/server/dist/app-scaffold-template",
      to: "node_modules/omnyo-app/server/dist/app-scaffold-template",
    });
  });

  it("copies bundled plugins' nested dependencies as a dedicated file set", async () => {
    const config = await readStaticConfig();

    expect(config.files).toContainEqual({
      filter: ["**/node_modules/**", "!**/*.map"],
      from: "node_modules/omnyo-app/server/dist/builtin-plugins",
      to: "node_modules/omnyo-app/server/dist/builtin-plugins",
    });
  });

  it("restores nested runtime dependency manifests that packaging rewrote", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "omnyo-runtime-manifests-"));

    try {
      const source = resolve(root, "source");
      const packaged = resolve(root, "packaged");
      const nested = "server/dist/plugin/node_modules/codec/package.json";
      const original = '{\n  "name": "codec",\n  "scripts": { "x": "y" }\n}\n';
      const ownManifest = '{ "name": "omnyo-app" }\n';

      for (const directory of [source, packaged])
        await mkdir(resolve(directory, dirname(nested)), { recursive: true });
      await writeFile(resolve(source, nested), original);
      await writeFile(resolve(packaged, nested), '{\n  "name": "codec"\n}');
      await writeFile(resolve(source, "package.json"), ownManifest);
      await writeFile(resolve(packaged, "package.json"), "packaged\n");

      const sha256 = (text: string) =>
        createHash("sha256").update(text).digest("hex");

      const identity = {
        files: [
          { path: "package.json", sha256: sha256(ownManifest) },
          { path: nested, sha256: sha256(original) },
        ],
      };

      await nativeModulesScript.restorePackagedRuntimeDependencyManifests(
        packaged,
        source,
        identity,
      );

      expect(await readFile(resolve(packaged, nested), "utf8")).toBe(original);
      expect(await readFile(resolve(packaged, "package.json"), "utf8")).toBe(
        "packaged\n",
      );

      await writeFile(resolve(source, nested), '{ "name": "other" }\n');
      await expect(
        nativeModulesScript.restorePackagedRuntimeDependencyManifests(
          packaged,
          source,
          identity,
        ),
      ).rejects.toThrow(
        "Runtime dependency manifest differs from its identity",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "omnyo-desktop-native-modules-"),
    );

    const nodePtyPackageDir = resolve(
      appOutDir,
      "Omnyo.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );

    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");

    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );

    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );

    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScript(appOutDir);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );

      if (process.platform !== "win32") {
        expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
        expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(0o755);
      }
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("validates bundled N-API SQLite without using the legacy prebuild installer", async () => {
    const appOutDir = await mkdtemp(resolve(tmpdir(), "omnyo-desktop-napi-"));
    const nodeModules = resolve(appOutDir, "node_modules");

    const electronVersion = z
      .object({ version: z.string().min(1) })
      .parse(require("electron/package.json")).version;

    const requireFromRuntime = createRequire(
      resolve(desktopPackageRoot, "../../packages/omnyo-app/package.json"),
    );

    try {
      const ptyLib = resolve(nodeModules, "node-pty/lib");
      await mkdir(ptyLib, { recursive: true });
      await writeFile(
        resolve(ptyLib, "unixTerminal.js"),
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await cp(
        dirname(requireFromRuntime.resolve("better-sqlite3/package.json")),
        resolve(nodeModules, "better-sqlite3"),
        { recursive: true },
      );
      await mkdir(resolve(nodeModules, "@parcel/watcher"), { recursive: true });

      const result = await runNativePrepScript(appOutDir, [
        `--electron-version=${electronVersion}`,
      ]);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const binaryPath = resolve(
        nodeModules,
        "better-sqlite3/prebuilds",
        `${process.platform}-${process.arch}.node`,
      );

      await writeFile(binaryPath, "invalid native binary");

      const invalidResult = await runNativePrepScript(appOutDir, [
        `--electron-version=${electronVersion}`,
      ]);

      expect(invalidResult.exitCode).not.toBe(0);
      expect(invalidResult.stderr).toContain(binaryPath);
      expect(invalidResult.stderr).not.toContain("prebuild-install");
    } finally {
      await rm(appOutDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("points mac signing entitlements at checked-in plist files", async () => {
    const config = await readStaticConfig();

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const config = await readStaticConfig();

    expect(config.mac.target).toEqual([{ arch: ["arm64"], target: "zip" }]);
  });

  it("codesigns only Mach-O code and Apple-platform prebuilds", async () => {
    const config = await readStaticConfig();
    const patterns = config.mac.signIgnore.map((entry) => new RegExp(entry));
    const app = "/release/mac-arm64/Omnyo.app/Contents";
    const unpacked = `${app}/Resources/app.asar.unpacked/node_modules`;
    const framework = `${app}/Frameworks/Electron Framework.framework/Versions/A`;

    const ignored = (path: string) =>
      patterns.some((pattern) => pattern.test(path));

    for (const path of [
      `${unpacked}/omnyo-app/app/dist/assets/AddMachineDialog.js.br`,
      `${unpacked}/omnyo-app/app/dist/assets/AddMachineDialog.js.gz`,
      `${framework}/Resources/en.lproj/locale.pak`,
      `${framework}/Resources/v8_context_snapshot.arm64.bin`,
      `${framework}/Resources/icudtl.dat`,
      `${app}/Resources/app.asar`,
      `${unpacked}/node-pty/prebuilds/win32-x64/conpty.node`,
      `${unpacked}/node-pty/prebuilds/linux-x64/pty.node`,
      `${unpacked}/fs-native-extensions/prebuilds/android-arm64/fs-native-extensions.bare`,
      `${unpacked}/omnyo-app/server/dist/builtin-plugins/local-voice/dist/local-voice-native/OmnyoLocalVoice`,
      `${unpacked}/omnyo-app/server/dist/builtin-plugins/canvas/dist/media-codec/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node`,
    ])
      expect(ignored(path), path).toBe(true);

    for (const path of [
      `${unpacked}/omnyo-app/node_modules/npm/node_modules/example/addon.node`,
      `${unpacked}/node-pty/prebuilds/darwin-arm64/pty.node`,
      `${unpacked}/node-pty/prebuilds/darwin-arm64/spawn-helper`,
      `${unpacked}/better-sqlite3/prebuilds/darwin-arm64.node`,
      `${unpacked}/@parcel/watcher-darwin-arm64/watcher.node`,
      `${unpacked}/fs-native-extensions/prebuilds/darwin-arm64/fs-native-extensions.bare`,
      `${unpacked}/fs-native-extensions/prebuilds/darwin-arm64/fs-native-extensions.node`,
      `${framework}/Electron Framework`,
      `${framework}/Libraries/libffmpeg.dylib`,
      `${framework}/Helpers/chrome_crashpad_handler`,
      `${app}/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`,
      `${app}/Frameworks/Omnyo Helper (Renderer).app/Contents/MacOS/Omnyo Helper (Renderer)`,
      `${app}/Frameworks/Omnyo Helper (Renderer).app`,
      `${app}/Frameworks/Electron Framework.framework`,
      `${app}/MacOS/Omnyo`,
    ])
      expect(ignored(path), path).toBe(false);
  });

  it("packages a Linux AppImage for x64", async () => {
    const config = await readStaticConfig();

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "omnyo-private",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const config = await readStaticConfig();

    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("prints numeric native version/build and feed-safe private artifact names", async () => {
    const { config } = await readResolvedConfig({});

    const logical = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
        ),
      ).version;

    const native = logical.split("+")[0];
    expect(config.appId).toBe("dev.omnyo.private");
    expect(config.productName).toBe("Omnyo");
    expect(config.mac.bundleShortVersion).toBe(native);
    const buildNumber = logical.split("+private.")[1] ?? "0";
    expect(config.mac.bundleVersion).toBe(macBundleVersion(logical));
    expect(config).toMatchObject({
      buildNumber,
      buildVersion: native + "." + buildNumber,
    });
    expect(config.artifactName).toBe(
      "omnyo-private-" + native + "-${arch}.${ext}",
    );
  });

  it("keeps private binary publication disabled", async () => {
    const config = await readStaticConfig();

    expect(config.publish).toEqual([]);
  });

  it("creates a separate nightly app identity and update feed", async () => {
    const { config } = await readResolvedConfig({
      OMNYO_DESKTOP_RELEASE_CHANNEL: "nightly",
    });

    const nightlyRelease = createDesktopReleaseInfo("nightly");

    const logicalVersion = z
      .string()
      .parse(
        desktopPackageJsonSchema.parse(
          JSON.parse(
            await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
          ),
        ).version,
      );

    const nativeVersion = logicalVersion.split("+")[0];

    expect(config.appId).toBe("dev.omnyo.private.nightly");
    expect(config.productName).toBe("Omnyo Nightly");
    expect(config.artifactName).toBe(
      "omnyo-private-nightly-" + nativeVersion + "-${arch}.${ext}",
    );
    expect(config.linux.icon).toBe("assets/icon-nightly.png");
    expect(config.linux.executableName).toBe("omnyo-private-nightly");
    expect(config.mac.icon).toBe("assets/icon-nightly.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/icon-nightly.png")),
    ).resolves.toBeUndefined();
    expect(config.publish).toEqual([]);
    expect(nightlyRelease.channel).toBe("nightly");
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      OMNYO_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "OMNYO_DESKTOP_RELEASE_CHANNEL must be latest, nightly or public-beta",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(true);
    expect(completeAppleCredentials.config.dmg.sign).toBe(false);
  });
});

for (const scenario of [
  {
    name: "missing-digest",
    args: [
      "--protected-store-build-job",
      "/unselected/desktop-protected-store-build-v1.json",
    ],
    message: "Protected-store build job requires its exact digest",
  },
  {
    name: "unselected-windows",
    args: [
      "--win",
      "--protected-store-build-job",
      "/unselected/desktop-protected-store-build-v1.json",
      "--protected-store-build-job-sha256",
      "a".repeat(64),
    ],
    message: "Protected-store build job requires the selected Mac surface",
  },
]) {
  it(
    "refuses protected-store build arguments before any signing: " +
      scenario.name,
    async () => {
      const result = await runConfigScript({}, scenario.args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(scenario.message);
      expect(result.stdout).toBe("");
    },
  );
}
