import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import {
  deleteManagedPreview,
  findManagedPreview,
  getManagedPreview,
  getHost,
  insertManagedPreview,
  listManagedPreviews,
  type ManagedPreviewRow,
} from "@omnyo/db";
import {
  managedPreviewLaunchSchema,
  type ManagedPreviewLaunch,
} from "@omnyo/host-daemon-contract";
import type {
  PreviewBinding,
  PreviewRegisterRequest,
  PreviewStatus,
  PreviewListResponse,
} from "@omnyo/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  requirePublicThread,
  requireReadyEnvironment,
  requireConnectedHostSession,
} from "../lib/entity-lookup.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import { resolveHostEnvironment } from "../hosts/host-environment.js";
import { recordPreviewStartedActivity } from "./preview-activity.js";

function parseEndpoint(href: string): { url: URL; endpoint: string } {
  const url = new URL(href);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new ApiError(
      400,
      "invalid_preview_url",
      "A preview must use an HTTP loopback URL without credentials",
    );
  }

  const hostname = url.hostname === "[::1]" ? "::1" : "127.0.0.1";

  return {
    url,
    endpoint: `${url.protocol}//${hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`,
  };
}

export function publicPreview(
  deps: Pick<AppDeps, "db">,
  row: ManagedPreviewRow,
): PreviewBinding {
  const url = new URL(row.url);
  const host = getHost(deps.db, row.hostId);

  if (!host)
    throw new ApiError(
      409,
      "preview_host_missing",
      "The preview computer is unavailable",
    );

  return {
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    environmentId: row.environmentId,
    hostId: row.hostId,
    hostName: host.name,
    url: row.url,
    remoteUrl: `/preview/${encodeURIComponent(row.id)}${url.pathname}${url.search}${url.hash}`,
    createdAt: row.createdAt,
  };
}

export function requirePreview(deps: AppDeps, id: string): ManagedPreviewRow {
  const row = getManagedPreview(deps.db, id);

  if (!row) throw new ApiError(404, "preview_not_found", "Preview not found");
  const thread = requirePublicThread(deps.db, row.threadId);
  const environment = requireReadyEnvironment(deps.db, row.environmentId);

  if (
    thread.projectId !== row.projectId ||
    environment.projectId !== row.projectId ||
    environment.hostId !== row.hostId
  )
    throw new ApiError(
      409,
      "preview_scope_changed",
      "The preview's workspace has changed",
    );

  return row;
}

export function previewLaunch(row: ManagedPreviewRow): ManagedPreviewLaunch {
  const { url } = parseEndpoint(row.url);

  return managedPreviewLaunchSchema.parse({
    id: row.id,
    projectId: row.projectId,
    environmentId: row.environmentId,
    cwd: row.cwd,
    argv: row.argv,
    protocol: url.protocol,
    hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    readinessPath: row.readinessPath,
  });
}

export function registerPreview(
  deps: AppDeps,
  payload: PreviewRegisterRequest,
): PreviewBinding {
  const thread = requirePublicThread(deps.db, payload.threadId);

  if (thread.environmentId === null)
    throw new ApiError(
      409,
      "preview_environment_missing",
      "The source chat needs a workspace",
    );
  const environment = requireReadyEnvironment(deps.db, thread.environmentId);
  const target = requireWorkspaceCommandTarget(environment);
  const { url, endpoint } = parseEndpoint(payload.url);

  const paths = /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(environment.path)
    ? win32
    : posix;

  const cwd = paths.resolve(environment.path, payload.cwd ?? ".");
  const relative = paths.relative(environment.path, cwd);

  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    throw new ApiError(
      400,
      "preview_cwd_outside_workspace",
      "The preview directory must be inside its workspace",
    );
  const readinessPath = payload.readinessPath ?? `${url.pathname}${url.search}`;
  const existing = findManagedPreview(deps.db, environment.id, endpoint);

  if (existing) {
    if (
      existing.cwd !== cwd ||
      JSON.stringify(existing.argv) !== JSON.stringify(payload.argv) ||
      existing.readinessPath !== readinessPath
    )
      throw new ApiError(
        409,
        "preview_already_registered",
        "This endpoint already has a different saved launch recipe",
      );

    return publicPreview(deps, existing);
  }

  const row: ManagedPreviewRow = {
    id: `prv_${randomUUID().replaceAll("-", "")}`,
    projectId: thread.projectId,
    threadId: thread.id,
    environmentId: environment.id,
    hostId: target.hostId,
    url: payload.url,
    endpoint,
    cwd,
    argv: payload.argv,
    readinessPath,
    createdAt: Date.now(),
  };

  previewLaunch(row);

  return publicPreview(deps, insertManagedPreview(deps.db, row));
}

