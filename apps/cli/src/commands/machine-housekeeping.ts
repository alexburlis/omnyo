import type { HostHousekeepingResponse } from "@omnyo/server-contract";

export function formatMachineHousekeeping(
  status: HostHousekeepingResponse,
): string {
  if (status.status === "not-run") return "Housekeeping has not run yet.";

  const pressure =
    status.memoryPressure.status === "observed"
      ? status.memoryPressure.level
      : `unavailable (${status.memoryPressure.reason})`;

  const lines = [
    `Last housekeeping check: ${new Date(status.checkedAt).toISOString()}`,
    `Memory pressure: ${pressure}`,
    `Idle session grace: ${status.idleGraceMs / 60_000} minutes`,
  ];

  if (status.status === "failed") {
    return [
      ...lines,
      "Housekeeping failed. Retained sessions are unknown.",
    ].join("\n");
  }

  lines.push(`Released sessions: ${status.reapedSessions.length}`);
  lines.push(`Retained sessions: ${status.retainedSessions.length}`);

  for (const session of status.retainedSessions) {
    const idle =
      session.idleForMs === null
        ? "idle time unknown"
        : `${Math.round(session.idleForMs / 1_000)}s idle`;

    const memory =
      session.memory.status === "observed"
        ? `${Math.round(session.memory.bytes / 1024 / 1024)} MiB RSS`
        : "memory unavailable";

    const process =
      session.processId === null
        ? "bridge PID unknown"
        : `bridge PID ${session.processId}`;

    lines.push(
      `${session.threadId} (${session.providerId ?? "provider unknown"}, ${session.environmentId}): ${session.reason}; ${idle}; ${process}; ${memory}`,
    );
  }

  return lines.join("\n");
}
