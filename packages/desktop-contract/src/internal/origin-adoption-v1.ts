import { z } from "zod";

const originSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);

    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)))
    );
  });

export const originStorageTicketSchemaV1 = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    selectedIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    nonce: z.string().regex(/^[a-f0-9]{64}$/u),
    fromOrigin: originSchema,
    toOrigin: originSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.fromOrigin !== value.toOrigin &&
      value.selectedIds.includes(value.id) &&
      new Set(value.selectedIds).size === value.selectedIds.length &&
      JSON.stringify([...value.selectedIds].sort()) ===
        JSON.stringify(value.selectedIds),
  );

export type OriginStorageTicketV1 = z.infer<typeof originStorageTicketSchemaV1>;

export const originNativeMappingSchemaV1 = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    fromOrigin: z.string(),
    toOrigin: z.string(),
    serverHostId: z.string().min(1).max(200),
    runtimeId: z.string().min(1).max(200),
    selectedIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    mappingSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const originNativeCompletionSchemaV1 = z
  .object({
    version: z.literal(1),
    kind: z.literal("origin-adoption-complete"),
    adoptionId: z.string().min(1).max(200),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    windowKey: z.string().min(1).max(200),
    mapping: originNativeMappingSchemaV1,
    originPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    targetStageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    returnPath: z.string().max(8192),
    sourceInventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    targetInventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const originNativeInventorySchemaV1 = originNativeCompletionSchemaV1
  .omit({ kind: true, originPayloadSha256: true, targetStageSha256: true })
  .extend({ kind: z.literal("origin-adoption-inventory") });

export const originLocalWindowSchemaV1 = z
  .object({
    ticket: originStorageTicketSchemaV1,
    windowKey: z.string().min(1).max(200),
    targetStageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    originPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    composerTabId: z.string().min(1).max(200).nullable(),
  })
  .strict();

export type OriginLocalWindowV1 = z.infer<typeof originLocalWindowSchemaV1>;

export const originNativeSessionRestoreSchemaV1 = z
  .object({
    version: z.literal(1),
    ticket: originStorageTicketSchemaV1,
    windowKey: z.string().min(1).max(200),
    targetStageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    nativeJobId: z.string().min(1).max(200),
    mapping: originNativeMappingSchemaV1,
    localWindows: z.array(originLocalWindowSchemaV1).min(1).max(32),
  })
  .strict();

const nativeFirstEntryBindingSchema = z
  .object({
    version: z.literal(1),
    nativeJobId: z.string().min(1).max(200),
    localSelectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    transferId: z.string().regex(/^[a-f0-9]{64}$/u),
    windowKey: z.string().min(1).max(200),
    targetStageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    originPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    composerTabId: z.string().min(1).max(200).nullable(),
    mapping: originNativeMappingSchemaV1,
  })
  .strict();

export const originNativeSessionIdentitySchemaV1 = nativeFirstEntryBindingSchema
  .extend({
    kind: z.literal("origin-native-session-identity"),
    recipeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const originNativeWindowEntrySchemaV1 = z.union([
  originNativeSessionIdentitySchemaV1,
  originNativeSessionRestoreSchemaV1,
]);

export const originNativeFirstEntryRequestSchemaV1 = z.discriminatedUnion(
  "kind",
  [
    nativeFirstEntryBindingSchema
      .extend({ kind: z.literal("inspect"), recipeSha256: z.null() })
      .strict(),
    nativeFirstEntryBindingSchema
      .extend({
        kind: z.enum([
          "preflight",
          "ready",
          "prepared",
          "retired",
          "will-enter",
          "entered",
        ]),
        recipeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  ],
);

export const originNativeFirstEntryReplySchemaV1 = nativeFirstEntryBindingSchema
  .extend({
    kind: z.enum([
      "inspect-accepted",
      "preflight-accepted",
      "ready-accepted",
      "prepared-accepted",
      "retired-accepted",
      "entry-authorized",
      "entry-confirmed",
    ]),
    recipeSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    phase: z.enum([
      "pre-entry",
      "all-local-preflight",
      "all-local-ready",
      "all-local-prepared",
      "all-local-retired",
      "ordinary-entry-authorized",
    ]),
    protectedAdmission: z.union([z.literal(0), z.literal(1)]),
    ordinaryEntryAuthorized: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.ordinaryEntryAuthorized !==
        (value.phase === "ordinary-entry-authorized") ||
      (value.ordinaryEntryAuthorized &&
        (value.protectedAdmission !== 1 || value.recipeSha256 === null)) ||
      (value.kind === "preflight-accepted" &&
        value.phase !== "all-local-preflight") ||
      (value.kind === "entry-confirmed" &&
        value.phase !== "ordinary-entry-authorized") ||
      (value.kind !== "inspect-accepted" && value.recipeSha256 === null) ||
      (value.kind === "ready-accepted" && value.phase !== "all-local-ready") ||
      (value.kind === "prepared-accepted" &&
        value.phase !== "all-local-prepared") ||
      (value.kind === "retired-accepted" &&
        value.phase !== "all-local-retired") ||
      (value.kind === "entry-authorized" &&
        value.phase !== "ordinary-entry-authorized") ||
      (["all-local-prepared", "all-local-retired"].includes(value.phase) &&
        value.protectedAdmission !== 1)
    )
      context.addIssue({
        code: "custom",
        message: "Native first-entry reply has inconsistent writer admission",
      });
  });
