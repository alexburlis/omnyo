import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { WorkflowPolicy } from "./workflow-contract";
import { workflowPolicyInputSchema } from "./workflow-contract";
import { sentryWorkflowGraph } from "./workflow-graph";

const id = z.string().min(1).max(256);

const revision = z.number().int().nonnegative();

const machineIds = z.object({ machineId: id, versionId: id });

const version = z.object({
  machineId: id,
  versionId: id,
  number: z.number().int().positive(),
  definition: z.json(),
});

const draft = z.object({ machineId: id, draftRevision: revision, document: z.json() });

const problem = z.object({ severity: z.enum(["error", "warning", "info"]), message: z.string() });

const step = z.object({
  invocationId: id,
  attemptId: id,
  generation: revision,
  specHash: id,
  entryId: id,
  stateId: id,
  status: z.enum([
    "pending",
    "dispatching",
    "running",
    "result-ready",
    "succeeded",
    "failed",
    "timed-out",
    "cancel-requested",
    "cancelled",
    "uncertain",
  ]),
  threadId: id.nullable(),
  environmentId: id,
  confirmedLive: z.boolean(),
});

const instance = z.object({
  instanceId: id,
  machineId: id,
  versionId: id,
  lifecycle: z.enum(["running", "paused", "stopping", "stopped", "completed", "failed"]),
  phase: z.string().nullable(),
  stateId: id,
  entryId: id,
  revision,
  controlRevision: revision,
  steps: z.array(step),
  homeThreadId: id.nullable().default(null),
});

type WorkflowMachinePolicyInput = z.infer<typeof workflowPolicyInputSchema>;

type RpcInput = Parameters<PluginApi["sdk"]["plugins"]["callRpc"]>[0]["input"];

