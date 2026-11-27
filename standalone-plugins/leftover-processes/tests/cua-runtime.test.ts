import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCuaRuntimeAdapter,
  parseCuaPublishedPorts,
  resolveCuaRuntimeConfig,
  type CuaCommand,
} from "../cua-runtime";
import type { CuaRuntimeConfig } from "../cua-contract";

const roots: string[] = [];

const CONTAINER = "a".repeat(64);

const START = "Thu Nov 12 20:00:00 2026";

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(process.env.OMNYO_VERIFY_SCRATCH ?? tmpdir(), "cua-adapter-"));
  roots.push(root);
  const runtime = join(root, "runtimes", "linux", "vm", "_lima", "colima-cua");
  await Promise.all([mkdir(runtime, { recursive: true }), mkdir(join(root, "sandboxes"))]);
  await writeFile(join(runtime, "vz.pid"), "122\n");
  await writeFile(
    join(root, "sandboxes", "owned.json"),
    JSON.stringify({
      name: "owned",
      container_id: CONTAINER,
      created_at: "2026-11-12T20:00:00.000Z",
      runtime_type: "gvisor",
      env_token: "fixture-cua-credential",
    }),
  );

  const config: CuaRuntimeConfig = {
    cuaExecutable: "/tools/cua",
    colimaExecutable: "/tools/colima",
    dockerExecutable: "/tools/docker",
    home: root,
  };

  const calls: Array<{ file: string; args: string[] }> = [];
  let stopped = false;
  let clients = false;
  let extra = false;
  let changed = false;
  let changeDuringInspection = false;

  const command: CuaCommand = async (file, args) => {
    calls.push({ file, args });

    if (file === config.colimaExecutable && args[0] === "status")
      return { stdout: "{}", exitCode: 0 };

    if (file === config.colimaExecutable && args[0] === "stop") {
      stopped = true;

      return { stdout: "", exitCode: 0 };
    }

    if (file === "/bin/ps" && args.includes("122"))
      return { stdout: "/lima/bin/limactl\n", exitCode: 0 };

    if (file === "/bin/ps")
      return {
        stdout: stopped
          ? ""
          : `${changed ? "Fri Nov 13 20:00:00 2026" : START}${args.includes("comm=") ? " /System/Library/Frameworks/Virtualization.framework/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine" : ""}\n`,
        exitCode: stopped ? 1 : 0,
      };

    if (file === "/usr/bin/top") return { stdout: "PID MEM\n123 22G\n", exitCode: 0 };

    if (file === config.cuaExecutable)
      return {
        stdout: JSON.stringify([{ name: "owned", location: "local", runtime_type: "gvisor" }]),
        exitCode: 0,
      };

    if (file === config.dockerExecutable && args.includes("inspect"))
      return { stdout: "2026-11-12T20:00:00.000Z\n", exitCode: 0 };

    if (file === config.dockerExecutable && args.includes("top")) {
      if (changeDuringInspection) changed = true;

      return { stdout: "1 Thu Nov 12 20:00:00 2026 cua-spacesd\n", exitCode: 0 };
    }

    if (file === config.dockerExecutable && args.includes("ps")) {
      const rows = [
        {
          ID: CONTAINER,
          Names: "owned",
          Labels: "ai.cua.kind=sandbox",
          Ports: "127.0.0.1:3211->3211/tcp",
          Image: "ghcr.io/trycua/linux",
        },
      ];

      if (extra)
        rows.push({ ID: "b".repeat(64), Names: "manual", Labels: "", Ports: "", Image: "manual" });

      return { stdout: rows.map((row) => JSON.stringify(row)).join("\n"), exitCode: 0 };
    }

    if (file === "/usr/sbin/lsof" && args.some((arg) => arg.endsWith("/colima-cua/disk")))
      return { stdout: "p123\nccom.apple.Virtualization.Virtua\n", exitCode: 0 };

    if (file === "/usr/sbin/lsof")
      return { stdout: clients ? "p456\n" : "", exitCode: clients ? 0 : 1 };
    throw new Error("Unexpected Cua command.");
  };

  return {
    config,
    calls,
    adapter: createCuaRuntimeAdapter(command, async () => config),
    client: () => {
      clients = true;
    },
    unmanaged: () => {
      extra = true;
    },
    replace: () => {
      changed = true;
    },
    replaceDuringInspection: () => {
      changeDuringInspection = true;
    },
  };
}

