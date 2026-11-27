import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "omnyo-environment-provider-host/progress";

export const worktreeBaseBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);

export type WorktreeBaseBranch = z.infer<typeof worktreeBaseBranchSchema>;

export const discoveredWorktreeSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().nullable(),
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .strict();

export type DiscoveredWorktree = z.infer<typeof discoveredWorktreeSchema>;

export const storageWorktreeSchema = z
  .object({ sourcePath: z.string().min(1), path: z.string().min(1) })
  .strict();

export const storageSharingResultSchema = z
  .object({
    status: z.enum(["completed", "unsupported", "disabled", "cancelled"]),
    sharedFiles: z.number().int().nonnegative(),
    privateBytesReleased: z.number().nonnegative(),
    volumeFreeBytesChange: z.number().safe().nullable().optional(),
    skippedFiles: z.number().int().nonnegative(),
    skippedWorktrees: z.array(
      z.object({ path: z.string(), reason: z.string() }).strict(),
    ),
  })
  .strict();

export type StorageWorktree = z.infer<typeof storageWorktreeSchema>;

export type StorageSharingResult = z.infer<typeof storageSharingResultSchema>;

const missingRegistrationInput = z.object({
  sourcePath: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().min(1),
});

const missingRegistrationProof = z.object({
  head: z.string(),
  identity: z.string(),
  registration: z.string(),
});

export const worktreeHostContract = defineRpcContract({
  reclaimWorktreeStorage: {
    input: z
      .object({
        operationId: z.string().min(1),
        worktrees: z.array(storageWorktreeSchema).max(256),
        protectedPaths: z.array(z.string().min(1)),
      })
      .strict(),
    output: storageSharingResultSchema,
  },
  cancelStorageSharing: {
    input: z.object({ operationId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  inspectMissingRegistration: {
    input: missingRegistrationInput.extend({ pathKey: z.string().min(1) }),
    output: missingRegistrationProof.extend({
      fileCount: z.number(),
      bytes: z.number(),
    }),
  },
  defaultBaseBranch: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listWorktrees: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
  resolveExistingWorktree: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        path: z.string().min(1),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("resolved"),
          path: z.string().min(1),
          branch: z.string().nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  create: {
    input: z
      .object({
        operationId: z.string().min(1),
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branchName: z.string().min(1),
        baseBranch: worktreeBaseBranchSchema,
        branchMode: z.enum(["reset", "reuse-existing"]),
        shareWorktreeStorage: z.boolean().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  remove: {
    input: z
      .object({
        operationId: z.string().min(1),
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
        recovery: missingRegistrationInput
          .omit({ path: true })
          .extend({
            proof: missingRegistrationProof,
          })
          .optional(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
});

export const worktreeHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
