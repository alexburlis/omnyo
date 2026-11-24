import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

class WorkspaceIdentityPathError extends Error {
  readonly code = "invalid_path";
}

const identitySeeds = {
  "omnyo-project": "bb-project",
  "omnyo-data-dir": "bb-data-dir",
  "omnyo-builtin": "bb-builtin",
} as const;

export function legacyOwnedSkillIdentitySeedV1(
  kind: keyof typeof identitySeeds,
): string {
  return identitySeeds[kind];
}

export function workspaceStatePathsV1(workspacePath: string) {
  if (!isAbsolute(workspacePath) || resolve(workspacePath) !== workspacePath)
    throw new WorkspaceIdentityPathError(
      "Workspace identity requires its exact absolute path",
    );

  return {
    legacyRootPath: join(workspacePath, ".bb"),
    rootPath: join(workspacePath, ".omnyo"),
  };
}

export async function assertCanonicalWorkspaceStateV1(
  workspacePath: string,
): Promise<void> {
  const paths = workspaceStatePathsV1(workspacePath);

  const roots = await Promise.all(
    [paths.legacyRootPath, paths.rootPath].map(async (target) => {
      try {
        return await lstat(target);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    }),
  );

  if (
    roots.some(
      (info) => info !== null && (!info.isDirectory() || info.isSymbolicLink()),
    )
  )
    throw new WorkspaceIdentityPathError(
      "Workspace identity refuses a linked or non-directory state root",
    );

  if (roots[0] !== null && roots[1] !== null)
    throw new Error("Workspace identity collision; preserve both state roots");

  if (roots[0] !== null)
    throw new Error(
      "Workspace identity requires explicit preparation before reading legacy state",
    );
}
