import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveDevInstanceConfig,
  resolveInheritedDevSkillsRootPaths,
  toDevProcessEnv,
} from "@omnyo/config/runtime";
import {
  createStartWorktreeCommand,
  resolveDevCloud,
  resolveDevLaunchMode,
  STAGING_CLOUD_URL,
  toDevLaunchProcessEnv,
} from "../src/commands/run-dev.js";
import {
  expectedDevDataDir,
  expectedDevInstanceId,
  expectedDevPorts,
  expectedDevServerUrl,
} from "./dev-instance-expectations.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run-dev", () => {
  it("derives stable data and ports from a managed checkout", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/.omnyo-dev/projects/env_q7e5i54kxt/omnyo";
    const config = resolveDevInstanceConfig({ homeDir, repoRoot });

    expect(config.instanceId).toBe(
      expectedDevInstanceId({ homeDir, repoRoot }),
    );
    expect(config.dataDir).toBe(expectedDevDataDir({ homeDir, repoRoot }));
    expect(config.ports).toEqual(expectedDevPorts(repoRoot));
    expect(config.serverUrl).toBe(expectedDevServerUrl(repoRoot));
    expect(new Set(Object.values(config.ports))).toHaveLength(5);
    expect(Object.values(config.ports)).not.toContain(5173);
    expect(Object.values(config.ports)).not.toContain(3334);
    expect(Object.values(config.ports)).not.toContain(3002);
    expect(Object.values(config.ports)).not.toContain(38886);
    expect(Object.values(config.ports)).not.toContain(38887);
  });

  it("keeps Cloud gateway ports out of the worker band and packaged ports", () => {
    const rootsByOffset = new Map([
      [0, "/repo/port-13604"],
      [1, "/repo/port-3079"],
      [3886, "/repo/port-3186"],
      [3887, "/repo/port-6427"],
      [7998, "/repo/port-57923"],
      [7999, "/repo/port-7517"],
    ]);

    const portsByOffset = new Map(
      [...rootsByOffset].map(([offset, repoRoot]) => [
        offset,
        resolveDevInstanceConfig({ homeDir: "/Users/tester", repoRoot }).ports,
      ]),
    );

    expect(portsByOffset.get(3886)?.cloudPort).toBe(59000);
    expect(portsByOffset.get(3887)?.cloudPort).toBe(59001);
    expect(portsByOffset.get(7998)?.cloudPort).toBe(42998);
    expect(portsByOffset.get(7999)?.cloudPort).toBe(42999);
    expect(portsByOffset.get(0)?.cloudWorkerPort).toBe(43000);
    expect(portsByOffset.get(1)?.cloudWorkerPort).toBe(43001);
    expect(
      new Set(
        [...portsByOffset.values()].flatMap(
          ({ cloudPort, cloudWorkerPort }) => [cloudPort, cloudWorkerPort],
        ),
      ),
    ).toHaveLength(rootsByOffset.size * 2);
  });

  it("uses the home-relative checkout path for non-managed checkout paths", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/work/omnyo-feature-copy";

    const config = resolveDevInstanceConfig({ homeDir, repoRoot });

    expect(config.instanceId).toBe(
      expectedDevInstanceId({ homeDir, repoRoot }),
    );
  });

  it("overrides instance selectors while preserving unrelated environment", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/.omnyo-dev/projects/env_q7e5i54kxt/omnyo",
    });

    const baseEnv: NodeJS.ProcessEnv = {
      OMNYO_DATA_DIR: "/Users/tester/.omnyo-dev",
      OMNYO_SERVER_PORT: "3334",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.OPENAI_API_KEY).toBe("test-key");
    expect(env.NODE_ENV).toBe("development");
    expect(env.OMNYO_DATA_DIR).toBe(config.dataDir);
    expect(env.OMNYO_SERVER_PORT).toBe(String(config.ports.serverPort));
    expect(env.OMNYO_SERVER_URL).toBe(config.serverUrl);
    expect(env.OMNYO_HOST_DAEMON_PORT).toBe(
      String(config.ports.hostDaemonPort),
    );
    expect(env.OMNYO_DEV_APP_PORT).toBe(String(config.ports.appPort));
    expect(env.OMNYO_DEV_CONNECT_BASE_URL).toBe(
      `http://omnyo.localhost:${config.ports.cloudPort}`,
    );
  });

  it("gives dev servers a key-file vault unless the caller chose a key store", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    expect(toDevProcessEnv({ baseEnv: {}, config }).OMNYO_VAULT_KEY_STORE).toBe(
      "key-file",
    );
    expect(
      toDevProcessEnv({
        baseEnv: { OMNYO_VAULT_KEY_STORE: "keychain" },
        config,
      }).OMNYO_VAULT_KEY_STORE,
    ).toBe("keychain");
  });

  it("hands dev children the instance selectors over inherited legacy names", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    const env = toDevProcessEnv({
      baseEnv: {
        BB_LOG_LEVEL: "debug",
        OMNYO_DATA_DIR: "/Users/tester/.omnyo",
        OMNYO_LOG_LEVEL: "debug",
        OMNYO_SERVER_PORT: "3334",
        OMNYO_SERVER_URL: "http://127.0.0.1:3334",
      },
      config,
    });

    expect(env).toMatchObject({
      OMNYO_DATA_DIR: config.dataDir,
      OMNYO_LOG_LEVEL: "debug",
      OMNYO_SERVER_PORT: String(config.ports.serverPort),
      OMNYO_SERVER_URL: config.serverUrl,
    });
  });

  it("inherits parent Omnyo skills for managed worktree dev apps", () => {
    const homeDir = path.resolve("/Users/tester");

    const repoRoot = path.join(
      homeDir,
      ".omnyo-dev/code-omnyo-abc123/worktrees/env_feature/omnyo",
    );

    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    const inheritedSkillsRootPaths = [
      path.join(homeDir, ".omnyo-dev", "code-omnyo-abc123", "skills"),
      path.join(homeDir, ".omnyo", "skills"),
    ];

    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual(
      inheritedSkillsRootPaths,
    );
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      OMNYO_INHERITED_SKILLS_ROOTS: inheritedSkillsRootPaths.join(
        path.delimiter,
      ),
    });
  });

  it("dedupes inherited Omnyo skills for prod-managed worktree dev apps", () => {
    const homeDir = path.resolve("/Users/tester");
    const repoRoot = path.join(homeDir, ".omnyo/worktrees/env_feature/omnyo");

    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual([
      path.join(homeDir, ".omnyo", "skills"),
    ]);
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      OMNYO_INHERITED_SKILLS_ROOTS: path.join(homeDir, ".omnyo", "skills"),
    });
  });

  it("inherits prod Omnyo skills for ordinary checkout dev apps", () => {
    const homeDir = path.resolve("/Users/tester");
    const repoRoot = path.join(homeDir, "src", "omnyo");

    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual([
      path.join(homeDir, ".omnyo", "skills"),
    ]);
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      OMNYO_INHERITED_SKILLS_ROOTS: path.join(homeDir, ".omnyo", "skills"),
    });
  });

  it("strips parent thread context from dev child processes", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    const baseEnv: NodeJS.ProcessEnv = {
      OMNYO_ENVIRONMENT_ID: "env_parent",
      OMNYO_PROJECT_ID: "proj_parent",
      OMNYO_THREAD_ID: "thr_parent",
      OMNYO_THREAD_STORAGE: "/Users/tester/.omnyo/thread-storage/thr_parent",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.OMNYO_ENVIRONMENT_ID).toBeUndefined();
    expect(env.OMNYO_THREAD_ID).toBeUndefined();
    expect(env.OMNYO_THREAD_STORAGE).toBeUndefined();
    expect(env.OMNYO_PROJECT_ID).toBe("proj_parent");
  });

  it("passes the account pool marker to a nested dev server", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    const baseEnv: NodeJS.ProcessEnv = {
      OMNYO_ACCOUNT_POOL_PARENT_URL:
        "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      OMNYO_ACCOUNT_POOL_PARENT_TOKEN: "parent-hub-token",
      ANTHROPIC_BASE_URL:
        "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      ANTHROPIC_AUTH_TOKEN: "parent-hub-token",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.OMNYO_ACCOUNT_POOL_PARENT_URL).toBe(
      "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
    );
    expect(env.OMNYO_ACCOUNT_POOL_PARENT_TOKEN).toBe("parent-hub-token");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("parent-hub-token");
    expect(env.OMNYO_SERVER_URL).toBe(config.serverUrl);
  });

  it("runs the production-style source launcher for worktree start", () => {
    const command = createStartWorktreeCommand();
    expect(createStartWorktreeCommand(false, true).args).toContain(
      "--perf-diagnostics",
    );

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      "--conditions=source",
      "--import",
      "tsx",
      path.resolve(import.meta.dirname, "../../..", "scripts/start-omnyo.mjs"),
      "--worktree-runtime-policy",
    ]);
  });

  it("accepts only the supported dev launch mode", () => {
    expect(resolveDevLaunchMode([])).toBe("vite");
    expect(resolveDevLaunchMode(["--worktree"])).toBe("worktree");
    expect(() => resolveDevLaunchMode(["--watch"])).toThrow(
      "Expected no arguments, --staging, or --worktree",
    );
  });

  it("points Omnyo account and Connect at staging only for pnpm dev --staging", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    expect(resolveDevCloud({ staging: false, mode: "vite" })).toBe("local");
    expect(resolveDevCloud({ staging: true, mode: "vite" })).toBe("staging");
    expect(() => resolveDevCloud({ staging: true, mode: "worktree" })).toThrow(
      "--staging is supported by pnpm dev only",
    );
    expect(
      toDevLaunchProcessEnv({
        baseEnv: {},
        cloud: "staging",
        config,
        mode: "vite",
      }).OMNYO_DEV_CONNECT_BASE_URL,
    ).toBe(STAGING_CLOUD_URL);
    expect(
      toDevLaunchProcessEnv({
        baseEnv: { OMNYO_DEV_CONNECT_BASE_URL: STAGING_CLOUD_URL },
        cloud: "local",
        config,
        mode: "vite",
      }).OMNYO_DEV_CONNECT_BASE_URL,
    ).toBe(`http://omnyo.localhost:${config.ports.cloudPort}`);
  });

  it("uses production serving with checkout-specific dev selectors", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    const env = toDevLaunchProcessEnv({
      baseEnv: {
        OMNYO_DATA_DIR: "/Users/tester/.omnyo",
        OMNYO_DEV_APP_PORT: "5173",
        OMNYO_SENTRY_DSN: "https://public@sentry.example.test/1",
        OMNYO_TELEMETRY: "true",
        NODE_ENV: "development",
        OPENAI_API_KEY: "test-key",
      },
      cloud: "local",
      config,
      mode: "worktree",
    });

    expect(env).toMatchObject({
      OMNYO_DATA_DIR: config.dataDir,
      OMNYO_HOST_DAEMON_PORT: String(config.ports.hostDaemonPort),
      OMNYO_SENTRY_DSN: "",
      OMNYO_SERVER_PORT: String(config.ports.serverPort),
      OMNYO_SERVER_URL: config.serverUrl,
      OMNYO_TELEMETRY: "false",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
    expect(env.OMNYO_DEV_APP_PORT).toBeUndefined();
  });

  it("keeps worktree serving choices for canonical names", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/omnyo",
    });

    const child = toDevLaunchProcessEnv({
      baseEnv: { OMNYO_DEV_APP_PORT: "5173", OMNYO_TELEMETRY: "true" },
      cloud: "local",
      config,
      mode: "worktree",
    });

    expect(child.OMNYO_TELEMETRY).toBe("false");
    expect(child.OMNYO_DEV_APP_PORT).toBeUndefined();
  });
});
