import type { PluginApi } from "@omnyo/plugin-sdk";
import type { WorkflowPlacement } from "./cache.js";

export async function resolveWorkflowPlacement(
  sdk: PluginApi["sdk"],
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<WorkflowPlacement> {
  const environment = await sdk.environments.get({ environmentId, signal });

  if (environment.id !== environmentId || environment.projectId !== projectId) {
    throw new Error(
      "Workflow target environment belongs to a different project",
    );
  }

  if (
    environment.status !== "ready" ||
    environment.lifecycle.phase !== "active" ||
    environment.hostLifecycle !== "active"
  ) {
    throw new Error(
      `Workflow target environment ${environmentId} is not ready`,
    );
  }

  if (environment.path === null || environment.path.trim() === "") {
    throw new Error(
      `Workflow target environment ${environmentId} has no workspace`,
    );
  }

  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    workspacePath: environment.path,
  };
}
