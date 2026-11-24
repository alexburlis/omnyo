import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatAppRuntimeFilePath } from "@omnyo/config/app-runtime-file";
import { maintenanceHoldSchema, type MaintenanceHold } from "@omnyo/domain";
import { z } from "zod";
import { hasErrorCode } from "./errors.js";
import { readJsonFile, writeJsonFileAtomically } from "./json-file.js";
import {
  LAST_SERVER_MOVE_FILE_NAME,
  readLastServerMoveFile,
  readServerImportFile,
  readServerMovedFile,
} from "./markers.js";
import { SERVER_MAINTENANCE_HOLD_FILE_NAME } from "./maintenance-hold.js";
import {
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  type RuntimeIdentity,
} from "./runtime-identity.js";

export const HELD_RUNTIME_REPAIR_FILE_NAME = "server-held-runtime-repair.json";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const id = z.string().min(1);

const heldRuntimeRepairSchema = z
  .object({
    version: z.literal(1),
    dataDir: id,
    originalHoldText: id,
    originalHoldSha256: digest,
    lastMoveSha256: digest,
    promotion: z
      .object({
        version: z.literal(1),
        moveId: id,
        fromHostId: id,
        toHostId: id,
        completedAt: z.number().int().nonnegative(),
      })
      .strict(),
    runtimeSha256: digest,
    runtimeManifestSha256: digest,
    runtimeVersion: id,
    protocolVersion: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export interface RepairHeldRuntimeInput {
  dataDir: string;
  id: string;
  ownerId: string;
  serverHostId: string;
  expectedHoldSha256: string;
  runtimeRoot: string;
  expectedRuntimeSha256: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertOffline(dataDir: string): Promise<void> {
  let bytes: string;

  try {
    bytes = await readFile(formatAppRuntimeFilePath(dataDir), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }

  const { pid } = z
    .object({ pid: z.number().int().positive() })
    .parse(JSON.parse(bytes));

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return;
    throw new Error("Cannot establish that the server runtime is stopped", {
      cause: error,
    });
  }

  throw new Error(
    "Stop the server runtime before repairing its held runtime binding",
  );
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const info = await lstat(path);

  if (
    resolve(path) !== path ||
    (await realpath(path)) !== path ||
    !info.isDirectory() ||
    process.getuid === undefined ||
    info.uid !== process.getuid()
  )
    throw new Error("Held runtime repair requires an exact owned directory");
}

async function promotion(dataDir: string, hold: MaintenanceHold) {
  if (
    (await readServerImportFile(dataDir)) !== null ||
    (await readServerMovedFile(dataDir)) !== null
  )
    throw new Error("Migration markers prevent held runtime repair");
  const last = await readLastServerMoveFile(dataDir);

  if (
    last === null ||
    last.moveId !== hold.id ||
    last.toHostId !== hold.serverHostId ||
    (await readFile(join(dataDir, "host-id"), "utf8")).trim() !==
      hold.serverHostId
  )
    throw new Error("Promoted migration ownership is not confirmed");

  return {
    version: last.version,
    moveId: last.moveId,
    fromHostId: last.fromHostId,
    toHostId: last.toHostId,
    completedAt: last.completedAt,
  };
}

export async function repairHeldRuntime(input: RepairHeldRuntimeInput) {
  digest.parse(input.expectedHoldSha256);
  digest.parse(input.expectedRuntimeSha256);
  await assertOwnedDirectory(input.dataDir);
  await assertOwnedDirectory(input.runtimeRoot);
  await assertOffline(input.dataDir);
  const path = join(input.dataDir, HELD_RUNTIME_REPAIR_FILE_NAME);

  if ((await readJsonFile(path, heldRuntimeRepairSchema)) !== null)
    throw new Error("A held runtime repair binding already exists");
  const holdPath = join(input.dataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME);
  const originalHoldText = await readFile(holdPath, "utf8");
  const hold = maintenanceHoldSchema.parse(JSON.parse(originalHoldText));

  if (
    sha256(originalHoldText) !== input.expectedHoldSha256 ||
    hold.kind !== "migration" ||
    hold.phase !== "releasing" ||
    hold.id !== input.id ||
    hold.ownerId !== input.ownerId ||
    hold.serverHostId !== input.serverHostId ||
    hold.artifact === null
  )
    throw new Error("Held runtime repair ownership does not match");
  const promoted = await promotion(input.dataDir, hold);

  const lastMoveBytes = await readFile(
    join(input.dataDir, LAST_SERVER_MOVE_FILE_NAME),
  );

  const identity = await verifyRuntimeIdentity(
    input.runtimeRoot,
    await readRuntimeIdentity(input.runtimeRoot),
  );

  if (
    identity.runtimeSha256 !== input.expectedRuntimeSha256 ||
    identity.runtimeSha256 === hold.artifact.runtimeSha256
  )
    throw new Error(
      "Held runtime repair requires the exact distinct approved runtime",
    );

  const runtimeManifestSha256 = sha256(
    await readFile(join(input.runtimeRoot, "dist/runtime-identity.json")),
  );

  await assertOffline(input.dataDir);

  if (
    (await readFile(holdPath, "utf8")) !== originalHoldText ||
    sha256(await readFile(join(input.dataDir, LAST_SERVER_MOVE_FILE_NAME))) !==
      sha256(lastMoveBytes) ||
    JSON.stringify(await promotion(input.dataDir, hold)) !==
      JSON.stringify(promoted)
  )
    throw new Error("Migration authority changed during held runtime repair");

  const receipt = heldRuntimeRepairSchema.parse({
    version: 1,
    dataDir: input.dataDir,
    originalHoldText,
    originalHoldSha256: input.expectedHoldSha256,
    lastMoveSha256: sha256(lastMoveBytes),
    promotion: promoted,
    runtimeSha256: identity.runtimeSha256,
    runtimeManifestSha256,
    runtimeVersion: identity.runtimeVersion,
    protocolVersion: identity.hostDaemonProtocolVersion,
    createdAt: Date.now(),
  });

  await writeJsonFileAtomically(path, receipt, true);

  if ((await readFile(holdPath, "utf8")) !== originalHoldText)
    throw new Error(
      "Historical hold changed after the repair binding was written",
    );

  return {
    repaired: true as const,
    id: hold.id,
    runtimeSha256: identity.runtimeSha256,
    runtimeVersion: identity.runtimeVersion,
    originalHoldSha256: input.expectedHoldSha256,
    historicalHoldUnchanged: true as const,
    receiptPath: path,
  };
}

export async function verifyHeldRuntimeRepair(
  dataDir: string,
  hold: MaintenanceHold | null,
  identity: RuntimeIdentity | null,
  runtimeRoot: string,
): Promise<void> {
  const receipt = await readJsonFile(
    join(dataDir, HELD_RUNTIME_REPAIR_FILE_NAME),
    heldRuntimeRepairSchema,
  );

  if (receipt === null) {
    if (
      hold?.kind === "migration" &&
      hold.phase !== "released" &&
      hold.artifact !== null &&
      identity?.runtimeSha256 !== hold.artifact.runtimeSha256
    )
      throw new Error("Held target boot runtime identity mismatch");

    return;
  }

  if (hold === null || identity === null)
    throw new Error("Held target runtime repair binding does not match");

  const original = maintenanceHoldSchema.parse(
    JSON.parse(receipt.originalHoldText),
  );

  const currentText = await readFile(
    join(dataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME),
    "utf8",
  );

  const current = maintenanceHoldSchema.parse(JSON.parse(currentText));

  const expected =
    hold.phase === "released" ? { ...original, phase: "released" } : original;

  if (
    receipt.dataDir !== dataDir ||
    sha256(receipt.originalHoldText) !== receipt.originalHoldSha256 ||
    original.kind !== "migration" ||
    original.phase !== "releasing" ||
    original.artifact === null ||
    !["releasing", "released"].includes(hold.phase) ||
    JSON.stringify(current) !== JSON.stringify(hold) ||
    JSON.stringify(hold) !== JSON.stringify(expected) ||
    (hold.phase === "releasing" && currentText !== receipt.originalHoldText) ||
    (hold.phase === "releasing" &&
      (identity.runtimeSha256 !== receipt.runtimeSha256 ||
        identity.runtimeVersion !== receipt.runtimeVersion ||
        identity.hostDaemonProtocolVersion !== receipt.protocolVersion ||
        identity.runtimeSha256 === original.artifact.runtimeSha256 ||
        sha256(
          await readFile(join(runtimeRoot, "dist/runtime-identity.json")),
        ) !== receipt.runtimeManifestSha256)) ||
    JSON.stringify(await promotion(dataDir, hold)) !==
      JSON.stringify(receipt.promotion)
  )
    throw new Error("Held target runtime repair binding does not match");
}
