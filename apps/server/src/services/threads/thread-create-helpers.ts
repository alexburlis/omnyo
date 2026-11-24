import {
  createThread,
  InvalidLifecycleOwnerError,
  getThreadSectionById,
  getProjectSourceByHost,
  getProject,
  getThread,
  isSqliteForeignKeyConstraint,
  listNonDeletedChildThreads,
  updateThread,
} from "@omnyo/db";
import type { CreateThreadInput, DbNotifier } from "@omnyo/db";
import type { HostDaemonCommand } from "@omnyo/host-daemon-contract";
import type { Thread, LocalPathProjectSource } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { afterCommit } from "../lib/after-commit.js";
import {
  emitPluginThreadCreated,
  emitPluginThreadParentChanged,
} from "../plugins/plugin-thread-events.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { appendThreadOwnershipChangeEventInTransaction } from "./thread-events.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import { sanitizeGeneratedBranchSlug } from "./title-generation.js";

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.attach" }
>;

type EnvironmentProvisionCommandInitiator =
  EnvironmentProvisionCommand["initiator"];

interface SuggestedBranchNameArgs {
  branchPrefix: string;
  title: string | null;
  threadId: string;
}

export function buildSuggestedBranchName(
  args: SuggestedBranchNameArgs,
): string {
  const branchSlug =
    args.title === null ? null : sanitizeGeneratedBranchSlug(args.title);

  return branchSlug
    ? `${args.branchPrefix}${branchSlug}-${args.threadId}`
    : `${args.branchPrefix}${args.threadId}`;
}

export function requirePublicProjectForThreadCreate(
  deps: Pick<AppDeps, "db">,
  projectId: string,
) {
  const project = getProject(deps.db, projectId);

  if (!project || project.deletedAt !== null) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }

  return project;
}

export function requireSourceForHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): LocalPathProjectSource {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);

  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }

  return source;
}

interface EnvironmentProvisionCommandArgs {
  environmentId: string;
  hostId: string;
  initiator: EnvironmentProvisionCommandInitiator;
  path: string;
  setupScriptTimeoutMs: number | null;
}

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): EnvironmentProvisionCommand {
  return {
    type: "environment.attach" as const,
    contributedEnv: [],
    environmentId: args.environmentId,
    initiator: args.initiator,
    path: args.path,
    setupScriptTimeoutMs: args.setupScriptTimeoutMs,
  };
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db"> & { hub: DbNotifier },
  args: {
    environmentId: string | null;
    startupContext?: string;
    request: ThreadCreateServiceRequest;
    initialTimestamps?: CreateThreadInput["initialTimestamps"];
    nativeImport?: CreateThreadInput["nativeImport"];
  },
) {
  const sectionId = args.request.sectionId ?? null;

  if (sectionId !== null && !getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }

  const source =
    args.request.originKind === "handoff" && args.request.sourceThreadId
      ? getThread(deps.db, args.request.sourceThreadId)
      : null;

  try {
    const thread = createThread(deps.db, deps.hub, {
      projectId: args.request.projectId,
      environmentId: args.environmentId,
      providerId: args.request.providerId,
      claudeProfileBinding: args.request.claudeProfileBinding ?? null,
      title:
        args.request.title ?? source?.title ?? source?.titleFallback ?? null,
      titleFallback: source?.titleFallback ?? args.request.titleFallback,
      sectionId: sectionId ?? source?.sectionId ?? null,
      pinned: args.request.pinned ?? false,
      parentThreadId: args.request.parentThreadId ?? null,
      sourceThreadId: args.request.sourceThreadId ?? null,
      lifecycleOwnerThreadId: args.request.lifecycleOwnerThreadId,
      launchedByThreadId: args.request.launchedByThreadId ?? null,
      originKind: args.request.originKind,
      originPluginId: args.request.originPluginId ?? null,
      pluginMetadata: args.request.pluginMetadata,
      visibility: args.request.visibility,
      pluginHome: args.request.pluginHome === true,
      quiet: args.request.quiet === true,

      status: "pending",
      startupContext: args.startupContext,
      ...(args.initialTimestamps !== undefined
        ? { initialTimestamps: args.initialTimestamps }
        : {}),
      ...(args.nativeImport !== undefined
        ? { nativeImport: args.nativeImport }
        : {}),
    });

    afterCommit(() => emitPluginThreadCreated(thread));

    return thread;
  } catch (error) {
    if (error instanceof InvalidLifecycleOwnerError) {
      throw new ApiError(400, "invalid_request", error.message);
    }

    if (
      sectionId !== null &&
      error instanceof Error &&
      isSqliteForeignKeyConstraint(error) &&
      !getThreadSectionById(deps.db, sectionId)
    ) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }

    throw error;
  }
}

export function getThreadSafe(deps: Pick<AppDeps, "db">, threadId: string) {
  const thread = getThread(deps.db, threadId);

  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }

  return thread;
}

export function completeThreadHandoff(
  deps: Pick<AppDeps, "db" | "hub">,
  thread: Pick<Thread, "id" | "originKind" | "sourceThreadId">,
): void {
  if (thread.originKind !== "handoff" || thread.sourceThreadId === null) return;

  const sourceThreadId = thread.sourceThreadId;
  const notifications = new NotificationBuffer();

  const changes = deps.db.transaction((tx) => {
    const source = getThread(tx, sourceThreadId);

    if (source === null)
      throw new ApiError(404, "thread_not_found", "Handoff source not found");

    return [
      ...listNonDeletedChildThreads(tx, { parentThreadId: source.id }),
      source,
    ].map((previous) => {
      const updated = updateThread(tx, notifications, previous.id, {
        parentThreadId: thread.id,
      });

      if (updated === null)
        throw new ApiError(404, "thread_not_found", "Handoff child not found");
      appendThreadOwnershipChangeEventInTransaction(
        { db: tx, hub: notifications },
        {
          threadId: updated.id,
          environmentId: updated.environmentId,
          previousParentThreadId: previous.parentThreadId,
          nextParentThreadId: updated.parentThreadId,
        },
      );

      return { previous, updated };
    });
  });

  notifications.flushInto(deps.hub);

  for (const { previous, updated } of changes) {
    emitPluginThreadParentChanged(updated, previous.parentThreadId);
  }
}
