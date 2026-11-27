import type { PluginCliResult } from "@omnyo/plugin-sdk";
import type { CuaService } from "./cua-service";

const USAGE = `Usage:
  omnyo leftover-processes cua observe [--host <id>] [--json]
  omnyo leftover-processes cua list [--host <id>] [--json]
  omnyo leftover-processes cua register --sandbox <name> --consumer <id> [--thread <id>] [--host <id>] [--managed] [--grace-minutes <n>] [--json]
  omnyo leftover-processes cua acquire --resource <id> --consumer <id> [--thread <id>] [--json]
  omnyo leftover-processes cua release --resource <id> --consumer <id> [--thread <id>] [--json]
  omnyo leftover-processes cua keep --resource <id> [--thread <id>] [--json]
  omnyo leftover-processes cua unkeep --resource <id> [--thread <id>] [--json]
  omnyo leftover-processes cua reconcile --resource <id> [--thread <id>] [--json]`;

export const CUA_CLI_COMMANDS = [
  {
    name: "cua",
    summary: "Track owned Cua runtimes and inspect unmanaged resources",
    usage:
      "omnyo leftover-processes cua <observe|list|register|acquire|release|keep|unkeep|reconcile> [options]",
  },
];

const VALUES = new Set([
  "--host",
  "--thread",
  "--sandbox",
  "--consumer",
  "--resource",
  "--grace-minutes",
]);

const FLAGS = new Map([
  ["observe", new Set(["--host", "--json"])],
  ["list", new Set(["--host", "--json"])],
  [
    "register",
    new Set([
      "--host",
      "--thread",
      "--sandbox",
      "--consumer",
      "--managed",
      "--grace-minutes",
      "--json",
    ]),
  ],
  ["acquire", new Set(["--resource", "--consumer", "--thread", "--json"])],
  ["release", new Set(["--resource", "--consumer", "--thread", "--json"])],
  ["keep", new Set(["--resource", "--thread", "--json"])],
  ["unkeep", new Set(["--resource", "--thread", "--json"])],
  ["reconcile", new Set(["--resource", "--thread", "--json"])],
]);

export async function runCuaCli(
  service: CuaService,
  argv: readonly string[],
  context: { threadId: string | null; defaultHostId: string | null },
): Promise<PluginCliResult> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "help")
    return { exitCode: 0, stdout: USAGE };
  const allowed = FLAGS.get(command);

  if (allowed === undefined) return { exitCode: 1, stderr: USAGE };
  const values = new Map<string, string>();
  let json = false;
  let managed = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === undefined || !allowed.has(argument)) return { exitCode: 1, stderr: USAGE };

    if (argument === "--json") json = true;
    else if (argument === "--managed") managed = true;
    else if (argument !== undefined && VALUES.has(argument)) {
      const value = argv[index + 1];

      if (value === undefined || value.startsWith("--") || values.has(argument))
        return { exitCode: 1, stderr: USAGE };
      values.set(argument, value);
      index += 1;
    } else return { exitCode: 1, stderr: USAGE };
  }

  const hostId = values.get("--host") ?? context.defaultHostId;
  const ownerThreadId = values.get("--thread") ?? context.threadId;

  function requireValue(flag: string): string {
    const value = values.get(flag);

    if (value === undefined) throw new Error(`${flag} is required.`);

    return value;
  }

  function requireHost(): string {
    if (hostId === null) throw new Error("Pass --host to select the Cua machine.");

    return hostId;
  }

  function requireOwner(): string {
    if (ownerThreadId === null) throw new Error("Pass --thread to identify the resource owner.");

    return ownerThreadId;
  }

  try {
    if (command === "observe") {
      const inventory = await service.observe({ hostId: requireHost() });

      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(inventory)
          : `Observed Cua runtime. Ownership is not registered.\nVirtual machine: ${inventory.vm?.pid ?? "not running"}\nSandboxes: ${inventory.sandboxes.map((sandbox) => sandbox.name).join(", ") || "none"}\nMemory: ${inventory.memory.kind === "footprint" ? `${inventory.memory.bytes} bytes (footprint)` : "unknown"}\nConnected service ports: ${inventory.activeClientPorts.length}`,
      };
    }

    if (command === "list") {
      const result = await service.list(hostId === null ? {} : { hostId });

      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(result)
          : result.resources.length === 0
            ? "No Cua resources are registered. Run cua observe to inspect unmanaged resources."
            : result.resources
                .map(
                  (resource) =>
                    `${resource.id}  ${resource.sandbox.name}  ${resource.retentionReason}  owner ${resource.ownerThreadId}${resource.lastHoldReason === null ? "" : `  ${resource.lastHoldReason}`}`,
                )
                .join("\n"),
      };
    }

    if (command === "register") {
      const grace = Number(values.get("--grace-minutes") ?? "5") * 60_000;

      const result = await service.register({
        hostId: requireHost(),
        ownerThreadId: requireOwner(),
        initialConsumerId: requireValue("--consumer"),
        ownership: managed ? "managed" : "observed",
        sandboxName: requireValue("--sandbox"),
        idleGraceMs: grace,
      });

      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(result)
          : `Registered ${result.sandbox.name} as ${result.ownership}. Resource ${result.id}; consumer ${requireValue("--consumer")}.`,
      };
    }

    const resourceId = requireValue("--resource");
    const owner = requireOwner();

    const result =
      command === "acquire"
        ? await service.acquire({
            resourceId,
            ownerThreadId: owner,
            consumerId: requireValue("--consumer"),
          })
        : command === "release"
          ? await service.release({
              resourceId,
              ownerThreadId: owner,
              consumerId: requireValue("--consumer"),
            })
          : command === "keep" || command === "unkeep"
            ? await service.keep({ resourceId, ownerThreadId: owner, keep: command === "keep" })
            : command === "reconcile"
              ? await service.reconcile({ resourceId, ownerThreadId: owner })
              : null;

    if (result === null) return { exitCode: 1, stderr: USAGE };

    return {
      exitCode: 0,
      stdout: json
        ? JSON.stringify(result)
        : `${result.sandbox.name}: ${result.retentionReason}${result.nextStopAt === null ? "" : `; eligible after ${new Date(result.nextStopAt).toISOString()}`}`,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : "The Cua housekeeping command failed.",
    };
  }
}
