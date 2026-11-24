import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { assertNoOrphanedDatabaseSidecars } from "./database-sidecars.js";
import { isLegacyStateRootPopulatedV1 } from "./legacy-state-roots-v1.js";
import {
  formatAppConfigPath,
  parseAppManagedConfig,
} from "./managed-app-config.js";
import { mutateManagedJsonFile } from "./managed-json-file.js";
import {
  admitOmnyoStateWrites,
  assertOmnyoStateWriteAdmission,
  omnyoStateAdmissionSchema,
  readOmnyoStateAdmission,
} from "./omnyo-state-admission.js";

export function readConfiguredOmnyoStateAdmission(dataDir: string) {
  let raw: string;

  try {
    raw = readFileSync(formatAppConfigPath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid runtime configuration; state write admission refused",
    );
  }

  const admission = parseAppManagedConfig(value).stateMigration;

  if (admission && admission.binding.destinationDataDir !== resolve(dataDir)) {
    throw new Error("State migration destination does not match this profile");
  }

  return admission;
}

export async function admitConfiguredOmnyoStateWrites(
  dataDir: string,
): Promise<void> {
  assertNoOrphanedDatabaseSidecars(dataDir);
  const admission = readConfiguredOmnyoStateAdmission(dataDir);

  if (admission) await admitOmnyoStateWrites(admission);
}

export function assertConfiguredOmnyoStateWriteAdmission(
  dataDir: string,
): void {
  assertNoOrphanedDatabaseSidecars(dataDir);
  const admission = readConfiguredOmnyoStateAdmission(dataDir);

  if (admission) assertOmnyoStateWriteAdmission(admission);
}

export async function retireCompletedOmnyoStateAdmissionV1(
  dataDir: string,
): Promise<boolean> {
  const admission = readConfiguredOmnyoStateAdmission(dataDir);

  if (
    admission === undefined ||
    readOmnyoStateAdmission(admission).admission !== 1 ||
    isLegacyStateRootPopulatedV1(admission.binding.sourceDataDir)
  )
    return false;

  const path = formatAppConfigPath(dataDir);
  const expected = JSON.stringify(admission);
  let retired = false;

  await mutateManagedJsonFile<Record<string, unknown>>({
    path,
    read: async () =>
      z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile(path, "utf8"))),
    mutate: (current) => {
      const stored = omnyoStateAdmissionSchema.safeParse(
        current.stateMigration,
      );

      if (!stored.success || JSON.stringify(stored.data) !== expected)
        return current;

      const { stateMigration: _retired, ...remaining } = current;
      retired = true;

      return remaining;
    },
  });

  return retired;
}