function requestId(operation: string, value: RpcInput) {
  return `sentry-workflow:${operation}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class WorkflowMachine {
  constructor(private api: PluginApi) {}

  private async call<Result>(
    method: string,
    input: RpcInput,
    schema: z.ZodType<Result>,
  ): Promise<Result> {
    const envelope = z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: schema }),
      z.object({ ok: z.literal(false), error: z.object({ code: id, message: z.string() }) }),
    ]);

    const result = envelope.parse(
      await this.api.sdk.plugins.callRpc({
        pluginId: "state-machines",
        method,
        input,
        outputSchema: envelope,
      }),
    );

    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

    return result.value;
  }

  async configure(input: WorkflowMachinePolicyInput, existingPolicy?: WorkflowPolicy) {
    const environment = await this.api.sdk.environments.get({ environmentId: input.environmentId });

    if (
      environment.managed ||
      environment.lifecycle.phase !== "active" ||
      environment.lifecycle.retireAt !== null
    )
      throw new Error(
        "ENVIRONMENT_LIFETIME_UNSUPPORTED: Sentry needs an active persistent environment",
      );

    if (existingPolicy && existingPolicy.projectId !== environment.projectId)
      throw new Error("SCOPE_MISMATCH: the existing workflow belongs to a different project");

    const machineId =
      existingPolicy?.machineId ??
      (
        await this.call(
          "sm_machine_create",
          {
            projectId: environment.projectId,
            name: "Omnyo Sentry root-cause maintenance",
            description:
              "Prove the root cause, verify repairs and delivery, and preserve unresolved evidence gaps.",
            template: "blank",
            requestId: requestId("create", {
              projectId: environment.projectId,
              routeId: input.routeId,
            }),
          },
          z.object({ machineId: id }),
        )
      ).machineId;

    const definition = z.record(z.string(), z.json()).parse(sentryWorkflowGraph(machineId, input));

    const versions = await this.call(
      "sm_machine_versions",
      { machineId },
      z.array(z.object({ versionId: id, number: z.number().int().positive() })),
    );

    if (existingPolicy && !versions.some((item) => item.versionId === existingPolicy.versionId))
      throw new Error(
        "SCOPE_MISMATCH: the saved workflow version no longer belongs to its machine",
      );
    let latestDefinition: z.infer<ReturnType<typeof z.json>> | null = null;

    for (const item of [...versions].sort((a, b) => b.number - a.number)) {
      const saved = await this.call(
        "sm_machine_version_get",
        { machineId, versionId: item.versionId },
        version,
      );

      if (saved.machineId !== machineId || saved.versionId !== item.versionId)
        throw new Error("SCOPE_MISMATCH: State Machines returned another version");

      latestDefinition ??= saved.definition;

      if (isDeepStrictEqual(saved.definition, definition))
        return machineIds.parse({ machineId, versionId: item.versionId });
    }

    let current = await this.call("sm_machine_draft_get", { machineId }, draft);

    if (current.machineId !== machineId)
      throw new Error("SCOPE_MISMATCH: State Machines returned another draft");

    if (!isDeepStrictEqual(current.document, definition)) {
      const blank = z
        .object({ states: z.array(z.json()).length(0), transitions: z.array(z.json()).length(0) })
        .safeParse(current.document).success;

      if (!blank && !isDeepStrictEqual(current.document, latestDefinition))
        throw new Error("REVISION_CONFLICT: preserve the independently edited workflow draft");

      current = await this.call(
        "sm_machine_draft_save",
        {
          machineId,
          expectedRevision: current.draftRevision,
          document: definition,
          requestId: requestId("save", { machineId, definition, revision: current.draftRevision }),
        },
        draft,
      );
    }

    const checked = await this.call(
      "sm_machine_validate",
      { machineId, revision: current.draftRevision },
      z.object({ revision, problems: z.array(problem) }),
    );

    if (
      checked.revision !== current.draftRevision ||
      checked.problems.some((item) => item.severity === "error")
    )
      throw new Error(
        `VALIDATION_FAILED: ${checked.problems.map((item) => item.message).join("; ")}`,
      );

    const published = await this.call(
      "sm_machine_publish",
      {
        machineId,
        expectedRevision: current.draftRevision,
        note: "Verified Omnyo Sentry root-cause workflow",
        requestId: requestId("publish", { machineId, definition, revision: current.draftRevision }),
      },
      z.object({ versionId: id }),
    );

    const saved = await this.call(
      "sm_machine_version_get",
      { machineId, versionId: published.versionId },
      version,
    );

    if (
      saved.machineId !== machineId ||
      saved.versionId !== published.versionId ||
      !isDeepStrictEqual(saved.definition, definition)
    )
      throw new Error("SCOPE_MISMATCH: the published workflow differs from the requested graph");

    return machineIds.parse({ machineId, versionId: published.versionId });
  }

  async start(policy: WorkflowPolicy, runId: string, stableRequestId: string, homeTitle: string) {
    const saved = await this.call(
      "sm_machine_version_get",
      { machineId: policy.machineId, versionId: policy.versionId },
      version,
    );

    if (saved.machineId !== policy.machineId || saved.versionId !== policy.versionId)
      throw new Error("SCOPE_MISMATCH: the configured workflow version changed");

    const initial = z
      .object({ initialContext: z.record(z.string(), z.json()) })
      .parse(saved.definition);

    const started = await this.call(
      "sm_instance_start",
      {
        machineId: policy.machineId,
        versionId: policy.versionId,
        environmentId: policy.environmentId,
        context: { ...initial.initialContext, runId },
        home: { kind: "new", title: homeTitle },
        requestId: stableRequestId,
      },
      z.object({ instanceId: id }),
    );

    const actual = await this.inspect(started.instanceId);

    if (actual.machineId !== policy.machineId || actual.versionId !== policy.versionId)
      throw new Error("SCOPE_MISMATCH: the started workflow uses another machine or version");

    return { instanceId: actual.instanceId, homeThreadId: actual.homeThreadId };
  }

  inspect(instanceId: string) {
    return this.call("sm_instance_inspect", { instanceId }, instance);
  }

  control(
    instanceId: string,
    expectedControlRevision: number,
    operation: "pause" | "pause-after-step" | "resume" | "stop",
    stableRequestId: string,
  ) {
    return this.call(
      "sm_instance_control",
      {
        instanceId,
        expectedControlRevision,
        operation: { kind: operation },
        requestId: stableRequestId,
      },
      instance,
    );
  }
}
