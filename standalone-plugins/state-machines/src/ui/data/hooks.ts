import { useSmClient } from "./client.js";
import type {
  AttentionItem,
  DraftView,
  EnvironmentOption,
  EventCatalogEntry,
  InstanceSummary,
  InstanceView,
  MachineSummary,
  VersionSummary,
  VersionView,
} from "./contract.js";
import { useSmQuery } from "./query.js";

export function useMachines(projectId: string | null) {
  const client = useSmClient();

  return useSmQuery<MachineSummary[]>(`machines:${projectId ?? "*"}`, () =>
    client.call("sm_machine_list", { projectId }),
  );
}

export function useDraft(machineId: string) {
  const client = useSmClient();

  return useSmQuery<DraftView>(`draft:${machineId}`, () =>
    client.call("sm_machine_draft_get", { machineId }),
  );
}

export function useInstance(instanceId: string | null) {
  const client = useSmClient();

  return useSmQuery<InstanceView>(instanceId === null ? null : `instance:${instanceId}`, () =>
    client.call("sm_instance_inspect", { instanceId: instanceId ?? "" }),
  );
}

export function useInstances(machineId: string) {
  const client = useSmClient();

  return useSmQuery<InstanceSummary[]>(`instances:${machineId}`, () =>
    client.call("sm_instance_list", { machineId }),
  );
}

export function useAttention(machineId: string | null, instanceId: string | null) {
  const client = useSmClient();

  return useSmQuery<AttentionItem[]>(`attention:${machineId ?? "*"}:${instanceId ?? "*"}`, () =>
    client.call("sm_attention_list", { machineId, instanceId }),
  );
}

export function useVersions(machineId: string) {
  const client = useSmClient();

  return useSmQuery<VersionSummary[]>(`versions:${machineId}`, () =>
    client.call("sm_machine_versions", { machineId }),
  );
}

export function useVersion(machineId: string, versionId: string | null) {
  const client = useSmClient();

  return useSmQuery<VersionView>(
    versionId === null ? null : `version:${machineId}:${versionId}`,
    () => client.call("sm_machine_version_get", { machineId, versionId: versionId ?? "" }),
  );
}

export function useEnvironments(projectId: string | null) {
  const client = useSmClient();

  return useSmQuery<EnvironmentOption[]>(
    projectId === null ? null : `environments:${projectId}`,
    () => client.call("sm_environment_list", { projectId: projectId ?? "" }),
  );
}

export function useEventCatalog(instanceId: string | null) {
  const client = useSmClient();

  return useSmQuery<EventCatalogEntry[]>(instanceId === null ? null : `catalog:${instanceId}`, () =>
    client.call("sm_events_catalog", { instanceId: instanceId ?? "" }),
  );
}
