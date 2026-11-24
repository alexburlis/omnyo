import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OMNYO_CLI_REEXEC_ENV,
  maybeReexecViaOmnyoCli,
  resolveOmnyoCliLaunch,
} from "../cli-reexec.js";

describe("maybeReexecViaOmnyoCli", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "omnyo-cli-reexec-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeExecutable(name: string): Promise<string> {
    const path = join(tempRoot, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);

    return path;
  }

  it("no-ops when OMNYO_CLI is unset", () => {
    const reexec = vi.fn();
    maybeReexecViaOmnyoCli({
      env: {},
      currentExecutablePath: "/tmp/current-omnyo",
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when OMNYO_CLI equals the current executable", async () => {
    const path = await writeExecutable("Omnyo");
    const reexec = vi.fn();
    maybeReexecViaOmnyoCli({
      env: { OMNYO_CLI: path },
      currentExecutablePath: path,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when already in a re-exec hop", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaOmnyoCli({
      env: { OMNYO_CLI: target, [OMNYO_CLI_REEXEC_ENV]: "1" },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs to OMNYO_CLI when it differs from the current entry", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaOmnyoCli({
      env: { OMNYO_CLI: target, OMNYO_SERVER_URL: "http://127.0.0.1:1" },
      currentExecutablePath: current,
      argv: ["status", "--json"],
      reexec,
    });
    expect(reexec).toHaveBeenCalledOnce();
    expect(reexec.mock.calls[0]?.[0]).toEqual({
      target: realpathSync(target),
      argv: ["status", "--json"],
      env: expect.objectContaining({
        OMNYO_CLI: target,
        OMNYO_SERVER_URL: "http://127.0.0.1:1",
        [OMNYO_CLI_REEXEC_ENV]: "1",
      }),
    });
  });

  it("no-ops when OMNYO_CLI path is missing", async () => {
    const current = await writeExecutable("current");
    const reexec = vi.fn();
    maybeReexecViaOmnyoCli({
      env: { OMNYO_CLI: join(tempRoot, "does-not-exist") },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });
});

describe("resolveOmnyoCliLaunch", () => {
  it("runs an extensionless OMNYO_CLI script through Node on Windows", () => {
    expect(
      resolveOmnyoCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\omnyo\\host-daemon\\dist\\omnyo",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\omnyo\\host-daemon\\dist\\omnyo", "status"],
    });
  });

  it("executes OMNYO_CLI directly when the platform can run it", () => {
    expect(
      resolveOmnyoCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\tools\\omnyo.exe",
      }),
    ).toEqual({ command: "C:\\tools\\omnyo.exe", args: ["status"] });
    expect(
      resolveOmnyoCliLaunch({
        argv: ["status"],
        nodePath: "/usr/bin/node",
        platform: "darwin",
        target: "/opt/omnyo/host-daemon/dist/omnyo",
      }),
    ).toEqual({
      command: "/opt/omnyo/host-daemon/dist/omnyo",
      args: ["status"],
    });
  });
});
