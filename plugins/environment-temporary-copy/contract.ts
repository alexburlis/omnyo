import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const fileKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const branchSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
]);

const shaSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);

export const copyRefSchema = z
  .object({ name: z.string().min(1).max(512), sha: shaSchema })
  .strict();

export type CopyRefPayload = z.infer<typeof copyRefSchema>;

const digestShape = {
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
};

const ok = z.object({ ok: z.literal(true) }).strict();

export const temporaryCopyHostContract = defineRpcContract({
  createSnapshot: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        sourcePath: z.string().min(1),
        branch: branchSelectionSchema,
      })
      .strict(),
    output: z.object({ commit: shaSchema, ...digestShape }).strict(),
  },
  readRelay: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        offset: z.number().int().nonnegative(),
        length: z.number().int().positive().max(MAX_CHUNK_BYTES),
      })
      .strict(),
    output: z
      .object({ dataBase64: z.string(), sha256: digestShape.sha256 })
      .strict(),
  },
  appendRelay: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        offset: z.number().int().nonnegative(),
        dataBase64: z.string(),
        sha256: digestShape.sha256,
      })
      .strict(),
    output: ok,
  },
  deleteRelay: {
    input: z.object({ snapshotId: fileKeySchema }).strict(),
    output: ok,
  },
  materialize: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        pathKey: fileKeySchema,
        branch: z.string().min(1),
        baseRef: z.string().min(1),
        baseCommit: shaSchema,
        ...digestShape,
      })
      .strict(),
    output: z.object({ path: z.string().min(1) }).strict(),
  },
  prepareCopyBack: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        path: z.string().min(1),
        baseCommit: shaSchema,
        baseRef: z.string().min(1),
        haves: z.array(shaSchema),
        recordUnsaved: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        refs: z.array(copyRefSchema),
        unsaved: shaSchema.nullable(),
        ...digestShape,
      })
      .strict(),
  },
  prepareOriginCheckout: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        threadId: fileKeySchema,
        head: shaSchema,
        unsaved: shaSchema.nullable(),
      })
      .strict(),
    output: z
      .object({ path: z.string().min(1), kept: z.string().min(1).nullable() })
      .strict(),
  },
  readOriginCheckout: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        threadId: fileKeySchema,
        base: shaSchema,
      })
      .strict(),
    output: z
      .object({
        head: shaSchema,
        changes: z.array(z.string()),
        newCommits: z.boolean(),
        keptAt: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
  },
  writeOriginPack: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        sourcePath: z.string().min(1),
        tip: shaSchema,
        base: shaSchema,
      })
      .strict(),
    output: z.object(digestShape).strict(),
  },
  applyOriginPack: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        path: z.string().min(1),
        tip: shaSchema,
        expectedHead: shaSchema,
        ...digestShape,
      })
      .strict(),
    output: z.object({ fastForwarded: z.boolean() }).strict(),
  },
  removeOriginCheckout: {
    input: z
      .object({ sourcePath: z.string().min(1), threadId: fileKeySchema })
      .strict(),
    output: z.object({ kept: z.string().min(1).nullable() }).strict(),
  },
  listSideRefs: {
    input: z
      .object({ sourcePath: z.string().min(1), threadId: fileKeySchema })
      .strict(),
    output: z.object({ shas: z.array(shaSchema) }).strict(),
  },
  applyCopyBack: {
    input: z
      .object({
        snapshotId: fileKeySchema,
        sourcePath: z.string().min(1),
        threadId: fileKeySchema,
        branch: z.string().min(1),
        baseCommit: shaSchema,
        refs: z.array(copyRefSchema),
        ...digestShape,
      })
      .strict(),
    output: z
      .object({ sideRefs: z.array(copyRefSchema), branchUpdated: z.boolean() })
      .strict(),
  },
  confirmCopyBack: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        threadId: fileKeySchema,
        baseCommit: shaSchema,
        refs: z.array(copyRefSchema),
      })
      .strict(),
    output: z.object({ confirmed: z.boolean() }).strict(),
  },
  inspectCopy: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ exists: z.boolean() }).strict(),
  },
  removeCopy: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: ok,
  },
});
