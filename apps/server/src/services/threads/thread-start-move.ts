import {
  getHost,
  getProjectSourceByHost,
  getQueuedThreadStartMessage,
  getThread,
  getThreadStartupContext,
  listPublicHosts,
  listQueuedThreadMessages,
  queuedThreadMessages,
  threads,
  type QueuedThreadMessageRow,
} from "@omnyo/db";
import {
  clampPermissionModeToCeiling,
  pathLooksRuntimeReadable,
  type JsonValue,
  type PermissionMode,
  type Thread,
} from "@omnyo/domain";
import type {
  ThreadStartMachineResponse,
  ThreadStartMachinesResponse,
  ThreadStartMoveInitiator,
  ThreadStartMoveRefusalCode,
} from "@omnyo/server-contract";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { getNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import { getProviderStates } from "../system/provider-states.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import {
  pendingThreadStartContextSchema,
  type PendingThreadStartContext,
} from "./dispatch-attempt.js";
import { withEvaluationLock } from "./dispatch-hooks.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { validateProviderSelection } from "./thread-environment-placement.js";
import type { ThreadProvisionEnvironmentIntent } from "./thread-startup-store.js";

export const TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID = "temporary-copy";

export type WaitingStartMoveRefusal = Extract<
  ThreadStartMachineResponse,
  { kind: "refused" }
>;

export interface MoveWaitingThreadStartArgs {
  threadId: string;
  hostId: string;
  expectedHostId: string;
  initiator: ThreadStartMoveInitiator;
  note?: string;
}

type ProviderIntent = Extract<
  ThreadProvisionEnvironmentIntent,
  { type: "provider" }
>;

export interface MoveRouteContext {
  inputs: JsonValue | null;
  originHostId: string;
  originSourcePath: string | null;
  targetHasCheckout: boolean;
  temporaryCopyAvailable: boolean;
}

export interface MoveRoute {
  environmentProviderId: string;
  inputs: JsonValue | null;
}

type MoveRule = (
  context: MoveRouteContext,
) => MoveRoute | WaitingStartMoveRefusal;

interface PreparedMove {
  kind: "prepared";
  thread: Thread;
  startRow: QueuedThreadMessageRow;
  previousStartupContext: string;
  context: PendingThreadStartContext;
  intent: ProviderIntent;
  targetIntent: ProviderIntent;
}

function refuse(
  code: ThreadStartMoveRefusalCode,
  message: string,
): WaitingStartMoveRefusal {
  return { kind: "refused", code, message };
}

function isAdoptFormWorktreeInputs(inputs: JsonValue | null): boolean {
  return (
    typeof inputs === "object" &&
    inputs !== null &&
    !Array.isArray(inputs) &&
    inputs.kind === "existing"
  );
}

const moveRules: ReadonlyMap<string, MoveRule> = new Map<string, MoveRule>([
  [
    DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
    ({ inputs }) => ({
      environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
      inputs,
    }),
  ],
  [
    DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    (context) => {
      if (isAdoptFormWorktreeInputs(context.inputs)) {
        return refuse(
          "not_movable",
          "This chat adopts an existing folder on its machine.",
        );
      }

      if (context.targetHasCheckout) {
        return {
          environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
          inputs: context.inputs,
        };
      }

      if (
        !context.temporaryCopyAvailable ||
        context.originSourcePath === null
      ) {
        return refuse(
          "no_checkout",
          "The target machine has no checkout of this project.",
        );
      }

      return {
        environmentProviderId: TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID,
        inputs: {
          sourceHostId: context.originHostId,
          sourcePath: context.originSourcePath,
          worktree: context.inputs,
        },
      };
    },
  ],
]);

export function routeWaitingStartMove(
  originProviderId: string,
  context: MoveRouteContext,
): MoveRoute | WaitingStartMoveRefusal {
  const rule = moveRules.get(originProviderId);

  return rule === undefined
    ? refuse("not_movable", "This chat works in its machine's own checkout.")
    : rule(context);
}

