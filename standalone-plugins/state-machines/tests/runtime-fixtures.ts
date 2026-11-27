import Database from "better-sqlite3";
import { createStateMachineService, type StartHome } from "../src/service.js";
import type {
  StateMachineAdapter,
  ActionInvocation,
  HomeThreadRequest,
  InvocationObservation,
} from "../src/runtime/adapter.js";
import { createLocalCheckLoop } from "../templates/index.js";
import type { MachineDefinition, StateDefinition } from "../src/contracts/definition.js";

export class ControlledAdapter implements StateMachineAdapter {
  starts: ActionInvocation[] = [];
  retire?: (invocation: ActionInvocation) => Promise<void>;
  observations = new Map<string, InvocationObservation>();
  cancellations: string[] = [];
  persistent = true;
  homes: HomeThreadRequest[] = [];
  homeProblem: string | null = null;
  authorization = { allowed: true, reference: "test:local", scope: "fixture only" };
  async validateEnvironment() {
    return { persistent: this.persistent };
  }
  async createHomeThread(input: HomeThreadRequest) {
    this.homes.push(input);

    return { threadId: `home-${this.homes.length}` };
  }
  async homeThreadProblem() {
    return this.homeProblem;
  }
  async authorize() {
    return this.authorization;
  }
  async start(invocation: ActionInvocation): Promise<InvocationObservation> {
    this.starts.push(invocation);

    return (
      this.observations.get(invocation.attemptId) ?? {
        status: "running",
        confirmedLive: true,
        threadId: `thread-${invocation.attemptId}`,
      }
    );
  }
  async inspect(invocation: ActionInvocation): Promise<InvocationObservation> {
    return (
      this.observations.get(invocation.attemptId) ?? {
        status: "running",
        confirmedLive: true,
        threadId: `thread-${invocation.attemptId}`,
      }
    );
  }
  async cancel(invocation: ActionInvocation): Promise<InvocationObservation> {
    this.cancellations.push(invocation.attemptId);

    return this.inspect(invocation);
  }
  async readLog() {
    return { text: "", nextCursor: 0, truncated: false };
  }
  settle(
    invocation: ActionInvocation,
    observation: InvocationObservation = {
      status: "quiescent",
      confirmedLive: false,
      result: { type: "succeeded", payload: {} },
    },
  ): void {
    this.observations.set(invocation.attemptId, observation);
  }
}

export function setup(database = new Database(":memory:"), adapter = new ControlledAdapter()) {
  let now = 1_000_000;
  const service = createStateMachineService({ database, adapter, clock: () => now });

  return {
    database,
    adapter,
    service,
    advance: (ms = 1_000) => {
      now += ms;
    },
    time: () => now,
  };
}

export async function publish(
  fixture: ReturnType<typeof setup>,
  modify?: (definition: MachineDefinition) => MachineDefinition,
  home: StartHome = { kind: "none" },
) {
  const machine = fixture.service.createMachine({
    projectId: "project",
    name: "Fixture",
    requestId: "create",
  });

  const definition = createLocalCheckLoop({
    machineId: machine.machineId,
    environmentId: "environment",
  });

  const prepared = modify ? modify(definition) : definition;
  fixture.service.saveDraft({
    machineId: machine.machineId,
    expectedRevision: 0,
    document: prepared,
    requestId: "save",
  });

  const version = fixture.service.publishVersion({
    machineId: machine.machineId,
    expectedRevision: 1,
    requestId: "publish",
  });

  const instance = await fixture.service.startInstance({
    machineId: machine.machineId,
    versionId: version.versionId,
    environmentId: "environment",
    home,
    requestId: "start",
  });

  return { machine, definition: prepared, version, instance };
}

export function signal(
  service: ReturnType<typeof setup>["service"],
  instanceId: string,
  eventId = "one",
  type?: string,
) {
  const instance = service.inspectInstance({ instanceId });

  const subscription =
    service
      .eventCatalog({ instanceId })
      .find((entry) => entry.eventType === (type ?? "check.requested")) ??
    service.eventCatalog({ instanceId })[0]!;

  return service.signalInstance({
    instanceId,
    entryId: instance.entryId,
    subscriptionId: subscription.subscriptionId,
    epoch: subscription.epoch,
    sourceId: "test",
    eventId,
    subject: "fixture-subject",
    type: subscription.eventType,
    payload: {},
  });
}

export function agentGraph(definition: MachineDefinition): MachineDefinition {
  const state = definition.states.find((item) => item.kind === "command")!;

  const agent: StateDefinition = {
    kind: "agent",
    id: state.id,
    title: "Agent",
    subtitle: "",
    deadlineMs: 30_000,
    maxAttempts: 1,
    effect: "local-read",
    effectTarget: "fixture",
    annotations: { category: null },
    action: {
      prompt: "Return a bounded structured result.",
      environmentId: "environment",
      execution: { providerId: "subscription", model: "existing", reasoningLevel: "high" },
      permissionMode: "accept-edits",
      result: { outcomes: [{ name: "done", fields: [] }] },
    },
  };

  const success = definition.transitions.find(
    (edge) => edge.from === state.id && edge.trigger.kind === "succeeded",
  )!;

  return {
    ...definition,
    states: definition.states.map((item) => (item.id === state.id ? agent : item)),
    transitions: [
      ...definition.transitions.filter((edge) => edge.id !== success.id),
      { ...success, trigger: { kind: "result", outcome: "done" } },
      {
        ...success,
        id: "tr_no_result",
        trigger: { kind: "no-result" },
        to: definition.states.find((item) => item.kind === "manual")!.id,
      },
    ],
  };
}
