import type { Host, MachineLifecycle } from "@omnyo/domain";
import { formatRelativeTime } from "@/lib/relative-time";
import { hostNeedsUpdate } from "@/lib/host-update-status";

export type MachineStatusTone = "online" | "attention" | "failed" | "offline";

export function machinePhaseLabel(
  lifecycle: MachineLifecycle,
): "Paused" | "Pausing" | "Resuming" | "Removing" | "Cleanup failed" | null {
  if (
    lifecycle.phase === "removing" &&
    lifecycle.teardown?.status === "failed"
  ) {
    return "Cleanup failed";
  }

  if (lifecycle.phase === "suspending") return "Pausing";

  if (lifecycle.phase === "suspended") return "Paused";

  if (lifecycle.phase === "resuming") return "Resuming";

  if (lifecycle.phase === "removing") return "Removing";

  return null;
}

export function machineStatusTone(host: Host): MachineStatusTone {
  if (machinePhaseLabel(host.lifecycle) === "Cleanup failed") return "failed";

  if (
    host.lifecycle.phase === "removing" ||
    host.lifecycle.phase === "suspending" ||
    host.lifecycle.phase === "resuming"
  )
    return "attention";

  if (hostNeedsUpdate(host)) return "attention";

  return host.status === "connected" ? "online" : "offline";
}

export function machineStatusSummary(host: Host): string {
  return (
    machinePhaseLabel(host.lifecycle) ??
    (hostNeedsUpdate(host)
      ? "Needs update"
      : host.status === "connected"
        ? "Online"
        : "Offline")
  );
}

export function machineStatusLabel({
  host,
  now,
}: {
  host: Host;
  now: number;
}): string {
  const parts: string[] = [machineStatusSummary(host)];

  if (host.lifecycle.message !== null) parts.push(host.lifecycle.message);
  else if (host.status !== "connected" && host.lastSeenAt !== null) {
    parts.push(
      `last seen ${formatRelativeTime({ timestamp: host.lastSeenAt, now })}`,
    );
  }

  return parts.join(" · ");
}

export function canReconnectMachine(host: Host): boolean {
  return host.status !== "connected" && host.lifecycle.phase === "active";
}
