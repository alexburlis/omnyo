import { execFile } from "node:child_process";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  cuaContainer,
  cuaGuestProcess,
  cuaRuntimeConfig,
  type CuaInventory,
  type CuaRuntimeConfig,
  type CuaStopInput,
  type CuaStopResult,
} from "./cua-contract";
import { cuaStopHold } from "./cua-policy";
import { parseTopRow } from "./process-table";

const execute = promisify(execFile);

const metadata = z.object({
  name: z.string(),
  container_id: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime({ offset: true }),
  runtime_type: z.enum(["gvisor", "runc"]),
});

const container = z.object({
  ID: z.string().regex(/^[a-f0-9]{64}$/),
  Names: z.string(),
  Labels: z.string(),
  Ports: z.string(),
  Image: z.string(),
});

export function parseCuaPublishedPorts(text: string): number[] {
  const ports: number[] = [];

  for (const segment of text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!segment.includes("->")) {
      if (!/^\d+(?:-\d+)?\/(?:tcp|udp)$/.test(segment))
        throw new Error("The Cua published-port inventory is unsupported.");
      continue;
    }

    const match = /^(.+):(\d+)->(\d+)\/(tcp|udp)$/.exec(segment);

    if (match === null || match[1] === undefined || match[2] === undefined || match[4] !== "tcp")
      throw new Error("The Cua published-port inventory cannot verify all clients.");
    const host = match[1].replace(/^\[|\]$/g, "");
    const port = Number(match[2]);

    if (isIP(host) === 0 || port < 1 || port > 65535)
      throw new Error("The Cua published-port inventory is invalid.");
    ports.push(port);
  }

  return [...new Set(ports)];
}

export type CuaCommand = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<{ stdout: string; exitCode: number }>;

