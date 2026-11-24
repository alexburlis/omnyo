import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCliConfig } from "../src/cli.js";
import { loadCommonConfig } from "../src/common.js";
import { loadDatabaseConfig } from "../src/database.js";
import { loadDevAppConfig } from "../src/dev-app.js";
import { loadHostDaemonEntrypointConfig } from "../src/host-daemon-entrypoint.js";
import {
  loadHostDaemonConfig,
  loadHostDaemonConnectionConfig,
  loadHostDaemonErrorReportingConfig,
  loadHostDaemonStartConfig,
} from "../src/host-daemon.js";
import { loadLoggerConfig } from "../src/logger.js";
import {
  resolveConfiguredDataDir,
  parsePortValue,
  resolvePortFromEnv,
  resolveRuntimeDataDir,
} from "../src/runtime.js";
import { loadServerPortConfig } from "../src/server-port.js";
import { loadServerConfig } from "../src/server.js";
import { loadViteDevConfig } from "../src/vite-dev.js";

function withCliHome(run: (homeDir: string) => void): void {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "omnyo-cli-config-"));

  try {
    run(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

async function importConfigModules(): Promise<void> {
  vi.resetModules();
  await Promise.all([
    import("../src/cli.js"),
    import("../src/common.js"),
    import("../src/database.js"),
    import("../src/dev-app.js"),
    import("../src/host-daemon-entrypoint.js"),
    import("../src/host-daemon.js"),
    import("../src/logger.js"),
    import("../src/objects.js"),
    import("../src/server-port.js"),
    import("../src/server-url.js"),
    import("../src/server.js"),
    import("../src/vite-dev.js"),
  ]);
}

function createServerRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    OMNYO_DATA_DIR: "/tmp/omnyo-data",
    OMNYO_HOST_DAEMON_PORT: "5555",
    OMNYO_SERVER_PORT: "4444",
    NODE_ENV: "development",
    ...overrides,
  };
}

function createHostDaemonRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    OMNYO_HOST_DAEMON_PORT: "5555",
    OMNYO_SERVER_URL: "http://localhost:4444",
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("config module boundaries", () => {
  it("does not validate environment at import time", async () => {
    await expect(importConfigModules()).resolves.toBeUndefined();
  });
});

describe("common config", () => {
  it("uses the production data dir default in production", () => {
    expect(
      loadCommonConfig({
        env: {
          NODE_ENV: "production",
        },
        homeDir: "/Users/tester",
      }).OMNYO_DATA_DIR,
    ).toBe(path.normalize("/Users/tester/.omnyo"));
  });

  it("requires repoRoot or OMNYO_DATA_DIR for development data dir resolution", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          NODE_ENV: "development",
        },
        homeDir: "/Users/tester",
      }),
    ).toThrow("repoRoot is required to resolve development OMNYO_DATA_DIR");
  });

  it("resolves development defaults from the checkout instance", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/omnyo";

    expect(
      loadCommonConfig({
        env: {
          NODE_ENV: "development",
        },
        homeDir,
        repoRoot,
      }).OMNYO_DATA_DIR,
    ).toBe(path.normalize("/Users/tester/.omnyo-dev/src-omnyo-8e48821ec67b"));
  });

  it("expands home-directory overrides for OMNYO_DATA_DIR", () => {
    expect(
      loadCommonConfig({
        env: {
          OMNYO_DATA_DIR: "~/custom-omnyo",
          NODE_ENV: "production",
        },
      }).OMNYO_DATA_DIR,
    ).toBe(path.join(os.homedir(), "custom-omnyo"));
  });

  it.runIf(process.platform === "win32")(
    "expands a home-directory override written with a backslash on Windows",
    () => {
      expect(
        loadCommonConfig({
          env: {
            OMNYO_DATA_DIR: "~\\custom-omnyo",
            NODE_ENV: "production",
          },
        }).OMNYO_DATA_DIR,
      ).toBe(path.join(os.homedir(), "custom-omnyo"));
    },
  );

  it("rejects whitespace-only OMNYO_DATA_DIR overrides", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          OMNYO_DATA_DIR: "   ",
          NODE_ENV: "production",
        },
      }),
    ).toThrow("OMNYO_DATA_DIR must not be empty");
  });

  it("rejects unsupported OMNYO_LOG_LEVEL overrides", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          OMNYO_LOG_LEVEL: "bogus",
          NODE_ENV: "production",
        },
      }),
    ).toThrow(/OMNYO_LOG_LEVEL/u);
  });
});

