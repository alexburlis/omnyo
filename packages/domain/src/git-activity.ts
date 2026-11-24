import { z } from "zod";

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const gitActivityCommitKindValues = [
  "commit",
  "amend",
  "merge",
  "cherry-pick",
  "revert",
] as const;

export const gitActivityCommitSchema = z.object({
  sha: gitObjectIdSchema,
  subject: z.string(),
  kind: z.enum(gitActivityCommitKindValues),
  branch: z.string().min(1).nullable(),
  replacedSha: gitObjectIdSchema.nullable(),
  committedAt: z.number().int().nonnegative(),
  remoteRefs: z.array(z.string().min(1)),
});

export type GitActivityCommit = z.infer<typeof gitActivityCommitSchema>;

export const gitActivityPushSchema = z.object({
  remote: z.string().min(1),
  branch: z.string().min(1),
  oldSha: gitObjectIdSchema.nullable(),
  newSha: gitObjectIdSchema,
  forced: z.boolean(),
  pushedAt: z.number().int().nonnegative(),
  commitCount: z.number().int().nonnegative().nullable(),
});

export type GitActivityPush = z.infer<typeof gitActivityPushSchema>;

export const gitActivityRemoteSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
});

export type GitActivityRemote = z.infer<typeof gitActivityRemoteSchema>;

export const gitActivitySchema = z.object({
  commits: z.array(gitActivityCommitSchema),
  pushes: z.array(gitActivityPushSchema),
  remotes: z.array(gitActivityRemoteSchema),
});

export type GitActivity = z.infer<typeof gitActivitySchema>;

export const systemGitActivityEventDataSchema = z.object({
  workspacePath: z.string().min(1),
  activity: gitActivitySchema,
});

export type SystemGitActivityEventData = z.infer<
  typeof systemGitActivityEventDataSchema
>;