function storedPromptItems(content: string): unknown[] {
  const parsed: unknown = JSON.parse(content);

  if (Array.isArray(parsed)) return parsed.flat();

  return [];
}

function referencesMachineFile(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const reference = item as { type?: unknown; path?: unknown };

  return (
    (reference.type === "localFile" || reference.type === "localImage") &&
    typeof reference.path === "string" &&
    pathLooksRuntimeReadable(reference.path)
  );
}

function permitsMode(ceiling: PermissionMode, mode: PermissionMode): boolean {
  return (
    clampPermissionModeToCeiling({ ceiling, permissionMode: mode }) === mode
  );
}

function readPendingContext(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): { raw: string; context: PendingThreadStartContext } | null {
  const raw = getThreadStartupContext(deps.db, threadId);

  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);

  if (
    typeof value !== "object" ||
    value === null ||
    (value as { kind?: unknown }).kind !== "pending"
  ) {
    return null;
  }

  return { raw, context: pendingThreadStartContextSchema.parse(value) };
}

function checkMovableThread(
  deps: Pick<AppDeps, "db">,
  args: MoveWaitingThreadStartArgs,
): WaitingStartMoveRefusal | Omit<PreparedMove, "targetIntent"> {
  const thread = getThread(deps.db, args.threadId);

  if (thread === null) {
    return refuse("thread_not_found", "This chat no longer exists.");
  }

  if (
    thread.status !== "pending" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null
  ) {
    return refuse("not_waiting", "Only a waiting new chat can move.");
  }

  const pending = readPendingContext(deps, thread.id);

  if (pending === null) {
    return refuse("not_waiting", "Only a waiting new chat can move.");
  }

  const intent = pending.context.environmentIntent;

  if (intent.type !== "provider" || intent.machine.type !== "existing") {
    return refuse(
      "not_movable",
      "This chat shares an environment or starts a new machine.",
    );
  }

  if (intent.machine.hostId !== args.expectedHostId) {
    return refuse("machine_changed", "This chat already changed machines.");
  }

  if (args.hostId === intent.machine.hostId) {
    return refuse("same_machine", "This chat is already on that machine.");
  }

  if (
    pending.context.fork !== null ||
    pending.context.providerInput !== undefined
  ) {
    return refuse("not_movable", "A forked chat stays with its source.");
  }

  if (args.initiator.kind === "plugin" && pending.context.machinePinned) {
    return refuse("pinned", "This chat is pinned to its machine.");
  }

  const startRow = getQueuedThreadStartMessage(deps.db, thread.id);

  if (startRow === null) {
    return refuse(
      "no_waiting_start",
      "This chat has no waiting first message.",
    );
  }

  if (startRow.claimedAt !== null) {
    return refuse("start_claimed", "This chat is starting right now.");
  }

  const rows = listQueuedThreadMessages(deps.db, thread.id);

  if (
    rows.some((row) =>
      storedPromptItems(row.content).some(referencesMachineFile),
    )
  ) {
    return refuse(
      "local_attachment",
      "This chat attaches a file from its machine.",
    );
  }

  return {
    kind: "prepared",
    thread,
    startRow,
    previousStartupContext: pending.raw,
    context: pending.context,
    intent,
  };
}

export interface StartMoveTargetProbe {
  agentReady(args: { hostId: string; providerId: string }): Promise<boolean>;
  modelOffered(args: {
    hostId: string;
    providerId: string;
    model: string;
  }): Promise<boolean>;
}

export function hostRpcTargetProbe(deps: AppDeps): StartMoveTargetProbe {
  return {
    async agentReady({ hostId, providerId }) {
      const states = await getProviderStates(deps, { hostId });

      return (
        states.providers.find((provider) => provider.providerId === providerId)
          ?.status === "ready"
      );
    },
    async modelOffered({ hostId, providerId, model }) {
      const catalog = await resolveSystemProviderModels(deps, {
        hostId,
        providerId,
      });

      return (
        catalog.modelLoadError === null &&
        [...catalog.models, ...catalog.selectedOnlyModels].some(
          (entry) => entry.id === model || entry.model === model,
        )
      );
    },
  };
}

