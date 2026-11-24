import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { identityAdoptionBindingSchema } from "@omnyo/domain";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
  readRuntimeIdentity,
  verifyWorkerRuntimeIdentity,
} from "@omnyo/server-archive";
import type { ProtocolSelfUpdateTarget } from "./protocol-self-update.js";
import type { ServerMoveService } from "./server-move/service.js";

export const WORKER_IDENTITY_ADOPTION_REQUEST_V1 =
  "identity-adoption-request-v1.json";

export async function prepareWorkerIdentityAdoptionRestart(args: {
  dataDir: string;
  hostId: string;
  instanceId: string;
  updateOwner: string;
  serverMove: Pick<ServerMoveService, "runtimeUpdateStatus">;
  target: ProtocolSelfUpdateTarget;
}): Promise<void> {
  let text: string;

  try {
    text = await readFile(
      join(args.dataDir, WORKER_IDENTITY_ADOPTION_REQUEST_V1),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }

  const binding = identityAdoptionBindingSchema.parse(JSON.parse(text));

  if (
    binding.ownerKind !== "worker" ||
    binding.sourceDataDir !== args.dataDir ||
    binding.archiveSha256 !== args.target.artifactDigest
  )
    throw new Error(
      "Worker identity request differs from the admitted update target",
    );
  const admission = args.serverMove.runtimeUpdateStatus();

  if (
    !admission.held ||
    admission.holdOwner !== args.updateOwner ||
    admission.directProbe ||
    admission.activation ||
    admission.activity === null ||
    Object.values(admission.activity).some((count) => count !== 0) ||
    admission.blockers.some((blocker) => blocker !== "update_held")
  )
    throw new Error("Worker identity update lost its existing idle admission");

  const identity = await verifyWorkerRuntimeIdentity(
    binding.runtimeRoot,
    await readRuntimeIdentity(binding.runtimeRoot),
  );

  if (
    identity.runtimeSha256 !== binding.runtimeSha256 ||
    identity.runtimeVersion !== args.target.version ||
    identity.hostDaemonProtocolVersion !== args.target.protocolVersion
  )
    throw new Error(
      "Worker identity runtime bytes differ from the admitted update",
    );
  const id = `worker_identity_${args.instanceId.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
  const existing = readMaintenanceHold(args.dataDir);

  if (existing !== null) {
    if (
      existing.id !== id ||
      existing.ownerId !== args.updateOwner ||
      existing.kind !== "desktop-update" ||
      existing.phase !== "held" ||
      existing.serverHostId !== args.hostId ||
      existing.artifact?.archiveSha256 !== binding.archiveSha256 ||
      existing.artifact.runtimeSha256 !== binding.runtimeSha256
    )
      throw new Error(
        "A foreign maintenance owner blocks worker identity adoption",
      );
  } else {
    await writeMaintenanceHold(args.dataDir, {
      version: 1,
      id,
      ownerId: args.updateOwner,
      kind: "desktop-update",
      phase: "held",
      serverHostId: args.hostId,
      createdAt: Date.now(),
      artifact: {
        archiveSha256: binding.archiveSha256,
        runtimeSha256: binding.runtimeSha256,
      },
    });
  }
}