describe("data-dir helpers", () => {
  it("expands a bare home-directory override", () => {
    expect(
      resolveConfiguredDataDir({
        defaultDataDir: path.join(os.homedir(), ".omnyo"),
        env: {
          OMNYO_DATA_DIR: "~",
        },
        homeDir: os.homedir(),
      }),
    ).toBe(os.homedir());
  });

  it("rejects whitespace-only data dir overrides", () => {
    expect(() =>
      resolveConfiguredDataDir({
        defaultDataDir: path.join(os.homedir(), ".omnyo"),
        env: {
          OMNYO_DATA_DIR: " ",
        },
        homeDir: os.homedir(),
      }),
    ).toThrow("OMNYO_DATA_DIR must not be empty");
  });

  it("resolves development defaults from the current checkout instance", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/omnyo";

    expect(
      resolveRuntimeDataDir({
        env: {},
        homeDir,
        mode: "dev",
        repoRoot,
      }),
    ).toBe(path.normalize("/Users/tester/.omnyo-dev/src-omnyo-8e48821ec67b"));
  });

  it("keeps the legacy fallback label for degenerate checkout labels", () => {
    expect(
      resolveRuntimeDataDir({
        env: {},
        homeDir: "/Users/tester",
        mode: "dev",
        repoRoot: "/Users/tester/---",
      }),
    ).toBe(path.normalize("/Users/tester/.omnyo-dev/worktree-41987f975862"));
  });
});

describe("port helpers", () => {
  it("accepts the TCP port boundary values", () => {
    expect(
      parsePortValue({
        name: "OMNYO_SERVER_PORT",
        rawPort: "1",
      }),
    ).toBe(1);
    expect(
      parsePortValue({
        name: "OMNYO_SERVER_PORT",
        rawPort: "65535",
      }),
    ).toBe(65_535);
  });

  it("rejects malformed or out-of-range port values", () => {
    for (const rawPort of [
      "",
      " ",
      "0",
      "-1",
      "65536",
      "70000",
      "abc",
      "08",
      "4444.0",
      " 4444",
      "4444 ",
    ]) {
      expect(() =>
        parsePortValue({
          name: "OMNYO_SERVER_PORT",
          rawPort,
        }),
      ).toThrow("OMNYO_SERVER_PORT must be a valid TCP port");
    }
  });

  it("uses the default port only when the env var is unset", () => {
    expect(
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {},
        name: "OMNYO_SERVER_PORT",
      }),
    ).toBe(4444);

    expect(() =>
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {
          OMNYO_SERVER_PORT: "",
        },
        name: "OMNYO_SERVER_PORT",
      }),
    ).toThrow("OMNYO_SERVER_PORT must be a valid TCP port");
  });

  it("rejects whitespace-padded port env values through every port loader path", () => {
    expect(() =>
      loadServerPortConfig({
        env: {
          OMNYO_SERVER_PORT: " 4444",
          NODE_ENV: "development",
        },
      }),
    ).toThrow("OMNYO_SERVER_PORT must be a valid TCP port");

    expect(() =>
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {
          OMNYO_SERVER_PORT: " 4444",
        },
        name: "OMNYO_SERVER_PORT",
      }),
    ).toThrow("OMNYO_SERVER_PORT must be a valid TCP port");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          OMNYO_HOST_DAEMON_PORT: " 5555",
        }),
      }),
    ).toThrow("OMNYO_HOST_DAEMON_PORT must be a valid TCP port");
  });
});

