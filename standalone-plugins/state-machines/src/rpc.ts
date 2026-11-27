import { type PluginApi, type PluginRpcHandlers } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { type JsonValue, type MachineDefinition, isJsonObject } from "./contracts/definition.js";
import {
  type RpcAttentionView,
  type RpcDraftView,
  type RpcEnvironment,
  type RpcHistoryEntry,
  type RpcInstanceView,
  stateMachinesRpc,
} from "./contracts/rpc.js";
import { type Machine, type Version } from "./data/records.js";
import {
  type DefinitionProblem,
  canonicalJson,
  compileDraft,
  DefinitionValidationError,
} from "./definition/index.js";
import { type EditorDraft } from "./definition/draft.js";
import { type Actor } from "./runtime/adapter.js";
import { StateMachineError, StateMachineService, type InstanceView } from "./service.js";

interface RpcError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

type Envelope<Value> = { ok: true; value: Value } | { ok: false; error: RpcError };

export interface RpcOptions {
  listEnvironments(projectId: string): Promise<RpcEnvironment[]>;
}

const actor: Actor = { kind: "client" };

async function attempt<Value>(operation: () => Value | Promise<Value>): Promise<Envelope<Value>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof StateMachineError) {
      const issues = z
        .array(z.object({ path: z.string(), message: z.string() }))
        .safeParse(error.details);

      const failure: RpcError = { code: error.code, message: error.message };

      if (issues.success) failure.issues = issues.data;

      return { ok: false, error: failure };
    }

    if (error instanceof DefinitionValidationError)
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Resolve the definition problems.",
          issues: error.problems.map(({ path, message }) => ({ path, message })),
        },
      };

    if (error instanceof z.ZodError)
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "The request does not match the required fields.",
          issues: error.issues.map((issue) => ({
            path: `/${issue.path.join("/")}`,
            message: issue.message,
          })),
        },
      };

    return {
      ok: false,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        message: "This operation could not be completed. The stored workflow has not been reset.",
      },
    };
  }
}

function changes(
  current: EditorDraft,
  base: MachineDefinition | null,
): RpcDraftView["changeSummary"] {
  const statesBefore = new Map(base?.states.map((state) => [state.id, state]) ?? []);
  const statesAfter = new Map(current.states.map((state) => [state.id, state]));
  const edgesBefore = new Map(base?.transitions.map((edge) => [edge.id, edge]) ?? []);
  const edgesAfter = new Map(current.transitions.map((edge) => [edge.id, edge]));
  const stateChanges: RpcDraftView["changeSummary"]["states"]["changed"] = [];

  for (const state of current.states) {
    const previous = statesBefore.get(state.id);

    if (!previous || canonicalJson(previous) === canonicalJson(state)) continue;
    const before = new Map(Object.entries(previous));
    const after = new Map(Object.entries(state));

    const fields = [...new Set([...before.keys(), ...after.keys()])].filter((key) => {
      if (!before.has(key) || !after.has(key)) return true;

      return canonicalJson(before.get(key)) !== canonicalJson(after.get(key));
    });

    stateChanges.push({ stateId: state.id, fields });
  }

  return {
    states: {
      added: [...statesAfter.keys()].filter((key) => !statesBefore.has(key)),
      removed: [...statesBefore.keys()].filter((key) => !statesAfter.has(key)),
      changed: stateChanges,
    },
    transitions: {
      added: [...edgesAfter.keys()].filter((key) => !edgesBefore.has(key)),
      removed: [...edgesBefore.keys()].filter((key) => !edgesAfter.has(key)),
      changed: current.transitions.flatMap((edge) => {
        const before = edgesBefore.get(edge.id);

        return before && canonicalJson(before) !== canonicalJson(edge) ? [edge.id] : [];
      }),
    },
  };
}

function problems(document: EditorDraft, items: DefinitionProblem[]): RpcDraftView["problems"] {
  return items.map((problem) => {
    const segments = problem.path.split("/");
    const stateIndex = segments[1] === "states" ? Number(segments[2]) : -1;
    const transitionIndex = segments[1] === "transitions" ? Number(segments[2]) : -1;

    return {
      ...problem,
      stateId: document.states[stateIndex]?.id ?? null,
      transitionId: document.transitions[transitionIndex]?.id ?? null,
    };
  });
}

