import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { modelRoleSchema, modelSelectionSchema, routeSchema } from "../contract";
import { SentryFailure } from "./intake";
import type { SentryRunner } from "./runner";
import { workflowPolicyInputSchema } from "./workflow-contract";
import type { SentryWorkflow } from "./workflow";

export function registerSentryCli(
  api: PluginApi,
  runner: SentryRunner,
  workflow: SentryWorkflow,
  reconcileQueue: () => Promise<{ reconciled: true }>,
) {
  api.cli.register({
    name: "sentry",
    summary: "Inspect and operate configured Sentry investigations.",
    commands: [
      {
        name: "workflow",
        summary: "Configure or inspect the Sentry State Machines workflow",
        usage:
          "omnyo sentry workflow status|configure|recover-setup [--file PATH --machine ID | --run RUN_ID] [--json]",
      },
      {
        name: "status",
        summary: "Show routes, runs and connection status",
        usage: "omnyo sentry status [--json]",
      },
      {
        name: "reconcile",
        summary: "Recover settled execution claims and dispatch the retained queue",
        usage: "omnyo sentry reconcile [--json]",
      },
      {
        name: "doctor",
        summary: "Check exact route readiness",
        usage: "omnyo sentry doctor [--route ID] [--json]",
      },
      {
        name: "routes",
        summary: "List, save, enable or pause routes",
        usage:
          "omnyo sentry routes list|set|enable|pause [ID] [--file PATH] [--machine ID] [--json]",
      },
      {
        name: "sync",
        summary: "Scan configured routes; dry-run creates no work",
        usage: "omnyo sentry sync [--dry-run] [--json]",
      },
      {
        name: "investigate",
        summary: "Investigate one exact issue",
        usage:
          "omnyo sentry investigate ISSUE_URL --route ID [--mode local|pr] [--provider ID --model ID --reasoning LEVEL [--tier TIER]] [--json]",
      },
      {
        name: "models",
        summary: "Show or set the default solver, coordinator and reviewer models",
        usage:
          "omnyo sentry models show|set [solver|coordinator|reviewer] [--provider ID --model ID --reasoning LEVEL [--tier TIER]] [--json]",
      },
      {
        name: "runs",
        summary: "Inspect or control one owned run",
        usage: "omnyo sentry runs list|show|stop|retry [ID] [--json]",
      },
    ],
    async run(argv, context) {
      try {
        const values = new Map<string, string>();
        const positional: string[] = [];

        for (let index = 0; index < argv.length; index++) {
          const arg = argv[index];

          if (!arg) continue;

          if (["--json", "--dry-run"].includes(arg)) {
            values.set(arg, "true");
            continue;
          }

          if (
            [
              "--route",
              "--run",
              "--mode",
              "--file",
              "--machine",
              "--provider",
              "--model",
              "--reasoning",
              "--tier",
            ].includes(arg)
          ) {
            const value = argv[++index];

            if (!value || value.startsWith("--")) throw new Error("Missing option value");
            values.set(arg, value);
            continue;
          }

          if (arg.startsWith("--")) throw new Error("Unknown option");
          positional.push(arg);
        }

        const command = positional[0] ?? "status";
        let result;

        const pickedModel = () => {
          const providerId = values.get("--provider");
          const model = values.get("--model");
          const reasoningLevel = values.get("--reasoning");

          return modelSelectionSchema.parse(
            values.has("--tier")
              ? { providerId, model, reasoningLevel, serviceTier: values.get("--tier") }
              : { providerId, model, reasoningLevel },
          );
        };

        if (command === "workflow") {
          if (positional[1] === "status") result = workflow.status();
          else if (positional[1] === "configure") {
            const file = await api.sdk.files.read({
              hostId: z.string().min(1).parse(values.get("--machine")),
              path: z.string().min(1).parse(values.get("--file")),
            });

            result = await workflow.configure(
              workflowPolicyInputSchema.parse(JSON.parse(file.content)),
            );
          } else if (positional[1] === "recover-setup") {
            result = await workflow.recoverSetup(z.string().min(1).parse(values.get("--run")));
          } else throw new Error("Use workflow status, configure or recover-setup");
        } else if (command === "status") result = await runner.status();
        else if (command === "reconcile") result = await reconcileQueue();
        else if (command === "doctor") result = await runner.doctor(values.get("--route") ?? null);
        else if (command === "sync") result = await runner.sync(values.has("--dry-run"));
        else if (command === "investigate") {
          const mode = z.enum(["local", "pr"]).parse(values.get("--mode") ?? "local");
          result = await runner.investigate(
            z.string().min(1).parse(values.get("--route")),
            z.url().parse(positional[1]),
            mode,
            values.has("--model") || values.has("--provider") ? pickedModel() : null,
          );
        } else if (command === "models") {
          if (positional[1] === "set")
            result = runner.saveModelDefault(modelRoleSchema.parse(positional[2]), pickedModel());
          else if (!positional[1] || positional[1] === "show")
            result = runner.store.modelDefaults();
          else throw new Error("Use models show or set");
        } else if (command === "routes") {
          if (positional[1] === "list") result = runner.store.listRoutes();
          else if (positional[1] === "enable" || positional[1] === "pause")
            result = await runner.enable(
              z.string().min(1).parse(positional[2]),
              positional[1] === "enable",
            );
          else if (positional[1] === "set") {
            let hostId = values.get("--machine");

            if (!hostId && context.threadId) {
              const thread = await api.sdk.threads.get({ threadId: context.threadId });

              if (thread.environmentId)
                hostId = (await api.sdk.environments.get({ environmentId: thread.environmentId }))
                  .hostId;
            }

            if (!hostId) throw new Error("Supply --machine for the file owner");

            const file = await api.sdk.files.read({
              hostId,
              path: z.string().min(1).parse(values.get("--file")),
            });

            result = runner.saveRoute(routeSchema.parse(JSON.parse(file.content)));
          } else throw new Error("Use routes list, set, enable or pause");
        } else if (command === "runs") {
          if (positional[1] === "list") result = runner.store.listRuns();
          else {
            const id = z.string().min(1).parse(positional[2]);

            if (positional[1] === "show") result = runner.store.getRun(id);
            else if (positional[1] === "stop") result = await runner.stop(id);
            else if (positional[1] === "retry") result = await runner.retry(id);
            else throw new Error("Use runs list, show, stop or retry");
          }
        } else throw new Error("Unknown Sentry command");

        return {
          exitCode: 0,
          stdout: JSON.stringify(result, null, values.has("--json") ? 0 : 2),
        };
      } catch (cause) {
        const code =
          cause instanceof SentryFailure
            ? cause.code
            : cause instanceof z.ZodError
              ? "invalid-input"
              : "operation-failed";

        const message = "Check the command, route readiness and retained run status.";

        return {
          exitCode: 1,
          stdout: argv.includes("--json")
            ? JSON.stringify({ ok: false, error: { code, message } })
            : "",
          stderr: "Sentry " + code + ". " + message,
        };
      }
    },
  });
}
