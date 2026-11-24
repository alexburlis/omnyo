import { z } from "zod";

const id = z.string().min(1);

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const identityAdoptionBindingSchema = z
  .object({
    version: z.literal(1),
    ownerKind: z.enum(["coordinator", "worker"]),
    sourceDataDir: id,
    destinationDataDir: id,
    jobDir: id,
    runtimeRoot: id,
    runtimeSha256: digest,
    archiveSha256: digest,
    pluginArtifactsManifestSha256: digest.optional(),
  })
  .strict();

export type IdentityAdoptionBinding = z.infer<
  typeof identityAdoptionBindingSchema
>;

export const identityAdoptionControlRequestSchemaV1 = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
    ownerId: z.string().min(1),
    serverHostId: z.string().min(1),
    expectedHoldSha256: digest,
    binding: identityAdoptionBindingSchema,
    pluginArtifacts: z
      .object({
        manifestPath: id,
        manifestSha256: digest,
        installedInventoryPath: id,
      })
      .strict()
      .optional(),
  })
  .strict();

export type IdentityAdoptionControlRequestV1 = z.infer<
  typeof identityAdoptionControlRequestSchemaV1
>;

export const identityAdoptionPreflightRequestSchemaV1 =
  identityAdoptionControlRequestSchemaV1.partial({ expectedHoldSha256: true });

export type IdentityAdoptionPreflightRequestV1 = z.infer<
  typeof identityAdoptionPreflightRequestSchemaV1
>;

export const maintenanceKindSchema = z.enum([
  "migration",
  "desktop-update",
  "startup",
]);

export const maintenancePhaseSchema = z.enum([
  "acquiring",
  "held",
  "releasing",
  "released",
]);

export const maintenanceHoldSchema = z
  .object({
    version: z.literal(1),
    id,
    ownerId: id,
    kind: maintenanceKindSchema,
    phase: maintenancePhaseSchema,
    serverHostId: id,
    createdAt: z.number().int().nonnegative(),
    identityAdoption: identityAdoptionBindingSchema.optional(),
    artifact: z
      .object({ archiveSha256: digest, runtimeSha256: digest })
      .strict()
      .nullable(),
  })
  .strict();

export type MaintenanceKind = z.infer<typeof maintenanceKindSchema>;

export type MaintenancePhase = z.infer<typeof maintenancePhaseSchema>;

export type MaintenanceHold = z.infer<typeof maintenanceHoldSchema>;
