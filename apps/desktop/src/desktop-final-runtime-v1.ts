import { z } from "zod";
import {
  identityAdoptionBindingSchema,
  maintenanceKindSchema,
} from "@omnyo/domain";
import { maintenanceStatusSchema } from "@omnyo/server-contract";

export const desktopFinalRuntimeDescriptorSchemaV1 = z
  .object({
    version: z.literal(1),
    appVersion: z.literal("0.46.247+private.1"),
    protocolVersion: z.literal(254),
    serverHostId: z.literal("host_0000000002"),
    hold: z
      .object({
        id: z.string().min(1),
        ownerId: z.string().min(1),
        kind: maintenanceKindSchema,
      })
      .strict(),
    binding: identityAdoptionBindingSchema.extend({
      ownerKind: z.literal("coordinator"),
      pluginArtifactsManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  })
  .strict();

export function assertDesktopFinalRuntimeV1(
  expectedValue: unknown,
  statusValue: unknown,
) {
  const expected = desktopFinalRuntimeDescriptorSchemaV1.parse(expectedValue);
  const status = maintenanceStatusSchema.parse(statusValue);
  const hold = status.hold;

  if (
    status.privateUpdateManifestSchema !== 2 ||
    status.runtime.appVersion !== expected.appVersion ||
    status.runtime.protocolVersion !== expected.protocolVersion ||
    status.runtime.serverHostId !== expected.serverHostId ||
    status.runtime.dataDir !== expected.binding.destinationDataDir ||
    hold === null ||
    hold.phase !== "held" ||
    hold.serverHostId !== expected.serverHostId ||
    hold.id !== expected.hold.id ||
    hold.ownerId !== expected.hold.ownerId ||
    hold.kind !== expected.hold.kind ||
    JSON.stringify(hold.identityAdoption) !==
      JSON.stringify(expected.binding) ||
    hold.artifact?.runtimeSha256 !== expected.binding.runtimeSha256 ||
    hold.artifact.archiveSha256 !== expected.binding.archiveSha256 ||
    Object.values(status.activity).some((value) => value !== 0)
  )
    throw new Error(
      "The final coordinator identity and held artifact are not ready for native first-write admission",
    );

  return { runtimeId: status.runtime.runtimeId, descriptor: expected };
}