async function checkTarget(
  deps: AppDeps,
  probe: StartMoveTargetProbe,
  args: { thread: Thread; startRow: QueuedThreadMessageRow; hostId: string },
): Promise<WaitingStartMoveRefusal | null> {
  const host = getHost(deps.db, args.hostId);
  const withStatus = getNonDestroyedHostWithStatus(deps, args.hostId);

  if (
    host === null ||
    withStatus === null ||
    withStatus.status !== "connected" ||
    host.phase !== "active" ||
    host.availability !== "available" ||
    host.type !== "persistent"
  ) {
    return refuse(
      "target_unavailable",
      "That machine can't take new chats now.",
    );
  }

  if (!permitsMode(host.maxPermissionMode, args.startRow.permissionMode)) {
    return refuse(
      "permission_ceiling",
      `That machine allows up to ${host.maxPermissionMode} mode.`,
    );
  }

  const agentReady = await probe.agentReady({
    hostId: args.hostId,
    providerId: args.thread.providerId,
  });

  if (!agentReady) {
    return refuse(
      "agent_not_ready",
      "This chat's agent isn't ready on that machine.",
    );
  }

  const modelOffered = await probe.modelOffered({
    hostId: args.hostId,
    providerId: args.thread.providerId,
    model: args.startRow.model,
  });

  if (!modelOffered) {
    return refuse(
      "model_unavailable",
      "That machine doesn't offer this chat's model.",
    );
  }

  return null;
}