function draftView(service: StateMachineService, machineId: string): RpcDraftView {
  const draft = service.getDraft({ machineId }, actor);
  const versions = service.listVersions({ machineId }, actor);
  const latest = versions[0];
  const validation = compileDraft(draft.document);

  return {
    machineId,
    draftRevision: draft.revision,
    baseVersionNumber: latest?.number ?? null,
    document: draft.document,
    problems: problems(draft.document, validation.problems),
    changeSummary: changes(draft.document, latest?.document ?? null),
    updatedAt: draft.updatedAt,
  };
}

function versionSummary(service: StateMachineService, version: Version) {
  return {
    versionId: version.versionId,
    number: version.number,
    publishedAt: version.createdAt,
    note: version.note,
    instanceCount: service.countVersionInstances({ versionId: version.versionId }),
  };
}

function instanceSummary(instance: InstanceView) {
  return {
    instanceId: instance.instanceId,
    versionId: instance.versionId,
    versionNumber: instance.versionNumber,
    lifecycle: instance.lifecycle,
    phase: instance.phase,
    stateId: instance.stateId,
    stateTitle: instance.summary,
    startedAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

function machineSummary(service: StateMachineService, machine: Machine) {
  const draft = draftView(service, machine.machineId);
  const change = draft.changeSummary;

  const latest = machine.publishedVersionId
    ? service.getVersion({ versionId: machine.publishedVersionId }, actor)
    : null;

  return {
    machineId: machine.machineId,
    projectId: machine.projectId,
    name: machine.name,
    description: machine.description,
    latestVersionId: latest?.versionId ?? null,
    latestVersionNumber: latest?.number ?? null,
    draftChangeCount: Math.max(
      latest && canonicalJson(latest.document) !== canonicalJson(draft.document) ? 1 : 0,
      change.states.added.length +
        change.states.removed.length +
        change.states.changed.length +
        change.transitions.added.length +
        change.transitions.removed.length +
        change.transitions.changed.length,
    ),
    instances: service.listInstances({ machineId: machine.machineId }, actor).map(instanceSummary),
    openAttentionCount: service.countMachineAttention({ machineId: machine.machineId }),
    updatedAt: machine.updatedAt,
  };
}

function instanceView(service: StateMachineService, instance: InstanceView): RpcInstanceView {
  const version = service.getVersion({ versionId: instance.versionId }, actor);
  const machine = service.getDraft({ machineId: instance.machineId }, actor);

  return {
    instanceId: instance.instanceId,
    machineId: instance.machineId,
    machineName: machine.document.name,
    versionId: instance.versionId,
    versionNumber: instance.versionNumber,
    latestVersionNumber: instance.latestVersionNumber,
    revision: instance.revision,
    controlRevision: instance.controlRevision,
    asOf: instance.asOf,
    lifecycle: instance.lifecycle,
    phase: instance.phase,
    pauseAfterStep: instance.pauseAfterStep,
    stateId: instance.stateId,
    entryId: instance.entryId,
    summary: instance.summary,
    pendingResultCount: instance.pendingResultCount,
    expiredWhilePaused:
      instance.lifecycle === "paused"
        ? instance.steps.flatMap((step) =>
            step.deadlineAt !== null && step.deadlineAt <= instance.asOf
              ? [
                  version.document.states.find((state) => state.id === step.stateId)?.title ??
                    step.stateId,
                ]
              : [],
          )
        : [],
    lastTransition: instance.lastTransition,
    context: instance.context.map(({ path, display, value }) => ({
      path,
      display,
      isHash: z
        .string()
        .regex(/^[a-f\d]{40}(?:[a-f\d]{24})?$/i)
        .safeParse(value).success,
    })),
    budgets: instance.budgets,
    cyclesCompleted: instance.cyclesCompleted,
    steps: instance.steps.map((step) => ({
      ...step,
      environmentLabel: step.environmentId,
      markUnknownAllowed:
        instance.lifecycle === "stopping" &&
        !step.confirmedLive &&
        ["dispatching", "running", "result-ready", "cancel-requested", "uncertain"].includes(
          step.status,
        ),
    })),
    unknownOutcomes: instance.unknownOutcomes.map((item) => ({
      ...item,
      stateId:
        instance.steps.find((step) => step.invocationId === item.invocationId)?.stateId ??
        instance.stateId,
    })),
    standingAuthority: instance.standingAuthority,
    quarantined: instance.quarantined,
    homeThreadId: instance.homeThreadId,
    definition: version.document,
  };
}

export function attentionView(
  service: StateMachineService,
  item: ReturnType<StateMachineService["listAttention"]>[number],
): RpcAttentionView {
  const instance = service.inspectInstance({ instanceId: item.instanceId }, actor);
  const version = service.getVersion({ versionId: instance.versionId }, actor);
  const state = version.document.states.find((candidate) => candidate.id === instance.stateId);

  const kind = z
    .enum([
      "gate",
      "uncertain",
      "retries-exhausted",
      "authority-required",
      "instance-failed",
      "non-yielding-cycle",
      "capability-unavailable",
      "agent-input",
    ])
    .parse(item.kind);

  return {
    attentionId: item.attentionId,
    kind,
    machineId: instance.machineId,
    machineName: service.getDraft({ machineId: instance.machineId }, actor).document.name,
    instanceId: item.instanceId,
    entryId: item.entryId,
    stateId: instance.stateId,
    stateTitle: state?.title ?? instance.stateId,
    invocationId: item.invocationId,
    revision: instance.revision,
    title: item.title,
    bodyMarkdown: item.bodyMarkdown,
    evidenceSummary: item.evidenceSummary,
    cause: item.cause,
    homeThreadId: instance.homeThreadId,
    createdAt: item.createdAt,
    decisions: item.decisions.map((decision) => {
      const target =
        decision.targetStateId === null
          ? null
          : (version.document.states.find((candidate) => candidate.id === decision.targetStateId) ??
            null);

      return {
        ...decision,
        evidenceRequired: kind !== "uncertain" && decision.evidenceRequired,
        targetTitle:
          decision.targetStateId === null || target?.kind === "choice"
            ? null
            : (target?.title ?? decision.targetStateId),
        evidencePrompt:
          state?.kind === "manual"
            ? (state.decisions.find((candidate) => candidate.id === decision.name)
                ?.evidencePrompt ?? "")
            : kind !== "uncertain" && decision.evidenceRequired
              ? "Describe the verified outcome and evidence."
              : "",
        acknowledgement:
          target && "effect" in target && target.effect === "external-write"
            ? `I understand “${target.title}” can make external changes.`
            : null,
      };
    }),
  };
}

function stringField(data: JsonValue, key: string): string | null {
  if (!isJsonObject(data)) return null;
  const parsed = z.string().safeParse(data[key]);

  return parsed.success ? parsed.data : null;
}

function attentionOpenedText(kind: string): string {
  switch (kind) {
    case "gate":
      return "Waiting for your decision";
    case "uncertain":
      return "Outcome unknown";
    case "retries-exhausted":
      return "Retries used up";
    case "authority-required":
      return "Needs approval Omnyo can't verify";
    case "instance-failed":
      return "Run stopped on an error";
    case "non-yielding-cycle":
      return "Cycle limit reached";
    case "capability-unavailable":
      return "Capability unavailable";
    case "agent-input":
      return "The step's agent asked a question";
    default:
      return "Needs attention";
  }
}

type HistoryItem = ReturnType<StateMachineService["listHistory"]>["items"][number];

const stepHistoryKinds = new Set(["attempt-ended", "result-ready", "dispatch", "retired"]);

const plainHistoryKindSchema = z.enum(["transition", "event", "control", "decision"]);

function historyKind(item: HistoryItem, attentionKind: string | null): RpcHistoryEntry["kind"] {
  if (stepHistoryKinds.has(item.kind)) return "step";

  if (item.kind === "started") return "control";

  if (attentionKind === "gate") return "decision";

  const plain = plainHistoryKindSchema.safeParse(item.kind);

  return plain.success ? plain.data : "problem";
}

function historyText(item: HistoryItem, attentionKind: string | null): string {
  if (item.kind === "transition")
    return `${stringField(item.data, "from") ?? "State"} → ${stringField(item.data, "to") ?? "state"}`;

  if (item.kind === "dispatch") return "Step started";

  if (item.kind === "retired") return "Step closed";

  if (attentionKind !== null) return attentionOpenedText(attentionKind);

  const operation = stringField(item.data, "operation");

  if (operation) return `Control: ${operation}`;

  const decision = stringField(item.data, "decision");

  if (decision) return `Decision: ${decision}`;

  if (item.kind === "result-ready") return "Result submitted · finishing";

  const status = stringField(item.data, "status");

  if (status) return `Step ${status}`;

  return (
    stringField(item.data, "type") ??
    (item.kind === "started" ? "Instance started" : (stringField(item.data, "title") ?? item.kind))
  );
}

function historyEntry(item: HistoryItem): RpcHistoryEntry {
  const attentionKind = item.kind === "problem" ? stringField(item.data, "kind") : null;
  const kind = historyKind(item, attentionKind);
  const client = item.kind === "control" || item.kind === "decision" || item.kind === "started";
  const to = stringField(item.data, "to");
  const status = stringField(item.data, "status");
  const text = historyText(item, attentionKind);

  return {
    seq: item.sequence,
    at: item.at,
    kind,
    actor: client ? { kind: "client" } : { kind: "system" },
    text,
    stateId: to ?? stringField(item.data, "stateId"),
    invocationId: stringField(item.data, "invocationId"),
    disposition: stringField(item.data, "disposition"),
    coalescedCount: 0,
    detail: isJsonObject(item.data)
      ? Object.entries(item.data).map(([label, value]) => ({ label, value: canonicalJson(value) }))
      : [{ label: "Data", value: canonicalJson(item.data) }],
    problem:
      kind === "problem" || status === "failed" || status === "timed-out" || status === "uncertain",
  };
}

export function createStateMachineRpcHandlers(
  service: StateMachineService,
  options: RpcOptions,
): PluginRpcHandlers<typeof stateMachinesRpc> {
  return {
    sm_machine_list: (input) =>
      attempt(() =>
        service
          .listMachines({ projectId: input.projectId ?? undefined, limit: input.limit }, actor)
          .map((machine) => machineSummary(service, machine)),
      ),
    sm_machine_create: (input) =>
      attempt(() => ({ machineId: service.createMachine(input, actor).machineId })),
    sm_machine_draft_get: (input) => attempt(() => draftView(service, input.machineId)),
    sm_machine_draft_save: (input) =>
      attempt(() => {
        service.saveDraft(input, actor);

        return draftView(service, input.machineId);
      }),
    sm_machine_validate: (input) =>
      attempt(() => {
        const checked = service.validateDraft(input, actor);
        const draft = draftView(service, input.machineId);

        return {
          revision: draft.draftRevision,
          problems: problems(draft.document, checked.problems),
          nextVersionNumber: (draft.baseVersionNumber ?? 0) + 1,
          changeSummary: draft.changeSummary,
        };
      }),
    sm_machine_publish: (input) =>
      attempt(() => {
        const version = service.publishVersion(input, actor);

        return { versionId: version.versionId, number: version.number };
      }),
    sm_machine_versions: (input) =>
      attempt(() =>
        service.listVersions(input, actor).map((version) => versionSummary(service, version)),
      ),
    sm_machine_version_get: (input) =>
      attempt(() => {
        const version = service.getVersion(input, actor);

        if (version.machineId !== input.machineId)
          throw new StateMachineError(
            "SCOPE_MISMATCH",
            "The version belongs to a different machine.",
          );

        return {
          ...versionSummary(service, version),
          machineId: version.machineId,
          definition: version.document,
        };
      }),
    sm_machine_export: (input) =>
      attempt(() => ({ definition: service.exportDefinition(input, actor) })),
    sm_instance_list: (input) =>
      attempt(() => service.listInstances(input, actor).map(instanceSummary)),
    sm_instance_start: ({ home, ...input }) =>
      attempt(async () => ({
        instanceId: (
          await service.startInstance(
            {
              ...input,
              home:
                home?.kind === "thread"
                  ? { kind: "thread", threadId: home.threadId }
                  : { kind: "new", title: home?.title ?? null },
            },
            actor,
          )
        ).instanceId,
      })),
    sm_instance_inspect: (input) =>
      attempt(() => instanceView(service, service.inspectInstance(input, actor))),
    sm_instance_control: (input) =>
      attempt(() => {
        const operation = input.operation;

        const specific =
          operation.kind === "cancel-step" || operation.kind === "mark-unknown"
            ? { entryId: operation.entryId, invocationId: operation.invocationId }
            : {};

        const unknown =
          operation.kind === "mark-unknown"
            ? {
                expectedRevision: operation.expectedRevision,
                evidence: operation.evidence,
                reason: operation.reason ?? "Outcome could not be verified",
                acknowledged: operation.acknowledged,
              }
            : {};

        return instanceView(
          service,
          service.controlInstance(
            {
              instanceId: input.instanceId,
              expectedControlRevision: input.expectedControlRevision,
              operation: operation.kind,
              requestId: input.requestId,
              ...specific,
              ...unknown,
            },
            actor,
          ),
        );
      }),
    sm_instance_signal: (input) =>
      attempt(() => {
        const receipt = service.signalInstance(
          {
            instanceId: input.instanceId,
            entryId: input.entryId,
            subscriptionId: input.subscriptionId,
            epoch: input.epoch,
            sourceId: input.sourceId ?? "Omnyo client",
            eventId: input.eventId ?? input.requestId,
            subject: input.subject ?? input.entryId,
            type: input.eventType,
            payload: input.payload,
            requestId: input.requestId,
          },
          actor,
        );

        return { eventId: receipt.eventId };
      }),
    sm_attention_list: (input) =>
      attempt(() =>
        service
          .listAttention(
            { instanceId: input.instanceId ?? undefined, machineId: input.machineId ?? undefined },
            actor,
          )
          .map((item) => attentionView(service, item)),
      ),
    sm_attention_resolve: (input) =>
      attempt(async () => {
        await service.resolveAttention(input, actor);

        return { resolved: true as const };
      }),
    sm_history_list: (input) =>
      attempt(() => {
        const kinds = input.kinds.flatMap((kind) =>
          kind === "step"
            ? ["result-ready", "attempt-ended"]
            : kind === "control"
              ? ["started", "control"]
              : [kind],
        );

        const page = service.listHistory(
          {
            instanceId: input.instanceId,
            before: input.before ?? undefined,
            after: input.after,
            limit: input.limit,
            kinds,
          },
          actor,
        );

        return {
          entries: page.items.map(historyEntry),
          nextCursor: page.items.length === input.limit ? page.nextCursor : null,
        };
      }),
    sm_state_history: (input) =>
      attempt(() => {
        const page = service.listStateHistory(
          {
            instanceId: input.instanceId,
            stateId: input.stateId ?? undefined,
            before: input.before ?? undefined,
            after: input.after,
            limit: input.limit,
          },
          actor,
        );

        return {
          visits: page.items.map((entry) => ({
            entryId: entry.entryId,
            enteredAt: entry.enteredAt,
            exitedAt: entry.exitedAt,
            exitTrigger: entry.exitTrigger,
            attempts: entry.attempts,
          })),
          nextCursor: page.items.length === input.limit ? page.nextCursor : null,
          retainedSince: page.retainedSince,
        };
      }),
    sm_events_catalog: (input) =>
      attempt(() => {
        const instance = service.inspectInstance(input, actor);

        return service.eventCatalog(input, actor).map((entry) => ({
          eventType: entry.eventType,
          label: entry.label,
          source: entry.source,
          personOnly: entry.personOnly,
          subscriptionId: entry.subscriptionId,
          epoch: entry.epoch,
          stateIds: [instance.stateId],
        }));
      }),
    sm_log_read: (input) =>
      attempt(async () => {
        const page = await service.readLog(input, actor);

        return {
          ...page,
          nextCursor:
            page.nextCursor === input.cursor && page.text.length === 0 ? null : page.nextCursor,
        };
      }),
    sm_environment_list: (input) => attempt(() => options.listEnvironments(input.projectId)),
  };
}

export function registerStateMachineRpc(
  api: PluginApi,
  service: StateMachineService,
  options: RpcOptions,
): void {
  api.rpc.register(stateMachinesRpc, createStateMachineRpcHandlers(service, options), {
    experimental_discoverable: true,
    experimental_description:
      "Durable State Machines definitions, instances, decisions and execution history.",
  });
}
