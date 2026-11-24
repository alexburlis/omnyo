import { z } from "zod";

const id = z.string().min(1);

export {
  maintenanceKindSchema,
  maintenancePhaseSchema,
  maintenanceHoldSchema,
  type MaintenanceKind,
  type MaintenancePhase,
  type MaintenanceHold,
} from "@omnyo/domain";

import { maintenanceHoldSchema } from "@omnyo/domain";

export const maintenanceRuntimeSchema = z
  .object({
    runtimeId: id,
    processId: z.number().int().positive(),
    parentProcessId: z.number().int().positive(),
    launchId: id.nullable(),
    dataDir: id,
    serverHostId: id.nullable(),
    appVersion: id,
    protocolVersion: z.number().int().positive(),
    runtimeRecordPath: id.optional(),
  })
  .strict();

const count = z.number().int().nonnegative();

export const maintenanceActivitySchema = z
  .object({
    runningThreads: count,
    pendingInteractions: count,
    hostRpcs: count,
    provisioning: count,
    queuedDispatches: count,
    pluginLoads: count,
    pluginInvocations: count,
    hungServices: count,
  })
  .strict();

export const maintenanceStatusSchema = z
  .object({
    contractVersion: z.literal(1),
    privateUpdateManifestSchema: z.literal(2).optional(),
    runtime: maintenanceRuntimeSchema,
    hold: maintenanceHoldSchema.nullable(),
    activity: maintenanceActivitySchema,
  })
  .strict();

export const serverRuntimeIdentitySchema = z.object({ runtimeId: id }).strict();

export const acquireUpdateHoldSchema = z
  .object({
    id,
    ownerId: id,
    expectedRuntimeId: id,
    expectedServerHostId: id,
    expectedDataDir: id,
  })
  .strict();

export const releaseHoldSchema = z
  .object({ id, ownerId: id, expectedServerHostId: id })
  .strict();

export const maintenancePreparationOperationSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("quiesce") }).strict(),
    z.object({ type: z.literal("create-manual-target"), name: id }).strict(),
    z
      .object({
        type: z.literal("configure-direct-access"),
        machineServerUrl: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);

            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            );
          }),
      })
      .strict(),
    z.object({ type: z.literal("convert-to-direct"), hostId: id }).strict(),
    z.object({ type: z.literal("enable-server-move") }).strict(),
    z
      .object({ type: z.literal("rebind-plugin"), pluginId: id, rootDir: id })
      .strict(),
  ],
);

export const prepareMaintenanceSchema = acquireUpdateHoldSchema
  .extend({ operation: maintenancePreparationOperationSchema })
  .strict();

export const maintenancePreparationResultSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("quiesce"), threadsStopped: z.literal(true) })
    .strict(),
  z.object({ type: z.literal("create-manual-target"), hostId: id }).strict(),
  z
    .object({
      type: z.literal("configure-direct-access"),
      machineServerUrl: id,
    })
    .strict(),
  z.object({ type: z.literal("convert-to-direct"), hostId: id }).strict(),
  z
    .object({ type: z.literal("enable-server-move"), enabled: z.literal(true) })
    .strict(),
  z
    .object({ type: z.literal("rebind-plugin"), pluginId: id, rootDir: id })
    .strict(),
]);

export const maintenancePrepareResultSchema = z
  .object({
    prepared: z.literal(true),
    id,
    result: maintenancePreparationResultSchema,
  })
  .strict();

export type MaintenancePreparationOperation = z.infer<
  typeof maintenancePreparationOperationSchema
>;

export type PrepareMaintenance = z.infer<typeof prepareMaintenanceSchema>;

export type MaintenancePreparationResult = z.infer<
  typeof maintenancePreparationResultSchema
>;

export type MaintenancePrepareResult = z.infer<
  typeof maintenancePrepareResultSchema
>;

export const maintenanceAcquireResultSchema = z
  .object({
    acquired: z.literal(true),
    runtime: maintenanceRuntimeSchema,
    hold: maintenanceHoldSchema,
  })
  .strict();

export const maintenanceReleaseResultSchema = z
  .object({ released: z.literal(true), id })
  .strict();

export type MaintenanceRuntime = z.infer<typeof maintenanceRuntimeSchema>;

export type MaintenanceActivity = z.infer<typeof maintenanceActivitySchema>;

export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

export type ServerRuntimeIdentity = z.infer<typeof serverRuntimeIdentitySchema>;

export type AcquireUpdateHold = z.infer<typeof acquireUpdateHoldSchema>;

export type ReleaseHold = z.infer<typeof releaseHoldSchema>;

export type MaintenanceAcquireResult = z.infer<
  typeof maintenanceAcquireResultSchema
>;

export type MaintenanceReleaseResult = z.infer<
  typeof maintenanceReleaseResultSchema
>;
