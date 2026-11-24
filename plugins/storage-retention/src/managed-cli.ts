import { cliCommand, type PluginCliResult } from "@omnyo/plugin-sdk";
import { managedAdminRequestSchema } from "./managed-contract.js";
import type { ManagedService } from "./managed-service.js";

async function output(run: () => Promise<unknown>): Promise<PluginCliResult> {
  try {
    return { exitCode: 0, stdout: JSON.stringify(await run(), null, 2) + "\n" };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: (error instanceof Error ? error.message : String(error)) + "\n",
    };
  }
}

const yes = {
  type: "boolean",
  description:
    "Confirm the exact administrative action; this does not create a native owner grant",
} as const;

const previewDigest = {
  type: "string",
  description: "Digest returned by the exact preceding preview",
} as const;

export function managedCliCommands(service: ManagedService) {
  return {
    managed: cliCommand({
      summary:
        "Inspect, review, restore or purge managed scratch (JSON output)",
      positionals: [
        {
          name: "action",
          description:
            "list, inspect, review, restore, purge, purge-preview, purge-batch, namespace-preview or namespace-reanchor",
        },
      ],
      options: {
        machine: { type: "string", description: "Allocation's host ID" },
        id: { type: "string", description: "Managed allocation ID" },
        revision: {
          type: "integer",
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
          description: "Exact allocation revision from inspect",
        },
        "snapshot-digest": {
          type: "string",
          description: "Exact snapshot digest from inspect",
        },
        items: {
          type: "string",
          description:
            "JSON array of exact hostId/id/revision/snapshotDigest references for a bounded purge batch",
        },
        "preview-digest": previewDigest,
        yes,
      },
      run: ({ positionals, options }) =>
        output(async () => {
          const action = positionals.action ?? "list";

          const allowed = new Set(
            action === "list"
              ? []
              : action === "namespace-preview"
                ? ["machine"]
                : action === "namespace-reanchor"
                  ? ["machine", "preview-digest", "yes"]
                  : action === "inspect"
                    ? ["machine", "id"]
                    : action === "purge-preview"
                      ? ["items"]
                      : action === "purge-batch"
                        ? ["items", "preview-digest", "yes"]
                        : [
                            "machine",
                            "id",
                            "revision",
                            "snapshot-digest",
                            "yes",
                          ],
          );

          for (const [name, value] of Object.entries(options))
            if (value !== undefined && value !== false && !allowed.has(name))
              throw new Error(`--${name} does not apply to managed ${action}.`);

          if (
            [
              "review",
              "restore",
              "purge",
              "purge-batch",
              "namespace-reanchor",
            ].includes(action) &&
            !options.yes
          )
            throw new Error(
              "Pass --yes to confirm this exact administrative action.",
            );

          const input =
            action === "list"
              ? { action }
              : action === "namespace-preview" ||
                  action === "namespace-reanchor"
                ? {
                    action,
                    hostId: options.machine,
                    ...(action === "namespace-reanchor"
                      ? { previewDigest: options["preview-digest"] }
                      : {}),
                  }
                : action === "purge-preview" || action === "purge-batch"
                  ? {
                      action,
                      items: JSON.parse(options.items ?? "null"),
                      ...(action === "purge-batch"
                        ? { previewDigest: options["preview-digest"] }
                        : {}),
                    }
                  : action === "inspect"
                    ? { action, hostId: options.machine, id: options.id }
                    : {
                        action,
                        hostId: options.machine,
                        id: options.id,
                        revision: options.revision,
                        snapshotDigest: options["snapshot-digest"],
                      };

          return service.request(managedAdminRequestSchema.parse(input));
        }),
    }),
    "managed-policy": cliCommand({
      summary:
        "Show or preview managed policy; save the exact preview with --save --yes",
      options: {
        mode: {
          type: "enum",
          values: ["review", "owner-approved"],
          description:
            "Require review or admit existing native grants automatically",
        },
        "automatic-expiry": {
          type: "enum",
          values: ["true", "false"],
          description:
            "Enable or disable automatic purge after a fresh seven-day holding period",
        },
        "budget-bytes": {
          type: "integer",
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
          description: "Maximum logical bytes admitted to quarantine",
        },
        "expected-revision": {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          description: "Policy revision returned with the preview",
        },
        "preview-digest": previewDigest,
        save: {
          type: "boolean",
          description: "Save the exact previewed policy",
        },
        yes,
      },
      run: ({ options }) =>
        output(async () => {
          if (
            !options.save &&
            (options.yes ||
              options["expected-revision"] !== undefined ||
              options["preview-digest"] !== undefined)
          )
            throw new Error(
              "--yes, --expected-revision and --preview-digest require --save.",
            );
          const state = await service.state();

          const changed =
            options.mode !== undefined ||
            options["automatic-expiry"] !== undefined ||
            options["budget-bytes"] !== undefined;

          if (!changed && !options.save) return state;

          const policy = {
            mode: options.mode ?? state.policy.mode,
            automaticExpiry:
              options["automatic-expiry"] === undefined
                ? state.policy.automaticExpiry
                : options["automatic-expiry"] === "true",
            quarantineBudgetBytes:
              options["budget-bytes"] ?? state.policy.quarantineBudgetBytes,
          };

          if (!options.save)
            return service.request({ action: "policy-preview", policy });

          if (!options.yes)
            throw new Error(
              "Preview first, then pass --save --yes with --expected-revision and --preview-digest.",
            );

          return service.request(
            managedAdminRequestSchema.parse({
              action: "configure",
              policy,
              expectedRevision: options["expected-revision"],
              previewDigest: options["preview-digest"],
            }),
          );
        }),
    }),
  };
}