async function prepareMove(
  deps: AppDeps,
  probe: StartMoveTargetProbe,
  args: MoveWaitingThreadStartArgs,
): Promise<PreparedMove | WaitingStartMoveRefusal> {
  const movable = checkMovableThread(deps, args);

  if (movable.kind === "refused") return movable;

  if (!moveRules.has(movable.intent.environmentProviderId)) {
    return refuse(
      "not_movable",
      "This chat works in its machine's own checkout.",
    );
  }

  const targetIssue = await checkTarget(deps, probe, {
    thread: movable.thread,
    startRow: movable.startRow,
    hostId: args.hostId,
  });

  if (targetIssue !== null) return targetIssue;

  const route = routeWaitingStartMove(movable.intent.environmentProviderId, {
    inputs: movable.intent.inputs,
    originHostId: args.expectedHostId,
    originSourcePath:
      getProjectSourceByHost(
        deps.db,
        movable.thread.projectId,
        args.expectedHostId,
      )?.path ?? null,
    targetHasCheckout:
      getProjectSourceByHost(deps.db, movable.thread.projectId, args.hostId) !==
      null,
    temporaryCopyAvailable:
      getEnvironmentProvider(TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID) !==
      undefined,
  });

  if ("kind" in route) return route;

  const record = getEnvironmentProvider(route.environmentProviderId);

  if (record === undefined) {
    return refuse("no_checkout", "That machine can't host this chat's code.");
  }

  try {
    await validateProviderSelection(deps, record, {
      hostId: args.hostId,
      inputs: route.inputs,
      projectId: movable.thread.projectId,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return refuse("placement_refused", error.message);
    }

    throw error;
  }

  return {
    ...movable,
    targetIntent: {
      type: "provider",
      environmentProviderId: route.environmentProviderId,
      machine: { type: "existing", hostId: args.hostId },
      inputs: route.inputs,
      selectionResolved: false,
    },
  };
}

function commitMove(
  deps: Pick<AppDeps, "db">,
  prepared: PreparedMove,
  args: MoveWaitingThreadStartArgs,
): WaitingStartMoveRefusal | null {
  return deps.db.transaction(
    (tx) => {
      const claimed = tx
        .select({ id: queuedThreadMessages.id })
        .from(queuedThreadMessages)
        .where(
          and(
            eq(queuedThreadMessages.threadId, prepared.thread.id),
            isNotNull(queuedThreadMessages.claimedAt),
          ),
        )
        .limit(1)
        .get();

      if (claimed !== undefined) {
        return refuse("start_claimed", "This chat is starting right now.");
      }

      const startRow = getQueuedThreadStartMessage(tx, prepared.thread.id);

      if (startRow?.id !== prepared.startRow.id) {
        return refuse("machine_changed", "This chat changed while moving.");
      }

      const nextContext: PendingThreadStartContext = {
        ...prepared.context,
        environmentIntent: prepared.targetIntent,
        machinePinned:
          args.initiator.kind === "person"
            ? true
            : prepared.context.machinePinned,
        moveNote: args.note ?? null,
      };

      const changes = tx
        .update(threads)
        .set({
          startupContext: JSON.stringify({ kind: "pending", ...nextContext }),
        })
        .where(
          and(
            eq(threads.id, prepared.thread.id),
            eq(threads.status, "pending"),
            isNull(threads.archivedAt),
            isNull(threads.deletedAt),
            eq(threads.startupContext, prepared.previousStartupContext),
          ),
        )
        .run().changes;

      return changes === 1
        ? null
        : refuse("machine_changed", "This chat changed while moving.");
    },
    { behavior: "immediate" },
  );
}

export async function moveWaitingThreadStart(
  deps: AppDeps,
  args: MoveWaitingThreadStartArgs,
  probe: StartMoveTargetProbe = hostRpcTargetProbe(deps),
): Promise<ThreadStartMachineResponse> {
  const prepared = await prepareMove(deps, probe, args);

  if (prepared.kind === "refused") return prepared;

  const conflict = await withEvaluationLock(async () =>
    commitMove(deps, prepared, args),
  );

  if (conflict !== null) return conflict;

  deps.hub.notifyThread(prepared.thread.id, ["environment-changed"]);
  requestQueuedMessageDispatch(deps, {
    kind: "start-moved",
    queuedMessageId: prepared.startRow.id,
    threadId: prepared.thread.id,
  });

  return {
    kind: "moved",
    threadId: prepared.thread.id,
    fromHostId: args.expectedHostId,
    toHostId: args.hostId,
    environmentProviderId: prepared.targetIntent.environmentProviderId,
  };
}

export async function listWaitingStartMachines(
  deps: AppDeps,
  args: { threadId: string; initiator: ThreadStartMoveInitiator },
  probe: StartMoveTargetProbe = hostRpcTargetProbe(deps),
): Promise<ThreadStartMachinesResponse> {
  const pending = readPendingContext(deps, args.threadId);

  const intent = pending?.context.environmentIntent;

  const originHostId =
    intent?.type === "provider" && intent.machine.type === "existing"
      ? intent.machine.hostId
      : null;

  const hosts = listPublicHosts(deps.db);

  const machines = await Promise.all(
    hosts
      .filter((host) => host.id !== originHostId)
      .map(async (host) => {
        if (originHostId === null) {
          return {
            hostId: host.id,
            name: host.name,
            eligible: false,
            environmentProviderId: null,
            reason: "Only a waiting new chat can move.",
          };
        }

        const prepared = await prepareMove(deps, probe, {
          threadId: args.threadId,
          hostId: host.id,
          expectedHostId: originHostId,
          initiator: args.initiator,
        });

        return prepared.kind === "refused"
          ? {
              hostId: host.id,
              name: host.name,
              eligible: false,
              environmentProviderId: null,
              reason: prepared.message,
            }
          : {
              hostId: host.id,
              name: host.name,
              eligible: true,
              environmentProviderId:
                prepared.targetIntent.environmentProviderId,
              reason: null,
            };
      }),
  );

  return { originHostId, machines };
}
