import { formatBytes, formatProcessCount } from "./format";

type HostInspection = { status: string; failures: readonly string[] };

export function inspectionStatus(
  hosts: readonly HostInspection[],
): "complete" | "partial" | "failed" {
  const observed = hosts.filter((host) => host.status === "ok");

  if (hosts.length > 0 && observed.length === 0) return "failed";

  return observed.length < hosts.length || observed.some((host) => host.failures.length > 0)
    ? "partial"
    : "complete";
}

export function inspectionSummary(list: {
  hosts: readonly HostInspection[];
  processCount: number;
  memoryBytes: number;
  cuaResources?: readonly { transition: { kind: string } }[];
}): string {
  const resources =
    list.cuaResources?.filter((resource) => resource.transition.kind !== "stopped").length ?? 0;

  const tracked =
    resources > 0 ? `${resources} Cua ${resources === 1 ? "runtime" : "runtimes"} tracked.` : "";

  const status = inspectionStatus(list.hosts);

  if (status === "failed")
    return `Inspection failed. Resource usage is unknown.${tracked ? ` ${tracked}` : ""}`;
  const observed = `${formatBytes(list.memoryBytes)} in ${formatProcessCount(list.processCount)}`;

  if (status === "partial") return `Inspection incomplete. Observed ${observed}.`;

  if (resources > 0) return list.processCount === 0 ? tracked : `${observed}. ${tracked}`;

  return list.processCount === 0 ? "Nothing left running." : observed;
}
