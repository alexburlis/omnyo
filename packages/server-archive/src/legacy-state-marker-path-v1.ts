import { z } from "zod";
import { isServerOwnedPath } from "./server-owned-paths.js";

export const legacyStateMarkerPathV1Schema = z
  .string()
  .refine((path) => path === "bb.db" || isServerOwnedPath(path), {
    message: "Expected an exact version1 server-owned path",
  });

export function assertLegacyStateMarkerDatabaseV1(
  paths: readonly string[],
  context: z.RefinementCtx,
): void {
  if (legacyStateMarkerHasDatabaseCollisionV1(paths))
    context.addIssue({
      code: "custom",
      message:
        "Version1 marker contains conflicting legacy and current core database paths",
    });
}

export function legacyStateMarkerHasDatabaseCollisionV1(
  paths: readonly string[],
): boolean {
  return paths.includes("bb.db") && paths.includes("app.db");
}
