import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  PRIVATE_SERVER_UPDATE_DIR_NAME,
  type NpmAppRevision,
} from "@omnyo/config/app-update";
import {
  formatNpmRevisionPackageRoot,
  isUsableNpmRevision,
  readPackageVersion,
} from "./npm-revision.js";

const runtimeIdentitySchema = z.object({ runtimeSha256: z.string() });

export function isPrivateServerUpdateEnabled(args: {
  dataDir: string;
}): boolean {
  return existsSync(join(args.dataDir, PRIVATE_SERVER_UPDATE_DIR_NAME));
}

function readStagedRuntimeSha256(packageRoot: string): string | null {
  try {
    const parsed = runtimeIdentitySchema.safeParse(
      JSON.parse(
        readFileSync(
          join(packageRoot, "dist", "runtime-identity.json"),
          "utf8",
        ),
      ),
    );

    return parsed.success ? parsed.data.runtimeSha256 : null;
  } catch {
    return null;
  }
}

export function adoptPrivateRevision(args: {
  dataDir: string;
  runtimeSha256: string;
  version: string;
}): NpmAppRevision {
  const revision: NpmAppRevision = {
    kind: "npm",
    packageRoot: formatNpmRevisionPackageRoot(args.dataDir, args.version),
    version: args.version,
  };

  if (!isUsableNpmRevision(revision)) {
    const stagedVersion = readPackageVersion(revision.packageRoot);
    throw new Error(
      stagedVersion === null || stagedVersion === args.version
        ? `The staged omnyo-app ${args.version} runtime is missing or incomplete.`
        : `The staged runtime reports omnyo-app ${stagedVersion}, not ${args.version}.`,
    );
  }

  const stagedSha256 = readStagedRuntimeSha256(revision.packageRoot);

  if (stagedSha256 === null) {
    throw new Error(
      `The staged omnyo-app ${args.version} runtime has no readable runtime identity.`,
    );
  }

  if (stagedSha256 !== args.runtimeSha256) {
    throw new Error(
      `The staged omnyo-app ${args.version} runtime does not match the approved digest.`,
    );
  }

  return revision;
}
