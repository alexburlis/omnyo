import { lstatSync } from "node:fs";
import { join } from "node:path";

export function pathExistsRefusingLinks(path: string): boolean {
  try {
    const info = lstatSync(path);

    if (info.isSymbolicLink())
      throw new Error(
        "State migration refuses a symbolic-link profile or database",
      );

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export function assertNoOrphanedDatabaseSidecars(dataDir: string): void {
  if (
    !pathExistsRefusingLinks(join(dataDir, "app.db")) &&
    ["app.db-wal", "app.db-shm"].some((path) =>
      pathExistsRefusingLinks(join(dataDir, path)),
    )
  )
    throw new Error(
      "Database migration refuses orphaned canonical SQLite sidecars",
    );
}