export function listPreviews(
  deps: AppDeps,
  threadId: string,
): PreviewListResponse {
  const thread = requirePublicThread(deps.db, threadId);

  if (thread.environmentId === null) return { previews: [], sourceHost: null };
  const environment = requireReadyEnvironment(deps.db, thread.environmentId);
  const host = getHost(deps.db, environment.hostId);

  return {
    previews: listManagedPreviews(deps.db, thread.environmentId).map((row) =>
      publicPreview(deps, row),
    ),
    sourceHost: host ? { id: host.id, name: host.name } : null,
  };
}

const pendingStatus = new Map<string, Promise<PreviewStatus>>();

export async function previewStatus(
  deps: AppDeps,
  id: string,
): Promise<PreviewStatus> {
  const row = requirePreview(deps, id);

  try {
    requireConnectedHostSession(deps, row.hostId);
  } catch {
    return {
      state: "host-offline",
      checkedAt: Date.now(),
      detail: "The preview's computer is offline",
      runId: null,
    };
  }

  const key = `${deps.config.dataDir}:${id}`;
  const pending = pendingStatus.get(key);

  if (pending) return pending;

  const probe = callHostOnlineRpc(deps, {
    hostId: row.hostId,
    command: { type: "host.preview.status", preview: previewLaunch(row) },
    timeoutMs: 5000,
  })
    .catch((): PreviewStatus => ({
      state: "unknown",
      checkedAt: Date.now(),
      detail: "Could not check the preview on its computer",
      runId: null,
    }))
    .finally(() => pendingStatus.delete(key));

  pendingStatus.set(key, probe);

  return probe;
}

export async function restartPreview(
  deps: AppDeps,
  id: string,
  requestId: string,
  actingThreadId: string | null,
): Promise<PreviewStatus> {
  const key = `${deps.config.dataDir}:${id}:${requestId}`;
  const now = Date.now();

  for (const [existingKey, request] of restartRequests)
    if (request.expiresAt < now) restartRequests.delete(existingKey);
  const existing = restartRequests.get(key);

  if (existing) return existing.promise;

  if (restartRequests.size >= 256)
    throw new ApiError(
      429,
      "preview_restart_busy",
      "Too many preview requests are still pending",
    );
  const promise = restartPreviewOnce(deps, id, actingThreadId);
  restartRequests.set(key, { promise, expiresAt: now + 60000 });

  return promise;
}

const restartRequests = new Map<
  string,
  { promise: Promise<PreviewStatus>; expiresAt: number }
>();

const restartingPreviews = new Map<string, number>();

async function restartPreviewOnce(
  deps: AppDeps,
  id: string,
  actingThreadId: string | null,
): Promise<PreviewStatus> {
  const row = requirePreview(deps, id);

  const target = requireWorkspaceCommandTarget(
    requireReadyEnvironment(deps.db, row.environmentId),
  );

  requireConnectedHostSession(deps, row.hostId);
  const key = `${deps.config.dataDir}:${row.id}`;
  restartingPreviews.set(key, (restartingPreviews.get(key) ?? 0) + 1);

  try {
    const status = await callHostOnlineRpc(deps, {
      hostId: row.hostId,
      command: {
        type: "host.preview.ensure",
        preview: previewLaunch(row),
        workspaceContext: target.workspaceContext,
        contributedEnv: await resolveHostEnvironment(deps, {
          hostId: row.hostId,
          projectId: row.projectId,
        }),
      },
      timeoutMs: 25000,
    });

    if (status.state === "online")
      recordPreviewStartedActivity(deps, {
        previewId: row.id,
        actingThreadId,
      });

    return status;
  } finally {
    const remaining = (restartingPreviews.get(key) ?? 1) - 1;

    if (remaining === 0) restartingPreviews.delete(key);
    else restartingPreviews.set(key, remaining);
  }
}

function requireNoPreviewRestart(deps: AppDeps, id: string): void {
  if (restartingPreviews.has(`${deps.config.dataDir}:${id}`))
    throw new ApiError(
      409,
      "preview_restarting",
      "The preview server is starting; remove it after the restart finishes",
    );
}

export async function removePreview(
  deps: AppDeps,
  id: string,
): Promise<{ ok: true }> {
  const row = requirePreview(deps, id);

  requireNoPreviewRestart(deps, row.id);
  requireConnectedHostSession(deps, row.hostId);

  const observed = await callHostOnlineRpc(deps, {
    hostId: row.hostId,
    command: { type: "host.preview.status", preview: previewLaunch(row) },
    timeoutMs: 5000,
  });

  if (observed.runId !== null && observed.state !== "stopped")
    throw new ApiError(
      409,
      "preview_running",
      `The preview server is ${observed.state}; stop it before removing the preview`,
    );
  requireNoPreviewRestart(deps, row.id);
  deleteManagedPreview(deps.db, row.id);

  return { ok: true };
}
