import { z } from "zod";

export const THREAD_GROUP_MAX_THREADS = 200;

export const threadGroupSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export type ThreadGroupResponse = z.infer<typeof threadGroupSchema>;

export const threadGroupListQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
  })
  .strict();

export type ThreadGroupListQuery = z.infer<typeof threadGroupListQuerySchema>;

export const createThreadGroupRequestSchema = z
  .object({
    name: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(1).max(THREAD_GROUP_MAX_THREADS),
  })
  .strict();

export type CreateThreadGroupRequest = z.infer<
  typeof createThreadGroupRequestSchema
>;

export const createThreadGroupResponseSchema = z
  .object({
    group: threadGroupSchema,
    threadIds: z.array(z.string().min(1)),
  })
  .strict();

export type CreateThreadGroupResponse = z.infer<
  typeof createThreadGroupResponseSchema
>;

export const updateThreadGroupRequestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type UpdateThreadGroupRequest = z.infer<
  typeof updateThreadGroupRequestSchema
>;

export const deleteThreadGroupRequestSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export type DeleteThreadGroupRequest = z.infer<
  typeof deleteThreadGroupRequestSchema
>;

export const threadGroupMutationResponseSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    updatedThreadCount: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadGroupMutationResponse = z.infer<
  typeof threadGroupMutationResponseSchema
>;