describe("Cua host adapter", () => {
  it.each(["192.168.2.10:58710->3211/tcp", "[fd00::10]:58710->3211/tcp", "[::]:58710->3211/tcp"])(
    "tracks a client port published on %s",
    (value) => {
      expect(parseCuaPublishedPorts(value)).toEqual([58710]);
    },
  );

  it.each(["unexpected-binding->3211/tcp", "0.0.0.0:5000->5000/udp"])(
    "refuses a binding with unverified client coverage %s",
    (value) => {
      expect(() => parseCuaPublishedPorts(value)).toThrow();
    },
  );

  it("refuses a VM replaced during guest inspection before dispatching shutdown", async () => {
    const f = await fixture();
    const observed = await f.adapter.inspect(f.config);

    if (observed.vm === null) throw new Error("Expected running Cua fixture.");
    f.replaceDuringInspection();
    expect(
      (await f.adapter.stop({ config: f.config, vm: observed.vm, sandboxes: observed.sandboxes }))
        .kind,
    ).toBe("held");
    expect(f.calls.some((call) => call.args[0] === "stop")).toBe(false);
  });
  it("returns only narrowed identities and memory, without sandbox credentials", async () => {
    const f = await fixture();
    const observed = await f.adapter.inspect(f.config);
    expect(observed.vm).toEqual({ pid: 123, startedAt: START });
    expect(observed.memory).toEqual({ kind: "footprint", bytes: 22 * 1024 ** 3 });
    expect(observed.sandboxes[0]?.processes).toEqual([
      { pid: 1, startedAt: START, executable: "cua-spacesd" },
    ]);
    expect(JSON.stringify(observed)).not.toContain("fixture-cua-credential");
  });

  it("uses only graceful Colima stop and verifies the original VM exits", async () => {
    const f = await fixture();
    const observed = await f.adapter.inspect(f.config);

    if (observed.vm === null) throw new Error("Expected running Cua fixture.");
    expect(
      await f.adapter.stop({ config: f.config, vm: observed.vm, sandboxes: observed.sandboxes }),
    ).toEqual({ kind: "stopped" });
    expect(f.calls.filter((call) => call.args[0] === "stop")).toEqual([
      { file: f.config.colimaExecutable, args: ["stop", "--profile", "cua"] },
    ]);
    expect(
      f.calls.some(
        (call) =>
          call.args.includes("rm") ||
          call.args.includes("--force") ||
          call.args.includes("suspend"),
      ),
    ).toBe(false);
  });

  it.each(["client", "unmanaged", "replace"] as const)(
    "never dispatches stop after %s changes",
    async (change) => {
      const f = await fixture();
      const observed = await f.adapter.inspect(f.config);

      if (observed.vm === null) throw new Error("Expected running Cua fixture.");
      f[change]();
      expect(
        (await f.adapter.stop({ config: f.config, vm: observed.vm, sandboxes: observed.sandboxes }))
          .kind,
      ).toBe("held");
      expect(f.calls.some((call) => call.args[0] === "stop")).toBe(false);
    },
  );

  it("rejects a caller-selected fake executable before running it", async () => {
    const root = await mkdtemp(
      join(process.env.OMNYO_VERIFY_SCRATCH ?? tmpdir(), "cua-executable-"),
    );

    roots.push(root);
    const executable = join(root, "colima");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await expect(
      resolveCuaRuntimeConfig({
        home: root,
        cuaExecutable: join(root, "cua"),
        colimaExecutable: executable,
        dockerExecutable: join(root, "docker"),
      }),
    ).rejects.toBeDefined();
  });
});
