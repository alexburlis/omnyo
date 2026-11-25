import {
  getNativeClaudeProfileDefault,
  getNativeClaudeProfilesOwnerPilot,
  getProject,
  getSessionById,
  setNativeClaudeProfileDefault,
  setNativeClaudeProfilesOwnerPilot,
} from "@omnyo/db";
import type {
  ClaudeProfileBinding,
  ClaudeProfileSelection,
} from "@omnyo/domain";
import {
  CLAUDE_PROFILE_USAGE_PROTOCOL_VERSION,
  type ClaudeProfileManagementRequest,
  type ClaudeProfileManagementResult,
} from "@omnyo/host-daemon-contract";
import type {
  SystemClaudeProfilesRequest,
  SystemClaudeProfilesResult,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { resolveBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";

export const NATIVE_CLAUDE_PROFILE_PROTOCOL = 264;

function unavailable(): never {
  throw new ApiError(
    409,
    "claude_profiles_unavailable",
    "Native Claude profiles are unavailable on this machine.",
  );
}

function supportedHost(deps: WorkSessionDeps, hostId: string): boolean {
  if (
    !deps.config.nativeClaudeProfilesOwnerPilotAvailable ||
    hostId !== resolvePrimaryHostId(deps)
  )
    return false;
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

  const session =
    sessionId === null ? null : getSessionById(deps.db, { sessionId });

  return (
    session !== null &&
    session.status === "active" &&
    deps.hub.getDaemonPlatformForHost(hostId) === "darwin" &&
    session.protocolVersion >= NATIVE_CLAUDE_PROFILE_PROTOCOL
  );
}

function requireProfileHost(deps: WorkSessionDeps, hostId: string): void {
  if (
    !getNativeClaudeProfilesOwnerPilot(deps.db) ||
    !supportedHost(deps, hostId)
  )
    unavailable();
}

function requireProject(
  deps: WorkSessionDeps,
  projectId: string | undefined,
): void {
  if (projectId === undefined) return;
  const project = getProject(deps.db, projectId);

  if (project === null || project.deletedAt !== null)
    throw new ApiError(404, "project_not_found", "Project not found");
}

function defaultSelection(
  deps: WorkSessionDeps,
  hostId: string,
  projectId: string | undefined,
): ClaudeProfileSelection {
  return (
    (projectId === undefined
      ? null
      : getNativeClaudeProfileDefault(deps.db, { hostId, projectId })) ??
    getNativeClaudeProfileDefault(deps.db, { hostId, projectId: null }) ?? {
      kind: "unprofiled",
    }
  );
}

async function manageHost(
  deps: WorkSessionDeps,
  hostId: string,
  request: ClaudeProfileManagementRequest,
): Promise<ClaudeProfileManagementResult> {
  return callHostOnlineRpc(deps, {
    hostId,
    timeoutMs: 10_000,
    command: { type: "claude-profile/manage", request },
  });
}

async function requireReadyProfile(
  deps: WorkSessionDeps,
  hostId: string,
  profileId: string,
): Promise<void> {
  const result = await manageHost(deps, hostId, {
    action: "status",
    profileId,
  });

  if (result.action !== "status")
    throw new ApiError(
      502,
      "invalid_host_response",
      "The machine returned an unexpected profile response.",
    );

  if (result.profile.status !== "ready")
    throw new ApiError(
      409,
      "claude_profile_sign_in_required",
      result.profile.status === "wrong-account"
        ? "Sign in to the account assigned to this Claude profile."
        : "Sign in to this Claude profile before starting the chat.",
    );
}

export async function manageClaudeProfiles(
  deps: WorkSessionDeps,
  request: SystemClaudeProfilesRequest,
): Promise<SystemClaudeProfilesResult> {
  if (request.action === "pilotSet") {
    if (!deps.config.nativeClaudeProfilesOwnerPilotAvailable) unavailable();
    const hostId = resolvePrimaryHostId(deps);

    if (request.enabled && (hostId === null || !supportedHost(deps, hostId)))
      unavailable();
    setNativeClaudeProfilesOwnerPilot(deps.db, request.enabled);
    deps.hub.notifySystem(["config-changed"]);

    return { action: "pilotSet", enabled: request.enabled };
  }

  if (request.action === "list") {
    requireProject(deps, request.projectId);

    if (
      !getNativeClaudeProfilesOwnerPilot(deps.db) ||
      !supportedHost(deps, request.hostId)
    )
      return {
        action: "list",
        supported: false,
        profiles: [],
        defaultSelection: { kind: "unprofiled" },
      };
    const result = await manageHost(deps, request.hostId, { action: "list" });

    if (result.action !== "list")
      throw new ApiError(
        502,
        "invalid_host_response",
        "The machine returned an unexpected profile response.",
      );

    return {
      ...result,
      defaultSelection: result.supported
        ? defaultSelection(deps, request.hostId, request.projectId)
        : { kind: "unprofiled" },
    };
  }

  requireProfileHost(deps, request.hostId);

  if (request.action === "usage") {
    const { hostId, profileId } = request;

    const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

    const session =
      sessionId === null ? null : getSessionById(deps.db, { sessionId });

    const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, "claude-code");

    if (
      session === null ||
      session.protocolVersion < CLAUDE_PROFILE_USAGE_PROTOCOL_VERSION ||
      bridgeLaunch === null
    )
      unavailable();

    const result = await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: 30_000,
      command: {
        type: "provider.usage",
        providerId: "claude-code",
        bridgeLaunch,
        claudeProfileBinding: { profileId },
      },
    });

    if (!result.supported || result.profileScoped !== true) unavailable();

    return { action: "usage", usage: result.usage };
  }

  if (request.action === "defaultsSet") {
    requireProject(deps, request.projectId);

    if (request.selection.kind === "profile")
      await requireReadyProfile(
        deps,
        request.hostId,
        request.selection.profileId,
      );
    setNativeClaudeProfileDefault(deps.db, {
      hostId: request.hostId,
      projectId: request.projectId ?? null,
      selection: request.selection,
    });

    return { action: "defaultsSet", defaultSelection: request.selection };
  }

  const { hostId, ...hostRequest } = request;
  const result = await manageHost(deps, hostId, hostRequest);

  if (result.action === "list" || result.action !== hostRequest.action)
    throw new ApiError(
      502,
      "invalid_host_response",
      "The machine returned an unexpected profile response.",
    );

  if (
    hostRequest.action === "add" &&
    hostRequest.adoptExisting === true &&
    result.action === "add" &&
    result.profile.status === "ready" &&
    getNativeClaudeProfileDefault(deps.db, { hostId, projectId: null }) === null
  )
    setNativeClaudeProfileDefault(deps.db, {
      hostId,
      projectId: null,
      selection: { kind: "profile", profileId: result.profile.id },
    });

  return result;
}

