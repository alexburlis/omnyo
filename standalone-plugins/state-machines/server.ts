import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { createStateMachineService } from "./src/service.js";
import {
  createOmnyoStateMachineAdapter,
  homeMetadataSchema,
  workerMetadataSchema,
} from "./src/actions/omnyo-adapter.js";
import { actionResultSchema } from "./src/contracts/result.js";
import { registerStateMachineRpc } from "./src/rpc.js";
import { registerStateMachineCli } from "./src/cli.js";
import { ImportedWorkflowService } from "./src/imported/service.js";
import { createImportedTextRunner } from "./src/imported/provider.js";
import { registerImportedWorkflows } from "./src/imported/rpc.js";
import { HomeQuestions } from "./src/home-questions.js";

function homeInstructions(instanceId: string): string {
  return `This chat is the home of State Machines run ${instanceId}. Each step's chat nests under it and reports here when it ends: acknowledge each report in one short line and take no other action. The run's decisions open as forms in this chat; never answer or resolve them yourself. If a step chat asks you a question, relay it to the owner with your question tool instead of answering it. When the owner asks about the run, inspect ${instanceId} with omnyo_state_machines.`;
}

export default async function plugin(api: PluginApi) {
  let changed = () => {};

  registerImportedWorkflows(
    api,
    new ImportedWorkflowService(api.storage.database(), createImportedTextRunner(api)),
  );

  const service = createStateMachineService({
    database: api.storage.database(),
    adapter: createOmnyoStateMachineAdapter(api),
    onChange(change) {
      api.realtime.publish("state-machines.changed", change);
      changed();
    },
  });

  const questions = new HomeQuestions(api.ui, api.log, service);
  changed = () => questions.schedule();

  registerStateMachineRpc(api, service, {
    async listEnvironments(projectId) {
      const environments = await api.sdk.environments.list({ projectId });

      return environments.map((item) => ({
        environmentId: item.id,
        label: item.name ?? item.path ?? item.id,
        hostId: item.hostId,
        available: item.status === "ready" && item.lifecycle.phase === "active",
        persistent:
          !item.managed && item.lifecycle.phase === "active" && item.lifecycle.retireAt === null,
      }));
    },
  });
  registerStateMachineCli(api);

  api.agents.registerTool({
    name: "omnyo_state_machine_result",
    description:
      "Submit the structured result of this exact owned State Machines step, then end the turn. The engine waits for actual worker quiescence before advancing.",
    parameters: z.preprocess(
      (rawInput) => actionResultSchema.parse(rawInput),
      z.strictObject({
        outcome: z.string().min(1).max(128),
        payload: z.record(z.string(), z.unknown()),
      }),
    ),
    async execute(rawInput, context) {
      const input = actionResultSchema.parse(rawInput);

      const metadata = workerMetadataSchema.parse(
        await api.sdk.threads.getPluginMetadata({ threadId: context.threadId }),
      );

      if (
        !service
          .inspectInstance({ instanceId: metadata.instanceId })
          .steps.some(
            (step) => step.attemptId === metadata.attemptId && step.threadId === context.threadId,
          )
      )
        throw new Error("SCOPE_MISMATCH: this result belongs to another step");

      return JSON.stringify(
        service.submitResult(
          { ...metadata, result: input },
          { kind: "worker", threadId: context.threadId },
        ),
      );
    },
  });

  const controlInput = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("list"), projectId: z.string() }).strict(),
    z.object({ operation: z.literal("inspect"), instanceId: z.string() }).strict(),
    z
      .object({
        operation: z.enum(["pause", "resume", "stop"]),
        instanceId: z.string(),
        expectedControlRevision: z.number().int(),
        requestId: z.string(),
      })
      .strict(),
  ]);

  api.agents.registerTool({
    name: "omnyo_state_machines",
    description:
      "Inspect durable state machines, or pause/resume/stop an instance when authorized by the current task. This cannot grant release authority or resolve human effect approvals.",
    parameters: controlInput,
    execute(input) {
      if (input.operation === "list")
        return JSON.stringify(
          service.listMachines({ projectId: input.projectId, limit: 25 }).map((item) => ({
            machineId: item.machineId,
            name: item.name,
            publishedVersionId: item.publishedVersionId,
          })),
        );

      const instance =
        input.operation === "inspect"
          ? service.inspectInstance(input)
          : service.controlInstance({ ...input, operation: input.operation });

      return JSON.stringify({
        instanceId: instance.instanceId,
        revision: instance.revision,
        controlRevision: instance.controlRevision,
        lifecycle: instance.lifecycle,
        phase: instance.phase,
        stateId: instance.stateId,
        entryId: instance.entryId,
        versionId: instance.versionId,
        pendingResultCount: instance.pendingResultCount,
        steps: instance.steps.slice(0, 5),
        detail: `omnyo state-machines status ${instance.instanceId}`,
      });
    },
  });

  api.agents.configure((context) => {
    const worker = workerMetadataSchema.safeParse(context.pluginMetadata);

    if (worker.success)
      return {
        tools: ["omnyo_state_machine_result"],
        skills: [],
        instructions:
          "You are one finite State Machines worker. Submit a schema-valid result through omnyo_state_machine_result and end immediately. Do not leave background work, create follow-up messages, approve effects or expand the action scope.",
      };

    const home = homeMetadataSchema.safeParse(context.pluginMetadata);

    if (home.success)
      return {
        tools: ["omnyo_state_machines"],
        skills: ["state-machines"],
        instructions: homeInstructions(home.data.instanceId),
      };

    return { tools: ["omnyo_state_machines"], skills: ["state-machines"] };
  });

  api.events.on("thread.idle", () => service.wake());
  api.events.on("thread.failed", () => service.wake());
  api.events.on("thread.archived", () => service.wake());
  api.events.on("experimental_thread.events", () => service.wake(), {
    experimental_eventTypes: [
      "thread/started",
      "thread/identity",
      "turn/started",
      "turn/completed",
      "turn/input/accepted",
      "thread/name/updated",
      "thread/compacted",
      "thread/context/cleared",
      "thread/goal/updated",
      "thread/goal/cleared",
      "item/started",
      "item/completed",
      "item/mcpToolCall/progress",
      "item/toolCall/progress",
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
      "item/delegation/progress",
      "item/delegation/completed",
      "thread/tokenUsage/updated",
      "thread/contextWindowUsage/updated",
      "turn/plan/updated",
      "turn/diff/updated",
      "turn/mainRun/updated",
      "provider/error",
      "provider/rateLimits/updated",
      "provider.env-resolved",
      "thread/extensionState/updated",
      "provider/warning",
      "provider/modelFallback",
      "provider/unhandled",
      "client/thread/start",
      "client/turn/requested",
      "client/turn/rejected",
      "client/turn/start",
      "system/error",
      "system/manager/user_message",
      "system/thread/interrupted",
      "system/operation",
      "system/interaction/lifecycle",
      "system/permissionGrant/lifecycle",
      "system/userQuestion/lifecycle",
      "system/thread-provisioning",
      "system/git-activity",
      "system/provider-turn-watchdog",
    ],
  });
  api.background.service("state-machine-dispatcher", {
    start(signal) {
      return service.run(signal);
    },
  });
  api.background.service("state-machine-home-questions", {
    start(signal) {
      return questions.run(signal);
    },
  });
}
