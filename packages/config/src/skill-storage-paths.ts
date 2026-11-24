import { join } from "node:path";

export function resolveDataDirSkillsRootPath(dataDir: string): string {
  return join(dataDir, "skills");
}

export {
  assertCanonicalWorkspaceStateV1,
  legacyOwnedSkillIdentitySeedV1,
  workspaceStatePathsV1,
} from "./legacy-workspace-state-v1.js";