const run: CuaCommand = async (file, args, options) => {
  try {
    const result = await execute(file, args, {
      ...options,
      encoding: "utf8",
      timeout: basename(file) === "colima" && args[0] === "stop" ? 30_000 : 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const failure = z
      .object({ code: z.number().int(), stdout: z.string().default("") })
      .safeParse(error);

    if (failure.success) return { stdout: failure.data.stdout, exitCode: failure.data.code };
    throw new Error(`Could not run ${basename(file)} for Cua inspection.`);
  }
};

async function checkedExecutable(file: string, expectedName: string): Promise<string> {
  if (basename(file) !== expectedName)
    throw new Error(`The configured Cua ${expectedName} executable has the wrong name.`);
  const resolved = await realpath(file);
  const info = await stat(resolved);

  if (!info.isFile())
    throw new Error(`The configured Cua ${expectedName} executable is not a file.`);
  await access(resolved, constants.X_OK);

  return resolved;
}

export async function resolveCuaRuntimeConfig(input?: CuaRuntimeConfig): Promise<CuaRuntimeConfig> {
  async function canonical(config: CuaRuntimeConfig): Promise<CuaRuntimeConfig> {
    const checked = cuaRuntimeConfig.parse(config);

    const [cuaExecutable, colimaExecutable, dockerExecutable, home] = await Promise.all([
      checkedExecutable(checked.cuaExecutable, "cua"),
      checkedExecutable(checked.colimaExecutable, "colima"),
      checkedExecutable(checked.dockerExecutable, "docker"),
      realpath(checked.home),
    ]);

    return { cuaExecutable, colimaExecutable, dockerExecutable, home };
  }

  const home = process.env.CUA_HOME ?? join(homedir(), ".cua");

  const bundles = (await readdir(join(home, "runtimes", "linux"))).filter((name) =>
    /^colima-[0-9][A-Za-z0-9.-]*$/.test(name),
  );

  if (bundles.length !== 1)
    throw new Error("The installed Cua Linux runtime bundle is unavailable or ambiguous.");
  const bundle = bundles[0];

  if (bundle === undefined)
    throw new Error("The installed Cua Linux runtime bundle is unavailable.");
  const dockerPaths = ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"];
  let dockerExecutable: string | null = null;

  for (const candidate of dockerPaths) {
    try {
      await access(candidate, constants.X_OK);
      dockerExecutable = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (dockerExecutable === null)
    throw new Error("The Docker CLI required to inspect Cua is unavailable.");

  const installed = await canonical({
    home,
    cuaExecutable: join(homedir(), ".local", "bin", "cua"),
    colimaExecutable: join(home, "runtimes", "linux", bundle, "bin", "colima"),
    dockerExecutable,
  });

  if (input !== undefined) {
    const candidate = await canonical(input);

    if (
      candidate.home !== installed.home ||
      candidate.cuaExecutable !== installed.cuaExecutable ||
      candidate.colimaExecutable !== installed.colimaExecutable ||
      candidate.dockerExecutable !== installed.dockerExecutable
    )
      throw new Error("The Cua resource does not use this host's approved installed runtime.");
  }

  return installed;
}

function environment(config: CuaRuntimeConfig): NodeJS.ProcessEnv {
  const colimaHome = join(config.home, "runtimes", "linux", "vm");

  return {
    ...process.env,
    LC_ALL: "C",
    CUA_HOME: config.home,
    COLIMA_HOME: colimaHome,
    LIMA_HOME: join(colimaHome, "_lima"),
  };
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Error("Cua returned invalid inspection data.");
  }
}

export function createCuaRuntimeAdapter(
  command: CuaCommand = run,
  resolveConfig = resolveCuaRuntimeConfig,
) {
  async function readVmIdentity(
    config: CuaRuntimeConfig,
    options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
  ): Promise<NonNullable<CuaInventory["vm"]>> {
    const runtime = join(config.home, "runtimes", "linux", "vm", "_lima", "colima-cua");
    const controllerPid = Number((await readFile(join(runtime, "vz.pid"), "utf8")).trim());

    if (!Number.isSafeInteger(controllerPid) || controllerPid <= 1)
      throw new Error("The Cua virtual machine controller identity is invalid.");

    const controller = await command(
      "/bin/ps",
      ["-ww", "-p", String(controllerPid), "-o", "comm="],
      options,
    );

    if (
      controller.exitCode !== 0 ||
      controller.stdout.trim() !==
        join(dirname(config.colimaExecutable), "..", "lima", "bin", "limactl")
    )
      throw new Error("The Cua virtual machine controller could not be verified.");

    const readers = await command(
      "/usr/sbin/lsof",
      ["-nP", "-Fpc", join(runtime, "disk")],
      options,
    );

    if (readers.exitCode !== 0)
      throw new Error("The Cua virtual machine disk owner could not be verified.");
    const pids = [...readers.stdout.matchAll(/^p(\d+)$/gm)].map((entry) => Number(entry[1]));

    if (pids.length === 0 || pids.length > 8)
      throw new Error("The Cua virtual machine disk owner is unavailable or ambiguous.");
    const identities: Array<NonNullable<CuaInventory["vm"]>> = [];

    for (const pid of pids) {
      const identity = await command(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "comm="],
        options,
      );

      const match =
        /^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)\s*$/.exec(
          identity.stdout,
        );

      if (
        identity.exitCode === 0 &&
        match?.[2]?.includes("/Virtualization.framework/") &&
        match[2].endsWith("/com.apple.Virtualization.VirtualMachine") &&
        match[1] !== undefined
      )
        identities.push({ pid, startedAt: match[1].replace(/\s+/g, " ") });
    }

    const identity = identities[0];

    if (identities.length !== 1 || identity === undefined)
      throw new Error("The Cua virtual machine process could not be verified.");

    return identity;
  }

  async function inspect(
    configInput?: CuaRuntimeConfig,
    signal?: AbortSignal,
  ): Promise<CuaInventory> {
    const config = await resolveConfig(configInput);
    const env = environment(config);
    const options = signal === undefined ? { env } : { env, signal };

    const status = await command(
      config.colimaExecutable,
      ["status", "--profile", "cua", "--json"],
      options,
    );

    if (status.exitCode !== 0)
      throw new Error("The Cua virtual machine status could not be verified.");

    const vm = await readVmIdentity(config, options);

    const [sandboxesResult, containersResult, memoryResult] = await Promise.all([
      command(
        config.cuaExecutable,
        [
          "sandbox",
          "ls",
          "--embedded",
          "--local",
          "--no-size",
          "--state-dir",
          join(config.home, "sandboxes"),
          "--json",
        ],
        options,
      ),
      command(
        config.dockerExecutable,
        [
          "--host",
          `unix://${join(config.home, "runtimes", "linux", "vm", "cua", "docker.sock")}`,
          "ps",
          "--no-trunc",
          "--format",
          "{{json .}}",
        ],
        options,
      ),
      command("/usr/bin/top", ["-l", "1", "-pid", String(vm.pid), "-stats", "pid,mem"], options),
    ]);

    if (sandboxesResult.exitCode !== 0 || containersResult.exitCode !== 0)
      throw new Error("The Cua sandbox and container inventory could not be verified.");

    const listed = parseJson(
      z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
            location: z.literal("local"),
            runtime_type: z.string(),
          }),
        )
        .max(16),
      sandboxesResult.stdout,
    );

    const sandboxes: CuaInventory["sandboxes"] = [];

    for (const sandbox of listed) {
      if (sandbox.runtime_type !== "gvisor" && sandbox.runtime_type !== "runc") continue;

      const record = parseJson(
        metadata,
        await readFile(join(config.home, "sandboxes", `${sandbox.name}.json`), "utf8"),
      );

      if (record.name !== sandbox.name)
        throw new Error("A Cua sandbox record does not match its name.");

      const dockerArgs = [
        "--host",
        `unix://${join(config.home, "runtimes", "linux", "vm", "cua", "docker.sock")}`,
      ];

      const [created, processes] = await Promise.all([
        command(
          config.dockerExecutable,
          [...dockerArgs, "inspect", "--format", "{{.Created}}", record.container_id],
          options,
        ),
        command(
          config.dockerExecutable,
          [...dockerArgs, "top", record.container_id, "-eo", "pid=,lstart=,comm="],
          options,
        ),
      ]);

      if (created.exitCode !== 0 || processes.exitCode !== 0)
        throw new Error(
          "A Cua sandbox's creation identity or running processes could not be verified.",
        );

      const guestProcesses = processes.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry =
            /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
              line,
            );

          if (entry === null)
            throw new Error("Cua returned an unsupported guest process inventory.");

          return cuaGuestProcess.parse({
            pid: Number(entry[1]),
            startedAt: entry[2]?.replace(/\s+/g, " "),
            executable: entry[3],
          });
        });

      if (guestProcesses.length === 0 || guestProcesses.length > 1024)
        throw new Error(
          "The Cua guest process inventory is empty or exceeds its inspection limit.",
        );
      sandboxes.push({
        name: record.name,
        containerId: record.container_id,
        createdAt: z.string().datetime({ offset: true }).parse(created.stdout.trim()),
        processes: guestProcesses,
      });
    }

    const containers = containersResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row = parseJson(container, line);
        const labels = new Set(row.Labels.split(","));

        const kind =
          row.Names === "cua-runsc-helper" &&
          row.Image === "cua-vmm/helper:1" &&
          labels.has("ai.cua.kind=helper") &&
          labels.has("ai.cua.managed=true")
            ? "helper"
            : labels.has("ai.cua.kind=sandbox")
              ? "sandbox"
              : "unknown";

        const publishedPorts = parseCuaPublishedPorts(row.Ports);

        return { id: row.ID, name: row.Names, kind, publishedPorts };
      });

    const ports = [...new Set(containers.flatMap((item) => item.publishedPorts))];

    if (ports.length > 128)
      throw new Error("The Cua published-port inventory exceeds its inspection limit.");
    const activeClientPorts: number[] = [];

    for (const port of ports) {
      const clients = await command(
        "/usr/sbin/lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"],
        options,
      );

      if (clients.exitCode !== 0 && clients.exitCode !== 1)
        throw new Error("Cua client connections could not be verified.");

      if (clients.stdout.trim() !== "") activeClientPorts.push(port);
    }

    const memoryRow =
      memoryResult.exitCode === 0
        ? memoryResult.stdout
            .split("\n")
            .map(parseTopRow)
            .find((row) => row?.pid === vm.pid)
        : undefined;

    return {
      config,
      vm,
      sandboxes,
      containers: z.array(cuaContainer).max(256).parse(containers),
      activeClientPorts,
      memory:
        memoryRow === undefined || memoryRow === null
          ? { kind: "unavailable" }
          : { kind: "footprint", bytes: memoryRow.bytes },
    };
  }

  async function stop(input: CuaStopInput, signal?: AbortSignal): Promise<CuaStopResult> {
    let observed: CuaInventory;

    try {
      observed = await inspect(input.config, signal);
    } catch {
      return { kind: "held", reason: "Cua inspection failed before shutdown." };
    }

    const hold = cuaStopHold(input, observed);

    if (hold !== null) return { kind: "held", reason: hold };
    const env = environment(observed.config);
    const options = signal === undefined ? { env } : { env, signal };

    try {
      const finalIdentity = await readVmIdentity(observed.config, options);

      if (finalIdentity.pid !== input.vm.pid || finalIdentity.startedAt !== input.vm.startedAt)
        return { kind: "held", reason: "The virtual machine identity changed before shutdown." };
    } catch {
      return { kind: "held", reason: "The final virtual machine identity could not be verified." };
    }

    try {
      const result = await command(
        observed.config.colimaExecutable,
        ["stop", "--profile", "cua"],
        options,
      );

      if (result.exitCode !== 0)
        return {
          kind: "uncertain",
          reason: "Cua shutdown did not return a verified successful result.",
        };

      const probe = await command(
        "/bin/ps",
        ["-p", String(input.vm.pid), "-o", "lstart="],
        options,
      );

      if (probe.exitCode === 1 || probe.stdout.trim() === "") return { kind: "stopped" };

      return {
        kind: "uncertain",
        reason: "The Cua virtual machine process still exists after shutdown.",
      };
    } catch {
      return {
        kind: "uncertain",
        reason: "Cua shutdown was interrupted; its outcome must be reconciled.",
      };
    }
  }

  async function reconcile(
    vm: CuaStopInput["vm"],
    signal?: AbortSignal,
  ): Promise<"running" | "stopped" | "unknown"> {
    const env = { ...process.env, LC_ALL: "C" };

    try {
      const result = await command(
        "/bin/ps",
        ["-p", String(vm.pid), "-o", "lstart="],
        signal === undefined ? { env } : { env, signal },
      );

      if (result.exitCode === 1) return "stopped";

      if (result.exitCode !== 0 || result.stdout.trim() === "") return "unknown";

      return result.stdout.trim().replace(/\s+/g, " ") === vm.startedAt ? "running" : "stopped";
    } catch {
      return "unknown";
    }
  }

  return { inspect, stop, reconcile };
}

const adapter = createCuaRuntimeAdapter();

export const inspectCuaRuntime = adapter.inspect;

export const stopCuaRuntime = adapter.stop;

export const reconcileCuaRuntime = adapter.reconcile;
