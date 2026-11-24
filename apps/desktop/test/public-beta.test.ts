import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { build, transformSync } from "esbuild";
import { publicBetaCollectionPlugins } from "../../../scripts/public-beta-collection.mjs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicBetaEnvironment } from "../src/public-beta.js";
import { buildDesktopAboutDetails } from "../src/desktop-about-panel.js";
import { createOmnyoAppProcessEnv } from "../src/app-process.js";
import {
  createDesktopReleaseInfo,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";
import {
  createDesktopReleaseConfig,
  desktopBuildSelection,
} from "../scripts/desktop-release-channel.mjs";

describe("local public beta isolation", () => {
  it("removes the reporting destination from beta bundle bytes and overrides inherited configuration", async () => {
    const bundled = await build({
      stdin: {
        contents:
          'export { loadServerConfig } from "./packages/config/src/server.ts"; export { loadHostDaemonErrorReportingConfig } from "./packages/config/src/host-daemon.ts";',
        resolveDir: resolve(__dirname, "../../.."),
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      define: {
        "import.meta.url": JSON.stringify(pathToFileURL(__filename).href),
      },
      sourcemap: "inline",
      plugins: publicBetaCollectionPlugins({
        OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
      }),
    });

    const code = bundled.outputFiles[0]?.text;
    expect(code).toBeDefined();
    expect(code).not.toContain("ingest.de.sentry.io");
    const sourceMap = code?.split("base64,").at(-1)?.trim();
    expect(Buffer.from(sourceMap ?? "", "base64").toString()).not.toContain(
      "ingest.de.sentry.io",
    );

    const module = {
      exports: {} as {
        loadServerConfig: (args: unknown) => {
          OMNYO_SENTRY_DSN: string;
          OMNYO_TELEMETRY: boolean;
        };
        loadHostDaemonErrorReportingConfig: (args: unknown) => {
          OMNYO_SENTRY_DSN: string;
        };
      },
    };

    runInNewContext(code ?? "", {
      module,
      exports: module.exports,
      require: createRequire(__filename),
      process,
      Error,
      URL,
    });

    const args = {
      mode: "prod",
      homeDir: "/synthetic",
      env: {
        OMNYO_SENTRY_DSN: "https://inherited@sentry.invalid/42",
        OMNYO_TELEMETRY: "true",
        OMNYO_USAGE_COLLECTOR_URL: "https://collector.invalid",
      },
    };

    expect(module.exports.loadServerConfig(args).OMNYO_SENTRY_DSN).toBe("");
    expect(module.exports.loadServerConfig(args).OMNYO_TELEMETRY).toBe(false);
    expect(
      module.exports.loadHostDaemonErrorReportingConfig(args).OMNYO_SENTRY_DSN,
    ).toBe("");
  });

  it("replaces inherited private data and reporting before the child launch", () => {
    const env = createOmnyoAppProcessEnv({
      runtimeMode: "electron-node",
      env: {
        OMNYO_DATA_DIR: "/private-fixture",
        OMNYO_SERVER_PORT: "4000",
        OMNYO_HOST_DAEMON_PORT: "38888",
        OMNYO_SENTRY_DSN: "inherited",
        OMNYO_POSTHOG_API_KEY: "inherited",
        OMNYO_TELEMETRY: "true",
        ...createPublicBetaEnvironment("/synthetic/Omnyo"),
      },
    });

    expect(env).toMatchObject({
      OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
      OMNYO_DATA_DIR: "/synthetic/Omnyo/local-instance",
      OMNYO_SERVER_PORT: "47431",
      OMNYO_HOST_DAEMON_PORT: "47434",
      OMNYO_SERVER_BIND_HOST: "127.0.0.1",
      OMNYO_TELEMETRY: "false",
      OMNYO_SENTRY_DSN: "",
      OMNYO_POSTHOG_API_KEY: "",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(
      createOmnyoAppProcessEnv({
        runtimeMode: "electron-node",
        env: { OMNYO_HOST_DAEMON_PORT: "38888" },
      }).OMNYO_HOST_DAEMON_PORT,
    ).toBe("38888");
  });
  it("uses a dedicated macOS identity and profile", () => {
    expect(createDesktopReleaseConfig("public-beta", "macos")).toMatchObject({
      appId: "dev.omnyo.beta",
      applicationName: "Omnyo",
      profileName: "Omnyo",
      artifactName: "omnyo-${version}-${arch}.${ext}",
    });
    expect(createDesktopReleaseInfo("public-beta")).toMatchObject({
      applicationName: "Omnyo",
      profileName: "Omnyo",
    });
    expect(() =>
      createDesktopReleaseConfig("public-beta", "windows"),
    ).toThrow();
    expect(resolveDesktopUpdateSupport()).toEqual({
      autoUpdate: false,
      versionCheck: false,
    });
  });
  it("shows the public app as a stable build without beta wording", () => {
    const details = buildDesktopAboutDetails(
      {
        applicationName: "Omnyo",
        buildDate: "",
        channel: "public-beta",
        commit: "",
        electronVersion: "",
        osArch: "arm64",
        osRelease: "",
        osType: "Darwin",
        platform: "darwin",
        pluginSdkVersion: "",
        version: "0.46.359",
      },
      null,
    );

    expect(details).toContain("Build Type: Stable");
    expect(details).not.toMatch(/beta|unavailable/iu);
  });
});

describe("beta private-continuity exclusion", () => {
  it("selects separate compiler output and leaves private qualification enabled", () => {
    expect(desktopBuildSelection("public-beta")).toMatchObject({
      privateContinuity: false,
      outputDirectory: "dist-public-beta",
    });

    for (const channel of ["latest", "nightly"] as const)
      expect(desktopBuildSelection(channel)).toEqual({
        privateContinuity: true,
        outputDirectory: "dist",
        excludedArtifacts: [],
      });
  });
  it("refuses private entry modes before loading any consumer", () => {
    const startup = transformSync(
      readFileSync(resolve(__dirname, "../src/startup.ts"), "utf8"),
      {
        loader: "ts",
        format: "cjs",
        define: {
          "process.env.OMNYO_DESKTOP_RELEASE_CHANNEL":
            JSON.stringify("public-beta"),
        },
      },
    ).code;

    for (const flag of [
      "--omnyo-profile-continuity-v2",
      "--omnyo-profile-adoption-v1",
      "--omnyo-electron-trust-probe",
    ]) {
      const loaded: string[] = [];
      const messages: string[] = [];
      expect(() =>
        runInNewContext(startup, {
          process: {
            argv: ["electron", flag],
            stderr: {
              write(message: string) {
                messages.push(message);
              },
            },
            exit(code: number) {
              throw new Error("beta-exit-" + code);
            },
          },
          require(name: string) {
            loaded.push(name);

            return {};
          },
        }),
      ).toThrow("beta-exit-2");
      expect(messages.join("")).toContain(
        "unavailable in the public Omnyo app",
      );
      expect(loaded.filter((name) => name.startsWith("./"))).toEqual([]);
    }
  });
  it("packages only beta output and rejects private build jobs", () => {
    const script = resolve(__dirname, "../scripts/run-electron-builder.mjs");

    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
    };

    const config = JSON.parse(
      execFileSync(
        process.execPath,
        [script, "--mac", "--arm64", "--print-config"],
        { env, timeout: 4000, encoding: "utf8" },
      ),
    );

    const localRequire = createRequire(resolve(__dirname, "../package.json"));

    const builderRequire = createRequire(
      localRequire.resolve("electron-builder"),
    );

    const { getFileMatchers } = builderRequire(
      "app-builder-lib/out/fileMatcher",
    );

    const root = resolve(__dirname, "..");

    const filter = getFileMatchers(
      config,
      "asarUnpack",
      "/synthetic/destination",
      {
        macroExpander: (value: string) => value,
        defaultSrc: root,
        customBuildOptions: {},
        globalOutDir: resolve(root, "release"),
      },
    )[0].createFilter();

    const bridge = resolve(root, "dist-public-beta/omnyo-app-bridge.mjs");
    expect(filter(bridge, statSync(script))).toBe(true);

    expect(config.productName).toBe("Omnyo");
    expect(config.extraMetadata.productName).toBe("Omnyo");
    expect(config.appId).toBe("dev.omnyo.beta");
    expect(config.artifactName).toMatch(
      /^omnyo-\d+\.\d+\.\d+-\$\{arch\}\.\$\{ext\}$/u,
    );
    expect(config.extraMetadata).not.toHaveProperty("version");
    expect(config.files).not.toContain("dist/**");
    expect(config.files).not.toContain("node_modules/**");
    expect(config.files).toContainEqual({
      from: "../..",
      to: ".",
      filter: ["LICENSE"],
    });
    expect(config.files).toContainEqual({
      from: "dist-public-beta",
      to: "dist",
      filter: [
        "**/*",
        ...desktopBuildSelection("public-beta").excludedArtifacts.map(
          (name) => "!" + name,
        ),
      ],
    });
    expect(() =>
      execFileSync(
        process.execPath,
        [
          script,
          "--mac",
          "--print-config",
          "--protected-store-build-job",
          "/synthetic/private-job",
          "--protected-store-build-job-sha256",
          "a".repeat(64),
        ],
        { env, timeout: 4000, stdio: "pipe" },
      ),
    ).toThrow();
  });
  it("retains production qualification for latest and nightly", () => {
    const script = resolve(__dirname, "../scripts/run-electron-builder.mjs");

    for (const channel of ["latest", "nightly"]) {
      let diagnostic = "";

      try {
        execFileSync(process.execPath, [script, "--mac", "--arm64"], {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            OMNYO_DESKTOP_RELEASE_CHANNEL: channel,
          },
          stdio: "pipe",
          timeout: 4000,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
        )
          diagnostic = error.stderr.toString();
      }

      expect(diagnostic).toContain(
        "Protected-store consumers require configured",
      );
    }
  });
});
