import { cliCommand, defineCli, defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { actionSchema, decisionSchema, jobViewSchema, routeSchema } from "./contracts";
import { QueueRouter } from "./engine";

declare module "@omnyo/plugin-sdk" {
  interface PluginThreadEventPayloads {
    "experimental_thread.maintenance": {
      thread: PluginThreadEventPayloads["thread.idle"]["thread"];
      phase: "started" | "ended";
      outcome: "completed" | "failed" | "stopped" | null;
    };
  }
}

const MAINTENANCE_EVENT = "experimental_thread.maintenance";

function settleAfterMaintenance(api: PluginApi, router: QueueRouter): void {
  try {
    api.events.on(MAINTENANCE_EVENT, async ({ thread, phase }) => {
      if (phase === "started") router.maintenanceStarted(thread.id);
      else await router.settled(thread.id);
    });
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !cause.message.startsWith(`unknown event "${MAINTENANCE_EVENT}"`)
    )
      throw cause;
    api.log.info(
      "This Omnyo sends no automatic compaction events; queues settle on idle and failure.",
    );
  }
}

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ enabled: z.boolean(), jobs: z.array(jobViewSchema) }),
  },
  route: { input: routeSchema, output: jobViewSchema },
  classify: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ started: z.boolean() }),
  },
  restore: { input: z.object({ id: z.string() }), output: jobViewSchema },
});

export default async function plugin(api: PluginApi) {
  const settings = api.settings.define({
    enabled: { type: "boolean", label: "Route queued messages automatically", default: false },
    debounceMs: {
      type: "number",
      label: "Batch quiet time (milliseconds)",
      default: 1500,
      experimental_schema: z.number().int().min(20).max(5000),
    },
    routerProvider: {
      type: "string",
      label: "Existing subscription provider",
      default: "claude-code",
    },
    routerModel: { type: "string", label: "Routing model", default: "claude-haiku-5-5" },
  });

  let values = await settings.get();
  const router = new QueueRouter(api, values);
  await router.initialize();
  settings.onChange((next) => {
    values = next;
    router.setSettings(next);
  });
  api.onDispose(() => router.dispose());
  api.events.on("message.queued", ({ entry }) => router.observe(entry));
  api.events.on("thread.idle", ({ thread }) => router.settled(thread.id));
  api.events.on("thread.failed", ({ thread }) => router.settled(thread.id));
  settleAfterMaintenance(api, router);
  api.events.on("thread.active", ({ thread }) => router.active(thread.id));
  api.experimental_hooks.on("message.dispatch", (ctx) => router.hook(ctx));
  api.agents.registerTool({
    name: "smart_queues_decide",
    description:
      "Submit one ordered-prefix queue routing decision. Only the owned router can use this tool.",
    parameters: decisionSchema,
    execute: async (input, ctx) =>
      JSON.stringify(await router.decide(ctx.threadId, input.action, input.count, input.reason)),
  });
  api.agents.configure((ctx) =>
    router.configure(ctx.thread.id)
      ? {
          tools: ["smart_queues_decide"],
          skills: [],
          instructions:
            "You classify a queue. Call smart_queues_decide exactly once. Execute no user task and no other tools. Do not send messages or modify files, providers, accounts, credentials or billing. Stop after submitting the decision.",
        }
      : { tools: [], skills: [] },
  );
  api.rpc.register(rpcContract, {
    status: async () => ({ enabled: values.enabled, jobs: router.views() }),
    route: ({ threadId, action, count }) => router.route(threadId, action, count),
    classify: async ({ threadId }) => {
      const started = await router.classify(threadId);

      return { started };
    },
    restore: ({ id }) => router.restore(id),
  });

  const json = {
    type: "boolean",
    description: "Emit JSON",
  } satisfies import("@omnyo/plugin-sdk").PluginCliBooleanOption;

  api.cli.register(
    defineCli({
      name: "smart-queues",
      summary: "Route a queue without rewriting its instructions",
      commands: {
        status: cliCommand({
          summary: "Show recent routes and recovery errors",
          options: { json },
          async run(input) {
            const value = { enabled: values.enabled, jobs: router.views() };

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(value)
                : `Automatic routing: ${values.enabled ? "on" : "off"}\n${value.jobs.map((job) => `${job.id} ${job.action ?? "routing"} ${job.state}${job.destinationThreadId ? ` @thread:${job.destinationThreadId}` : ""}${job.error ? ` — ${job.error}` : ""}`).join("\n")}`,
            };
          },
        }),
        route: cliCommand({
          summary: "Choose a route for an ordered queue prefix",
          positionals: [
            { name: "thread", required: true, description: "Source thread id" },
            { name: "action", required: true, description: "steer, new-chat, queue or combine" },
          ],
          options: {
            json,
            count: {
              type: "integer",
              default: 1,
              min: 1,
              max: 64,
              description: "Number of front messages (1–64)",
            },
          },
          async run(input) {
            const action = actionSchema.parse(input.positionals.action);
            const count = z.number().int().min(1).max(64).parse(input.options.count);
            const value = await router.route(input.positionals.thread, action, count);

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(value)
                : `${value.action}: ${value.state}${value.destinationThreadId ? ` @thread:${value.destinationThreadId}` : ""}`,
            };
          },
        }),
        classify: cliCommand({
          summary: "Ask the existing subscription model to route a busy queue",
          positionals: [{ name: "thread", required: true, description: "Source thread id" }],
          options: { json },
          async run(input) {
            const started = await router.classify(input.positionals.thread);

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ started })
                : started
                  ? "Queue classification started."
                  : "No new classification started.",
            };
          },
        }),
        restore: cliCommand({
          summary: "Restore unmodified source receipts after an incomplete handoff",
          positionals: [{ name: "job", required: true, description: "Routing job id" }],
          options: { json },
          async run(input) {
            const value = await router.restore(input.positionals.job);

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(value)
                : `Restored ${value.id}. The retained destination stays held.`,
            };
          },
        }),
      },
    }),
  );
}
