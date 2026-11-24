import {
  deleteNativeThreadImport,
  findNativeSessionClaim,
  getEnvironment,
  getLatestThreadSequence,
  getThread,
  insertConstructedThreadEventsInTransaction,
  markThreadDeleted,
  NativeThreadImportConflictError,
  type NativeSessionClaim,
} from "@omnyo/db";
import { canonicalizeHostPath, type Thread } from "@omnyo/domain";
import type {
  ImportNativeThreadRequest,
  ImportNativeThreadResponse,
} from "@omnyo/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { emitPluginThreadDeleted } from "../plugins/plugin-thread-events.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  assertNativeImportTurnsValid,
  buildNativeImportHistoryRows,
} from "./native-import-history.js";
import { resolveProjectExecutionDefaultsForCreate } from "./project-execution-defaults.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { resolveCatalogExecutionDefaults } from "./thread-create.js";
import {
  createThreadRecord,
  requirePublicProjectForThreadCreate,
} from "./thread-create-helpers.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import {
  requireEnvironmentPlacementHost,
  resolveThreadEnvironmentPlacement,
} from "./thread-environment-placement.js";
import { createClientTurnRequestId } from "./thread-events.js";
import { requestThreadStorageDeletion } from "./thread-lifecycle.js";
import { scheduleThreadProvisioningAdvance } from "./thread-provisioning.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import {
  createThreadStartup,
  saveThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
} from "./thread-startup-store.js";

export const NATIVE_IMPORT_MAX_BODY_BYTES = 32 * 1024 * 1024;

function alreadyClaimed(claim: NativeSessionClaim): ImportNativeThreadResponse {
  return {
    kind: "already-claimed",
    threadId: claim.threadId,
    via: claim.via,
  };
}

function sourceKey(request: ImportNativeThreadRequest) {
  return {
    hostId: request.hostId,
    providerId: request.providerId,
    sourceProviderThreadId: request.sourceProviderThreadId,
  };
}

function discardFailedImport(deps: AppDeps, thread: Thread): void {
  deleteNativeThreadImport(deps.db, thread.id);
  emitPluginThreadDeleted({
    ...thread,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  });

  const deleted = markThreadDeleted(deps.db, deps.hub, {
    threadId: thread.id,
  });

  if (deleted) {
    requestThreadStorageDeletion(
      deps,
      deleted,
      deleted.environmentId
        ? getEnvironment(deps.db, deleted.environmentId)
        : null,
    );
  }
}

async function seedImportedThread(
  deps: AppDeps,
  args: {
    cwd: string;
    environmentIntent: ThreadProvisionEnvironmentIntent;
    executionDefaults: Awaited<
      ReturnType<typeof resolveCatalogExecutionDefaults>
    >;
    request: ImportNativeThreadRequest;
    thread: Thread;
  },
): Promise<Thread> {
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      hostId: args.request.hostId,
      projectDefaults: args.executionDefaults,
      threadId: args.thread.id,
    },
  );

  const rows = buildNativeImportHistoryRows({
    cwd: args.cwd,
    execution,
    sourceProviderThreadId: args.request.sourceProviderThreadId,
    threadId: args.thread.id,
    turns: args.request.turns,
  });

  const started = deps.db.transaction(
    (tx) => {
      insertConstructedThreadEventsInTransaction(tx, {
        rows,
        targetEnvironmentId: args.thread.environmentId,
        targetThreadId: args.thread.id,
      });

      const prepared = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, hub: deps.hub, logger: deps.logger },
        { event: { type: "run.preparing" }, threadId: args.thread.id },
      );

      if (!prepared.applied) {
        throw new Error(
          `Imported thread could not start provisioning: ${prepared.detail}`,
        );
      }

      saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context: createThreadStartup({
          clientRequestId: createClientTurnRequestId(),
          environmentIntent: args.environmentIntent,
          execution: null,
          fork: null,
          input: [],
          initiator: "user",
          seedWithoutRun: true,
          titleProvided: true,
        }),
      });

      return prepared.thread;
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(
    args.thread.id,
    ["status-changed"],
    buildThreadStatusChangeMetadata(deps, started),
  );

  if (rows.length > 0) {
    deps.hub.notifyThread(args.thread.id, ["events-appended"], {
      timelineSequence: getLatestThreadSequence(deps.db, {
        threadId: args.thread.id,
      }),
      eventTypes: [...new Set(rows.map((row) => row.type))],
    });
  }

  return started;
}

