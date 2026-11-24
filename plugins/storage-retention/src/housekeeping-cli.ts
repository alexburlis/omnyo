import { cliCommand, type PluginCliResult } from "@omnyo/plugin-sdk";
import {
  defaultHousekeepingBudget,
  housekeepingAdapterAdoptSchema,
  housekeepingRunInputSchema,
  housekeepingSourceSchema,
} from "./housekeeping-contract.js";
import type { HousekeepingService } from "./housekeeping-service.js";

async function output(work: () => Promise<unknown>): Promise<PluginCliResult> {
  try {
    return {
      exitCode: 0,
      stdout: JSON.stringify(await work(), null, 2) + "\n",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr:
        (error instanceof Error ? error.message : "Housekeeping failed.") +
        "\n",
    };
  }
}

export function housekeepingCliCommands(service: HousekeepingService) {
  return {
    housekeeping: cliCommand({
      summary:
        "Inspect and run durable housekeeping or explicitly adopt a pinned local Mac policy",
      positionals: [
        {
          name: "action",
          description:
            "status, preview, run, adapter-preview, adapter-adopt or adapter-remove",
        },
      ],
      options: {
        machine: { type: "string", description: "Host ID" },
        "source-directory": {
          type: "string",
          description: "Physical safe-mac-cleanup source directory",
        },
        python: {
          type: "string",
          description: "Physical Python executable path",
        },
        policy: {
          type: "string",
          description: "Physical approved policy file path",
        },
        "docker-kasten-policy": {
          type: "string",
          description:
            "Physical approved policy-docker-kasten.toml path; binds the separate Docker cache profile",
        },
        revision: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          description: "Exact registration revision from adapter-preview",
        },
        "preview-digest": {
          type: "string",
          description: "Exact digest returned by adapter-preview",
        },
        "max-items": {
          type: "integer",
          min: 1,
          max: 1000,
          description:
            "Process, plugin and cold-file item budget; native utilities retain approved policy limits",
        },
        "max-bytes": {
          type: "integer",
          min: 1,
          max: 100 * 1024 ** 3,
          description:
            "Process, plugin and cold-file byte budget; native utilities retain approved policy limits",
        },
        "budget-seconds": {
          type: "integer",
          min: 1,
          max: 900,
          description: "Soft stage-admission budget in seconds",
        },
        yes: {
          type: "boolean",
          description: "Confirm this exact apply, adoption or removal",
        },
      },
      run: ({ positionals, options }) =>
        output(async () => {
          const action = positionals.action ?? "status";

          const allowed = new Set(
            action === "status"
              ? []
              : action === "adapter-preview"
                ? [
                    "machine",
                    "source-directory",
                    "python",
                    "policy",
                    "docker-kasten-policy",
                  ]
                : action === "adapter-adopt" || action === "adapter-remove"
                  ? ["machine", "revision", "preview-digest", "yes"]
                  : action === "run" || action === "preview"
                    ? [
                        "machine",
                        "max-items",
                        "max-bytes",
                        "budget-seconds",
                        ...(action === "run" ? ["yes"] : []),
                      ]
                    : [],
          );

          for (const [name, value] of Object.entries(options))
            if (value !== undefined && value !== false && !allowed.has(name))
              throw new Error(
                `--${name} does not apply to housekeeping ${action}.`,
              );

          if (action === "status") return service.status();

          if (
            ["run", "adapter-adopt", "adapter-remove"].includes(action) &&
            !options.yes
          )
            throw new Error(
              "Pass --yes to confirm this exact housekeeping operation.",
            );

          if (action === "adapter-preview")
            return service.adapterPreview({
              hostId: options.machine ?? "",
              ...housekeepingSourceSchema.parse({
                sourceDirectory: options["source-directory"],
                pythonPath: options.python,
                policyPath: options.policy,
                namedPolicies:
                  options["docker-kasten-policy"] === undefined
                    ? {}
                    : { "docker-kasten": options["docker-kasten-policy"] },
              }),
            });

          if (action === "adapter-adopt" || action === "adapter-remove") {
            const input = housekeepingAdapterAdoptSchema.parse({
              hostId: options.machine,
              revision: options.revision,
              previewDigest: options["preview-digest"],
            });

            return action === "adapter-adopt"
              ? service.adapterAdopt(input)
              : service.adapterRemove(input);
          }

          if (action === "preview" || action === "run") {
            const input = housekeepingRunInputSchema.parse({
              hostId: options.machine,
              budget: {
                maxItems:
                  options["max-items"] ?? defaultHousekeepingBudget.maxItems,
                maxBytes:
                  options["max-bytes"] ?? defaultHousekeepingBudget.maxBytes,
                budgetSeconds:
                  options["budget-seconds"] ??
                  defaultHousekeepingBudget.budgetSeconds,
              },
            });

            return action === "run"
              ? service.run(input)
              : service.preview(input);
          }

          throw new Error(
            "Use status, preview, run, adapter-preview, adapter-adopt or adapter-remove.",
          );
        }),
    }),
  };
}