export async function resolveNewThreadClaudeProfile(
  deps: WorkSessionDeps,
  args: {
    providerId: string;
    hostId: string | null;
    projectId: string;
    selection: ClaudeProfileSelection | undefined;
  },
): Promise<ClaudeProfileBinding | null> {
  if (args.providerId !== "claude-code") {
    if (args.selection?.kind === "profile")
      throw new ApiError(
        400,
        "invalid_request",
        "A native Claude profile requires the Claude Code provider.",
      );

    return null;
  }

  if (
    args.selection === undefined &&
    (!deps.config.nativeClaudeProfilesOwnerPilotAvailable ||
      !getNativeClaudeProfilesOwnerPilot(deps.db))
  )
    return null;

  const selection =
    args.selection ??
    (args.hostId === null
      ? { kind: "unprofiled" }
      : defaultSelection(deps, args.hostId, args.projectId));

  if (selection.kind === "unprofiled") return null;

  if (args.hostId === null) unavailable();
  requireProfileHost(deps, args.hostId);
  await requireReadyProfile(deps, args.hostId, selection.profileId);

  return { profileId: selection.profileId, hostId: args.hostId };
}

export function requireThreadClaudeProfile(
  deps: WorkSessionDeps,
  args: {
    binding: ClaudeProfileBinding | null;
    hostId: string;
    providerId: string;
  },
): void {
  if (args.binding === null) return;

  if (args.providerId !== "claude-code" || args.binding.hostId !== args.hostId)
    throw new ApiError(
      409,
      "claude_profile_host_changed",
      "This chat must run on the machine assigned to its Claude profile.",
    );
  requireProfileHost(deps, args.hostId);
}
