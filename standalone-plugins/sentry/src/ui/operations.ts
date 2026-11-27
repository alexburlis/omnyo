import type { ModelRole } from "../../contract";

export const operationKey = {
  sync: "sync",
  route: (id: string) => "route:" + id,
  issue: (url: string) => "issue:" + url,
  policy: (projectId: string) => "policy:" + projectId,
  model: (role: ModelRole) => "model:" + role,
  batch: (projectId: string) => "batch:" + projectId,
  batchRun: (id: string) => "batch-run:" + id,
  run: (id: string) => "run:" + id,
};