export async function importNativeThread(
  deps: AppDeps,
  request: ImportNativeThreadRequest,
): Promise<ImportNativeThreadResponse> {
  const existing = findNativeSessionClaim(deps.db, sourceKey(request));

  if (existing !== null) {
    return alreadyClaimed(existing);
  }

  const project = requirePublicProjectForThreadCreate(deps, request.projectId);

  if (project.kind === "personal") {
    throw new ApiError(
      409,
      "invalid_request",
      "Imported chats need a project with a folder on this machine",
    );
  }

  await deps.providerRegistry.whenRegistrationsSettled();

  const { executionDefaults, providerId } =
    resolveProjectExecutionDefaultsForCreate(deps, {
      executionInputSources: undefined,
      model: undefined,
      projectId: request.projectId,
      providerId: request.providerId,
    });

  if (providerId !== request.providerId) {
    throw new ApiError(
      409,
      "provider_unavailable",
      `The ${request.providerId} agent is not available, so this chat cannot be imported yet`,
    );
  }

  requireEnvironmentPlacementHost(deps, request.hostId);
  await ensureHostSessionReadyForWork(deps, { hostId: request.hostId });

  const cwd = canonicalizeHostPath(request.cwd);

  try {
    assertNativeImportTurnsValid({
      cwd,
      sourceProviderThreadId: request.sourceProviderThreadId,
      turns: request.turns,
    });
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_request",
      error instanceof Error ? error.message : "Imported history is invalid",
    );
  }

  const { environmentId, environmentIntent } =
    await resolveThreadEnvironmentPlacement(deps, {
      projectId: request.projectId,
      requestedEnvironment: {
        type: "host",
        hostId: request.hostId,
        workspace: { type: "unmanaged", path: cwd },
      },
    });

  const environment =
    environmentId === null ? null : getEnvironment(deps.db, environmentId);

  if (environment !== null) {
    assertEnvironmentPathAvailable(deps, { ...environment, threadId: null });
  }

  const resolvedExecutionDefaults = await resolveCatalogExecutionDefaults(
    deps,
    {
      cwd,
      executionDefaults,
      hostId: request.hostId,
      providerId: request.providerId,
      providerFallbackCandidates: [],
      requestedModel: null,
    },
  );

  const serviceRequest: ThreadCreateServiceRequest = {
    environment: {
      type: "host",
      hostId: request.hostId,
      workspace: { type: "unmanaged", path: cwd },
    },
    input: [],
    machinePinned: true,
    origin: request.origin,
    ...(request.originPluginId !== undefined
      ? { originPluginId: request.originPluginId }
      : {}),
    originKind: null,
    pluginMetadata: null,
    projectId: request.projectId,
    providerId: request.providerId,
    startedOnBehalfOf: null,
    title: request.title,
    titleFallback: null,
    visibility: "visible",
  };

  let thread: Thread;

  try {
    thread = createThreadRecord(deps, {
      environmentId,
      request: serviceRequest,
      initialTimestamps: {
        createdAt: request.createdAt,
        attentionAt: request.lastMessageAt,
      },
      nativeImport: {
        hostId: request.hostId,
        providerId: request.providerId,
        sourceProviderThreadId: request.sourceProviderThreadId,
        sourcePath: request.sourcePath,
        importedAt: Date.now(),
      },
    });
  } catch (error) {
    if (error instanceof NativeThreadImportConflictError) {
      const claim = findNativeSessionClaim(deps.db, sourceKey(request));

      if (claim !== null) {
        return alreadyClaimed(claim);
      }
    }

    throw error;
  }

  try {
    await seedImportedThread(deps, {
      cwd,
      environmentIntent,
      executionDefaults: resolvedExecutionDefaults,
      request,
      thread,
    });
  } catch (error) {
    discardFailedImport(deps, getThread(deps.db, thread.id) ?? thread);
    throw error;
  }

  scheduleThreadProvisioningAdvance(deps, thread.id);

  return { kind: "imported", threadId: thread.id };
}
