import type { JsonObject, JsonValue, StateDefinition } from "../contracts/definition.js";

export type ActionState = Extract<StateDefinition, { kind: "agent" | "command" }>;

export interface ActionInvocation {
  instanceId: string;
  entryId: string;
  invocationId: string;
  attemptId: string;
  generation: number;
  specHash: string;
  projectId: string;
  environmentId: string;
  state: ActionState;
  context: JsonObject;
  dispatchedAt: number;
  deadlineAt: number;
  threadId: string | null;
  attempt: number;
  homeThreadId: string | null;
}

export interface HomeThreadRequest {
  instanceId: string;
  projectId: string;
  environmentId: string;
  machineName: string;
  requestId: string;
}

export interface InvocationResult {
  type: "succeeded" | "failed" | "timed-out" | "cancelled" | "no-result" | "result";
  outcome?: string;
  payload: JsonValue;
}

export interface InvocationObservation {
  status: "running" | "quiescent" | "not-found" | "uncertain";
  confirmedLive: boolean;
  threadId?: string;
  result?: InvocationResult;
  retrySafe?: boolean;
  retainedBytes?: number;
  waitingForPerson?: { threadId: string; interactionId: string };
  reason?: string;
}

export interface StateMachineAdapter {
  validateEnvironment(input: {
    projectId: string;
    environmentId: string;
  }): Promise<{ persistent: boolean }>;
  createHomeThread(input: HomeThreadRequest): Promise<{ threadId: string }>;
  homeThreadProblem(input: { projectId: string; threadId: string }): Promise<string | null>;
  start(invocation: ActionInvocation): Promise<InvocationObservation>;
  retire?(invocation: ActionInvocation): Promise<void>;
  inspect(invocation: ActionInvocation): Promise<InvocationObservation>;
  cancel(invocation: ActionInvocation): Promise<InvocationObservation>;
  readLog(input: {
    invocation: ActionInvocation;
    cursor: number;
    limit: number;
  }): Promise<{ text: string; nextCursor: number; truncated: boolean }>;
  authorize?(
    input: ActionInvocation,
  ): Promise<{ allowed: boolean; reference?: string; scope?: string }>;
  observe?(input: {
    instanceId: string;
    entryId: string;
    subscriptionId: string;
    state: StateDefinition;
    context: JsonObject;
    environmentId: string;
  }): Promise<{
    value: JsonValue;
    sourceVersion?: number;
    event?: { type: string; payload: JsonValue; subject: string };
  }>;
}

export type Lifecycle = "running" | "paused" | "stopping" | "stopped" | "completed" | "failed";

export type Phase =
  | "waiting"
  | "queued"
  | "executing"
  | "retry-wait"
  | "needs-person"
  | "uncertain";

export type AttemptStatus =
  | "pending"
  | "dispatching"
  | "running"
  | "result-ready"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancel-requested"
  | "cancelled"
  | "uncertain";

export interface Actor {
  kind: "client" | "worker";
  threadId?: string;
}