describe("consumer-specific config", () => {
  it("ignores inherited collection configuration for public beta coordinator and daemon", () => {
    const args = {
      mode: "prod" as const,
      homeDir: "/synthetic",
      env: {
        OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
        OMNYO_TELEMETRY: "true",
        OMNYO_USAGE_COLLECTOR_URL: "https://collector.invalid",
        OMNYO_SENTRY_DSN: "https://inherited@sentry.invalid/42",
      },
    };

    expect(loadServerConfig(args).OMNYO_SENTRY_DSN).toBe("");
    expect(loadServerConfig(args).OMNYO_TELEMETRY).toBe(false);
    expect(loadHostDaemonErrorReportingConfig(args).OMNYO_SENTRY_DSN).toBe("");
  });

  it("treats an empty or blank host daemon release as a development run", () => {
    for (const version of ["", "   "]) {
      expect(
        loadHostDaemonErrorReportingConfig({
          env: { OMNYO_APP_VERSION: version, OMNYO_SENTRY_DSN: "" },
        }),
      ).toEqual({ OMNYO_APP_VERSION: "0.0.0-dev", OMNYO_SENTRY_DSN: "" });
    }

    expect(
      loadHostDaemonErrorReportingConfig({
        env: {
          OMNYO_APP_VERSION: " 0.46.293+private.1 ",
          OMNYO_SENTRY_DSN: "",
        },
      }).OMNYO_APP_VERSION,
    ).toBe("0.46.293+private.1");
  });

  it("builds server config from explicit runtime env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_URL: undefined,
        OMNYO_APP_VERSION: undefined,
        OMNYO_EXTERNAL_URL: undefined,
        OMNYO_FF_PLACEHOLDER: undefined,
      }),
    });

    expect(serverConfig.OMNYO_PERF_DIAGNOSTICS).toBe(false);
    expect(serverConfig.OMNYO_SERVER_PORT).toBe(4444);
    expect(serverConfig.OMNYO_HOST_DAEMON_PORT).toBe(5555);
    expect(serverConfig.databasePath).toBe(
      path.resolve("/tmp/omnyo-data/app.db"),
    );
    expect(serverConfig.OMNYO_APP_URL).toBe("");
    expect(serverConfig.OMNYO_APP_SURFACE).toBe("web");
    expect(serverConfig.OMNYO_APP_VERSION).toBe("0.0.0-dev");
    expect(serverConfig.OMNYO_EXTERNAL_URL).toBe("");
    expect(serverConfig.featureFlags).toEqual({
      placeholder: false,
      timelineWindowEventBudget: 1_500,
    });
  });

  it("validates the opt-in performance diagnostics setting", () => {
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_PERF_DIAGNOSTICS: "1" }),
      }).OMNYO_PERF_DIAGNOSTICS,
    ).toBe(true);
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_PERF_DIAGNOSTICS: "typo" }),
      }),
    ).toThrow("OMNYO_PERF_DIAGNOSTICS must be a boolean");
  });

  it("carries the launcher's server launch id only when it is set", () => {
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_SERVER_LAUNCH_ID: undefined }),
      }),
    ).not.toHaveProperty("OMNYO_SERVER_LAUNCH_ID");
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_SERVER_LAUNCH_ID: "launch-123" }),
      }).OMNYO_SERVER_LAUNCH_ID,
    ).toBe("launch-123");
  });

  it("carries the launcher's in-app update mode and rejects unknown modes", () => {
    expect(
      loadServerConfig({ env: createServerRuntimeEnv({}) }),
    ).not.toHaveProperty("OMNYO_APP_UPDATE_MODE");
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_APP_UPDATE_MODE: "source" }),
      }).OMNYO_APP_UPDATE_MODE,
    ).toBe("source");
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({ OMNYO_APP_UPDATE_MODE: "brew" }),
      }),
    ).toThrow("OMNYO_APP_UPDATE_MODE must be one of npm, source");
  });

  it("defaults the server bind host to loopback", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_SERVER_BIND_HOST: undefined,
      }),
    });

    expect(serverConfig.OMNYO_SERVER_BIND_HOST).toBe("127.0.0.1");
  });

  it("honors an explicit wildcard server bind host", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_SERVER_BIND_HOST: "0.0.0.0",
      }),
    });

    expect(serverConfig.OMNYO_SERVER_BIND_HOST).toBe("0.0.0.0");
  });

  it("rejects an unsupported server bind host", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_SERVER_BIND_HOST: "localhost",
        }),
      }),
    ).toThrow(/OMNYO_SERVER_BIND_HOST/u);
  });

  it("parses the placeholder feature flag from env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_FF_PLACEHOLDER: "true",
      }),
    });

    expect(serverConfig.featureFlags.placeholder).toBe(true);
  });

  it("parses the timeline window event budget from env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET: "4000",
      }),
    });

    expect(serverConfig.featureFlags.timelineWindowEventBudget).toBe(4000);
  });

  it("rejects a non-positive timeline window event budget", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET: "0",
        }),
      }),
    ).toThrow(/positive integer/);
  });

  it("rejects invalid feature flag booleans in server config", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_FF_PLACEHOLDER: "not-bool",
        }),
      }),
    ).toThrow(/OMNYO_FF_PLACEHOLDER/u);
  });

  it("uses 0.0.0-dev as the default OMNYO_APP_VERSION in production", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_VERSION: undefined,
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.OMNYO_APP_VERSION).toBe("0.0.0-dev");
  });

  it("honors an explicit OMNYO_APP_VERSION env override", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_VERSION: "0.1.2",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.OMNYO_APP_VERSION).toBe("0.1.2");
  });

  it("parses the internal app surface marker for server telemetry", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_SURFACE: "desktop",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.OMNYO_APP_SURFACE).toBe("desktop");

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_APP_SURFACE: "mobile",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow("OMNYO_APP_SURFACE must be one of desktop, web");
  });

  it("lets tooling read the server port without validating unrelated server env", () => {
    const serverPortConfig = loadServerPortConfig({
      env: {
        OMNYO_EXTERNAL_URL: "not-a-url",
        OMNYO_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(serverPortConfig.OMNYO_SERVER_PORT).toBe(4444);
  });

  it("validates server port env at loader call time", () => {
    expect(() =>
      loadServerPortConfig({
        env: {
          NODE_ENV: "development",
        },
      }),
    ).toThrow(/OMNYO_SERVER_PORT/u);
  });

  it("derives the database path from data dir without validating unrelated server env", () => {
    const databaseConfig = loadDatabaseConfig({
      env: {
        OMNYO_DATA_DIR: "/tmp/omnyo-data",
        OMNYO_EXTERNAL_URL: "not-a-url",
        NODE_ENV: "development",
      },
    });

    expect(databaseConfig.databasePath).toBe(
      path.resolve("/tmp/omnyo-data/app.db"),
    );
  });

  it("requires a valid server URL for the daemon and CLI", () => {
    const env = createHostDaemonRuntimeEnv({
      OMNYO_SERVER_URL: "http://localhost:9999",
    });

    const hostDaemonConfig = loadHostDaemonConnectionConfig({ env });
    const cliConfig = loadCliConfig({ env });

    expect(hostDaemonConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          OMNYO_SERVER_URL: "not-a-url",
        }),
      }),
    ).toThrow(/OMNYO_SERVER_URL/u);
  });

  it("normalizes server URL whitespace consistently for the daemon and CLI", () => {
    const env = createHostDaemonRuntimeEnv({
      OMNYO_SERVER_URL: " http://localhost:9999 ",
    });

    const hostDaemonConfig = loadHostDaemonConnectionConfig({ env });
    const cliConfig = loadCliConfig({ env });

    expect(hostDaemonConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          OMNYO_SERVER_URL: "   ",
        }),
      }),
    ).toThrow("OMNYO_SERVER_URL must not be empty");
  });

  it("validates host-daemon connection config without requiring data dir", () => {
    const hostDaemonConfig = loadHostDaemonConnectionConfig({
      env: {
        OMNYO_HOST_DAEMON_PORT: "3999",
        OMNYO_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");
    expect(hostDaemonConfig.OMNYO_HOST_DAEMON_PORT).toBe(3999);
  });

  it("validates explicit host-daemon ports with the shared port validator", () => {
    expect(() =>
      loadHostDaemonConnectionConfig({
        env: {
          OMNYO_SERVER_URL: "http://localhost:9999",
          NODE_ENV: "development",
        },
        hostDaemonPort: 0,
      }),
    ).toThrow("OMNYO_HOST_DAEMON_PORT must be a valid TCP port");
  });

  it("builds full host-daemon config when the daemon entrypoint owns data dir", () => {
    const hostDaemonConfig = loadHostDaemonConfig({
      env: {
        OMNYO_DATA_DIR: "/tmp/omnyo-data",
        OMNYO_HOST_DAEMON_PORT: "3999",
        OMNYO_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonConfig.OMNYO_DATA_DIR).toBe(
      path.resolve("/tmp/omnyo-data"),
    );
    expect(hostDaemonConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");
    expect(hostDaemonConfig.OMNYO_HOST_DAEMON_PORT).toBe(3999);
  });

  it("builds host-daemon start config from full config when data dir is not provided", () => {
    const hostDaemonStartConfig = loadHostDaemonStartConfig({
      env: {
        OMNYO_DATA_DIR: "/tmp/omnyo-data",
        OMNYO_HOST_DAEMON_PORT: "3999",
        OMNYO_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonStartConfig.dataDir).toBe(path.resolve("/tmp/omnyo-data"));
    expect(hostDaemonStartConfig.connectionConfig.OMNYO_SERVER_URL).toBe(
      "http://localhost:9999",
    );
    expect(hostDaemonStartConfig.connectionConfig.OMNYO_HOST_DAEMON_PORT).toBe(
      3999,
    );
  });

  it("builds logger config from an explicit data dir without resolving OMNYO_DATA_DIR", () => {
    const loggerConfig = loadLoggerConfig({
      dataDir: "/tmp/logger-data",
      env: {
        NODE_ENV: "development",
      },
    });

    expect(loggerConfig.OMNYO_DATA_DIR).toBe("/tmp/logger-data");
    expect(loggerConfig.OMNYO_LOG_LEVEL).toBe("debug");
  });

  it("defaults CLI connection to the local app only without a saved selection", () => {
    withCliHome((homeDir) => {
      const cliConfig = loadCliConfig({
        env: { NODE_ENV: "development" },
        homeDir,
      });

      expect(cliConfig.OMNYO_SERVER_URL).toBe("http://127.0.0.1:38886");
      expect(cliConfig.OMNYO_HOST_DAEMON_PORT).toBe(38887);
    });
  });

  it("lets explicit CLI env overrides win over NODE_ENV-selected defaults", () => {
    const cliConfig = loadCliConfig({
      env: {
        OMNYO_HOST_DAEMON_PORT: "3999",
        OMNYO_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(cliConfig.OMNYO_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.OMNYO_HOST_DAEMON_PORT).toBe(3999);
  });

  it("allows app and external URLs to be omitted in production server config", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_URL: undefined,
        OMNYO_EXTERNAL_URL: undefined,
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.OMNYO_APP_URL).toBe("");
    expect(serverConfig.OMNYO_EXTERNAL_URL).toBe("");
  });

  it("validates app and external URLs independently", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        OMNYO_APP_URL: "https://app.example.test",
        OMNYO_EXTERNAL_URL: "https://external.example.test",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.OMNYO_APP_URL).toBe("https://app.example.test");
    expect(serverConfig.OMNYO_EXTERNAL_URL).toBe(
      "https://external.example.test",
    );

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_APP_URL: "not-a-url",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow(/OMNYO_APP_URL/u);

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          OMNYO_APP_URL: "https://app.example.test",
          OMNYO_EXTERNAL_URL: "not-a-url",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow(/OMNYO_EXTERNAL_URL/u);
  });

  it("reads dev app host from its dedicated config scope", () => {
    const devAppConfig = loadDevAppConfig({
      env: {
        OMNYO_DEV_APP_HOST: "0.0.0.0",
        NODE_ENV: "development",
      },
    });

    expect(devAppConfig.OMNYO_DEV_APP_HOST).toBe("0.0.0.0");
    expect(devAppConfig.OMNYO_DEV_APP_PORT).toBeUndefined();
  });

  it("builds app Vite dev config from the app dev entrypoint scope", () => {
    const defaultViteDevConfig = loadViteDevConfig({
      env: {
        OMNYO_DEV_APP_PORT: "4173",
        OMNYO_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(defaultViteDevConfig).toEqual({
      appHost: "127.0.0.1",
      appPort: 4173,
      serverHttpOrigin: "http://127.0.0.1:4444",
      serverPort: 4444,
    });

    const explicitViteDevConfig = loadViteDevConfig({
      env: {
        OMNYO_DEV_APP_HOST: "0.0.0.0",
        OMNYO_DEV_APP_PORT: "4173",
        OMNYO_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(explicitViteDevConfig.appHost).toBe("0.0.0.0");
  });

  it("requires the app dev port for Vite dev config", () => {
    expect(() =>
      loadViteDevConfig({
        env: {
          OMNYO_SERVER_PORT: "4444",
          NODE_ENV: "development",
        },
      }),
    ).toThrow("OMNYO_DEV_APP_PORT is required to run the app dev server");
  });

  it("parses optional host-daemon entrypoint env vars in one place", () => {
    const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig({
      env: {
        OMNYO_BRIDGE_DIR: " /tmp/bridges ",
        OMNYO_CLI_DIR: " /tmp/omnyo-bin ",
        OMNYO_HOST_ENROLL_KEY: " enroll-token ",
        OMNYO_HOST_DAEMON_AUTO_UPDATE: "true",
        OMNYO_HOST_ID: " host-123 ",
      },
    });

    expect(hostDaemonEntrypointConfig).toEqual({
      OMNYO_BRIDGE_DIR: "/tmp/bridges",
      OMNYO_CLI_DIR: "/tmp/omnyo-bin",
      OMNYO_HOST_ENROLL_KEY: "enroll-token",
      OMNYO_HOST_DAEMON_AUTO_UPDATE: true,
      OMNYO_HOST_ID: "host-123",
    });
  });

  it("drops empty optional host-daemon entrypoint env vars", () => {
    const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig({
      env: {
        OMNYO_BRIDGE_DIR: "",
        OMNYO_CLI_DIR: "   ",
        OMNYO_HOST_ENROLL_KEY: " ",
      },
    });

    expect(hostDaemonEntrypointConfig).toEqual({});
  });
});

describe("CLI saved server selection", () => {
  it.each(["production", "development"])(
    "uses saved selection for standalone %s commands without rewriting it",
    (nodeEnv) => {
      withCliHome((homeDir) => {
        mkdirSync(path.join(homeDir, ".omnyo"));
        const file = path.join(homeDir, ".omnyo", "config.json");

        const contents = JSON.stringify({
          serverUrl: "https://saved.example.test",
        });

        writeFileSync(file, contents);
        writeFileSync(
          path.join(homeDir, ".omnyo", "app-runtime.json"),
          JSON.stringify({ serverUrl: "http://127.0.0.1:38886" }),
        );
        expect(loadCliConfig({ env: { NODE_ENV: nodeEnv }, homeDir })).toEqual({
          OMNYO_SERVER_URL: "https://saved.example.test",
          OMNYO_HOST_DAEMON_PORT: 38887,
        });
        expect(readFileSync(file, "utf8")).toBe(contents);
      });
    },
  );

  it("uses only the selected data directory", () => {
    withCliHome((homeDir) => {
      mkdirSync(path.join(homeDir, ".omnyo"));
      writeFileSync(
        path.join(homeDir, ".omnyo", "config.json"),
        "invalid home config",
      );
      const dataDir = path.join(homeDir, "selected");
      mkdirSync(dataDir);
      const file = path.join(dataDir, "config.json");
      writeFileSync(
        file,
        JSON.stringify({ serverUrl: "https://selected.example.test" }),
      );
      const args = { env: { OMNYO_DATA_DIR: "~/selected" }, homeDir };
      expect(loadCliConfig(args).OMNYO_SERVER_URL).toBe(
        "https://selected.example.test",
      );
      writeFileSync(file, "{}");
      expect(loadCliConfig(args).OMNYO_SERVER_URL).toBe(
        "http://127.0.0.1:38886",
      );
    });
  });

  it("does not read saved config when an override or repository development target wins", () => {
    withCliHome((homeDir) => {
      mkdirSync(path.join(homeDir, ".omnyo"));
      writeFileSync(
        path.join(homeDir, ".omnyo", "config.json"),
        "invalid saved config",
      );
      expect(
        loadCliConfig({
          env: { OMNYO_SERVER_URL: "https://override.example.test" },
          homeDir,
        }).OMNYO_SERVER_URL,
      ).toBe("https://override.example.test");

      const development = loadCliConfig({
        env: {},
        mode: "dev",
        repoRoot: "/Users/tester/src/omnyo",
        homeDir,
      });

      expect(development.OMNYO_SERVER_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/,
      );
      expect(development.OMNYO_HOST_DAEMON_PORT).not.toBe(38887);
    });
  });

  it.each(["", "   ", "synthetic-sensitive-invalid-url"])(
    "rejects a present invalid override without printing its value (%j)",
    (value) => {
      withCliHome((homeDir) => {
        expect(() =>
          loadCliConfig({ env: { OMNYO_SERVER_URL: value }, homeDir }),
        ).toThrow(
          new Error(
            value.trim() === ""
              ? "OMNYO_SERVER_URL must not be empty"
              : "Invalid OMNYO_SERVER_URL; expected a non-empty URL",
          ),
        );
      });
    },
  );

  it.each(["malformed", "schema", "invalid-url", "unreadable"])(
    "fails visibly and safely on %s saved configuration",
    (kind) => {
      withCliHome((homeDir) => {
        const dataDir = path.join(homeDir, ".omnyo");
        mkdirSync(dataDir);
        const file = path.join(dataDir, "config.json");

        if (kind === "unreadable") mkdirSync(file);
        else
          writeFileSync(
            file,
            kind === "malformed"
              ? '{"machineCredential":"synthetic-sensitive-config-field"'
              : JSON.stringify(
                  kind === "schema"
                    ? {
                        serverUrl: 42,
                        machineCredential: "synthetic-sensitive-config-field",
                      }
                    : { serverUrl: "synthetic-sensitive-invalid-url" },
                ),
          );
        expect(() => loadCliConfig({ env: {}, homeDir })).toThrow(
          new Error(
            `Cannot load saved Omnyo CLI server selection from ${file}`,
          ),
        );
      });
    },
  );
});
