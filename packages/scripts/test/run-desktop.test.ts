import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@omnyo/config/runtime";
import {
  createDesktopPackageCommand,
  createDesktopRunCommand,
  resolveDesktopLaunchMode,
  resolveDesktopPackageTask,
  resolveDesktopUserDataDir,
  toDesktopLaunchProcessEnv,
} from "../src/commands/run-desktop.js";

const config = resolveDevInstanceConfig({
  homeDir: "/Users/tester",
  repoRoot: "/Users/tester/checkouts/omnyo",
});

describe("desktop launch mode", () => {
  it("defaults to the installed data directory and rejects unknown arguments", () => {
    expect(resolveDesktopLaunchMode([])).toBe("prod");
    expect(resolveDesktopLaunchMode(["--worktree"])).toBe("worktree");
    expect(() => resolveDesktopLaunchMode(["--worktre"])).toThrow(
      /Unknown arguments: --worktre/u,
    );
    expect(() => resolveDesktopLaunchMode(["--worktree", "--extra"])).toThrow(
      /Unknown arguments/u,
    );
  });
});

describe("desktop packaging task", () => {
  it("selects the platform packaging task and refuses unsupported platforms", () => {
    expect(resolveDesktopPackageTask("darwin")).toBe("package");
    expect(resolveDesktopPackageTask("linux")).toBe("package:linux");
    expect(resolveDesktopPackageTask("win32")).toBe("package:win");
    expect(() => resolveDesktopPackageTask("freebsd")).toThrow(
      /supported on macOS, Linux, and Windows/u,
    );
    expect(createDesktopPackageCommand("darwin").args).toEqual(
      expect.arrayContaining(["run", "package", "--filter=@omnyo/desktop"]),
    );
  });

  it("runs the packaged app from the desktop package directory", () => {
    const command = createDesktopRunCommand();
    expect(command.cwd.endsWith(`${sep}${join("apps", "desktop")}`)).toBe(true);
    expect(
      command.args[0]?.endsWith(
        `${sep}${join("scripts", "run-packaged-app.mjs")}`,
      ),
    ).toBe(true);
  });
});

describe("desktop launch environment", () => {
  it("isolates the worktree launch onto this checkout's data directory and ports", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: {
        OMNYO_DATA_DIR: "/Users/tester/.omnyo",
        OMNYO_DEV_APP_PORT: "5173",
        OMNYO_SENTRY_DSN: "https://public@sentry.example.test/1",
        OMNYO_TELEMETRY: "true",
        NODE_ENV: "development",
        OPENAI_API_KEY: "test-key",
      },
      config,
      mode: "worktree",
    });

    expect(env).toMatchObject({
      OMNYO_DATA_DIR: config.dataDir,
      OMNYO_DESKTOP_OPEN_DEVTOOLS: "0",
      OMNYO_DESKTOP_USER_DATA_DIR: join(config.dataDir, "desktop"),
      OMNYO_HOST_DAEMON_PORT: String(config.ports.hostDaemonPort),
      OMNYO_SENTRY_DSN: "",
      OMNYO_SERVER_PORT: String(config.ports.serverPort),
      OMNYO_TELEMETRY: "false",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
    expect(env.OMNYO_DATA_DIR).not.toBe("/Users/tester/.omnyo");
    expect(env.OMNYO_SERVER_PORT).not.toBe("38886");
    expect(env.OMNYO_DEV_APP_PORT).toBeUndefined();
  });

  it("preserves an explicit Electron user data directory", () => {
    const userDataDir = "/tmp/omnyo-desktop-profile";

    const env = toDesktopLaunchProcessEnv({
      baseEnv: { OMNYO_DESKTOP_USER_DATA_DIR: ` ${userDataDir} ` },
      config,
      mode: "worktree",
    });

    expect(env.OMNYO_DESKTOP_USER_DATA_DIR).toBe(resolve(userDataDir));
    expect(
      resolveDesktopUserDataDir(
        { OMNYO_DESKTOP_USER_DATA_DIR: "relative-profile" },
        config,
      ),
    ).toBe(join(process.cwd(), "relative-profile"));
  });

  it("lets an explicit devtools choice survive the worktree default", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { OMNYO_DESKTOP_OPEN_DEVTOOLS: "1" },
      config,
      mode: "worktree",
    });

    expect(env.OMNYO_DESKTOP_OPEN_DEVTOOLS).toBe("1");
  });

  it.each(["prod", "worktree"] as const)(
    "keeps desktop choices in %s mode",
    (mode) => {
      const userDataDir = "/tmp/omnyo-desktop-profile";

      const child = toDesktopLaunchProcessEnv({
        baseEnv: {
          OMNYO_DESKTOP_OPEN_DEVTOOLS: "1",
          OMNYO_DESKTOP_USER_DATA_DIR: userDataDir,
        },
        config,
        mode,
      });

      expect(child.OMNYO_DESKTOP_OPEN_DEVTOOLS).toBe("1");
      expect(child.OMNYO_DESKTOP_USER_DATA_DIR).toBe(resolve(userDataDir));
    },
  );

  it("leaves the installed data directory and ports alone without --worktree", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { NODE_ENV: "development", OPENAI_API_KEY: "test-key" },
      config,
      mode: "prod",
    });

    expect(env.OMNYO_DATA_DIR).toBeUndefined();
    expect(env.OMNYO_SERVER_PORT).toBeUndefined();
    expect(env.OMNYO_HOST_DAEMON_PORT).toBeUndefined();
    expect(env.OMNYO_DESKTOP_USER_DATA_DIR).toBeUndefined();
    expect(env).toMatchObject({
      OMNYO_DESKTOP_OPEN_DEVTOOLS: "0",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
  });
});
