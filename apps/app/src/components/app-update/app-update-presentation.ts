import { z } from "zod";
import type {
  SystemAppUpdateAvailable,
  SystemAppUpdateResult,
  SystemAppUpdateRevision,
  SystemAppUpdateStatus,
} from "@omnyo/server-contract";
import { asHttpError } from "@/lib/http-error";
import { formatScheduledTime } from "@/lib/relative-time";

export function formatStopsRunningChatsAt(
  activity: Extract<SystemAppUpdateStatus["activity"], { phase: "draining" }>,
): string {
  return formatScheduledTime({
    timestamp: Date.parse(activity.stopsRunningChatsAt),
    now: Date.now(),
  });
}

export interface AppUpdateResultPresentation {
  description: string | null;
  title: string;
  tone: "error" | "success" | "message";
}

export function formatAppUpdateRevision(
  revision: SystemAppUpdateRevision,
): string {
  return revision.commit === null
    ? revision.version
    : revision.commit.slice(0, 7);
}

export function formatAppUpdateTarget(
  available: SystemAppUpdateAvailable,
): string {
  if (available.commit === null || available.channel === "private") {
    return available.version;
  }

  const count = available.commitCount ?? 0;

  return `${available.commit.slice(0, 7)} (+${String(count)} commit${count === 1 ? "" : "s"})`;
}

export function describeAppUpdateResult(
  result: SystemAppUpdateResult,
): AppUpdateResultPresentation {
  const target = formatAppUpdateRevision(result.to);

  switch (result.outcome) {
    case "cancelled":
      return {
        description: result.message,
        title: "Update cancelled",
        tone: "message",
      };
    case "updated":
      return {
        description: null,
        title: `Updated Omnyo to ${target}`,
        tone: "success",
      };
    case "failed":
      return {
        description: result.message,
        title: `Update to ${target} failed`,
        tone: "error",
      };
  }
}

export function pendingAppUpdateResult(
  status: SystemAppUpdateStatus | undefined,
): SystemAppUpdateResult | null {
  const result = status?.lastResult ?? null;

  return result === null || result.acknowledged ? null : result;
}

export function isDesktopOwnedServer(status: SystemAppUpdateStatus): boolean {
  return (
    status.support.kind === "unsupported" && status.support.reason === "desktop"
  );
}

export function hasActionableAppUpdate(
  status: SystemAppUpdateStatus | undefined,
): boolean {
  return (
    status !== undefined &&
    status.support.kind === "supported" &&
    status.support.mode !== "source" &&
    status.available !== null &&
    status.blocked === null
  );
}

export type OmnyoUpdateNowState = "offer" | "updating" | "none";

export function appUpdateProgressLabel(status: SystemAppUpdateStatus): string {
  if (status.available?.activation === "idle-only" && status.installsWhenIdle)
    return "Waiting for idle";

  if (
    status.activity.phase !== "restarting" &&
    status.blocked?.reason === "update-unreadable"
  )
    return "Update blocked";

  switch (status.activity.phase) {
    case "idle":
      return "Update Omnyo";
    case "draining":
      return "Waiting for chats";
    case "restarting":
      return "Restarting Omnyo";
    case "preparing":
      switch (status.activity.step) {
        case "Restarting Omnyo":
          return "Restarting Omnyo";
        case "Pausing chats":
        case "Stopping running chats":
          return "Pausing chats";
        case "Waiting for worker":
        case "Ready to restart":
        case "Restarting":
          return "Waiting for worker";
        default:
          return "Preparing update";
      }
  }
}

export function currentAppUpdateFailure(
  status: SystemAppUpdateStatus | undefined,
): SystemAppUpdateResult | null {
  const result = status?.lastResult;

  if (
    status === undefined ||
    status.activity.phase !== "idle" ||
    result?.outcome !== "failed" ||
    (result.to.version === status.current.version &&
      result.to.commit === status.current.commit) ||
    (status.available !== null &&
      result.to.version !== status.available.version)
  )
    return null;

  return result;
}

export function omnyoUpdateNowState(
  status: SystemAppUpdateStatus | undefined,
): OmnyoUpdateNowState {
  if (status?.available?.activation === "idle-only")
    return status.activity.phase === "idle" ? "none" : "updating";

  if (status === undefined || status.support.kind !== "supported")
    return "none";

  if (status.activity.phase !== "idle" && !status.installsWhenIdle)
    return "updating";

  return hasActionableAppUpdate(status) ? "offer" : "none";
}

export function updateNowDescription(status: SystemAppUpdateStatus): string {
  if (status.available?.activation === "idle-only")
    return "The update installs after all chats and background work finish.";
  const count = status.runningThreadCount;

  if (status.support.kind === "supported" && status.support.mode === "private")
    return count === 0
      ? "Omnyo pauses any background chat work, updates, then resumes it automatically."
      : `${String(count)} running chat${count === 1 ? " pauses" : "s pause"} now and ${count === 1 ? "resumes" : "resume"} automatically after Omnyo updates.`;

  if (count === 0) return "Omnyo restarts and reconnects on its own.";

  return runningThreadsWarning(count);
}

export function waitsForRunningThreads(
  status: SystemAppUpdateStatus | undefined,
): boolean {
  return (
    status !== undefined &&
    status.support.kind === "supported" &&
    status.support.mode === "private" &&
    status.activity.phase === "idle"
  );
}

export function restartingActivity(
  status: SystemAppUpdateStatus | undefined,
): { startedAt: string; targetRevision: string } | null {
  return status?.activity.phase === "restarting"
    ? {
        startedAt: status.activity.startedAt,
        targetRevision: formatAppUpdateRevision({
          commit: status.activity.targetCommit,
          version: status.activity.targetVersion,
        }),
      }
    : null;
}

export function appUpdateRevisionKey(status: SystemAppUpdateStatus): string {
  return `${status.current.version}:${status.current.commit ?? ""}`;
}

const threadsRunningErrorBodySchema = z.object({
  code: z.literal("threads_running"),
  details: z.object({ runningThreadCount: z.number().int().positive() }),
});

export function runningThreadCountFromError(error: unknown): number | null {
  const httpError = asHttpError(error);

  if (httpError === null) return null;
  const parsed = threadsRunningErrorBodySchema.safeParse(httpError.body);

  return parsed.success ? parsed.data.details.runningThreadCount : null;
}

export function runningThreadsWarning(count: number): string {
  return `${String(count)} thread${count === 1 ? " is" : "s are"} running. Updating restarts Omnyo and interrupts ${
    count === 1 ? "it" : "them"
  }.`;
}
