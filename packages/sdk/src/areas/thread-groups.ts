import type {
  CreateThreadGroupRequest,
  CreateThreadGroupResponse,
  DeleteThreadGroupRequest,
  ThreadGroupMutationResponse,
  ThreadGroupResponse,
  UpdateThreadGroupRequest,
} from "@omnyo/server-contract";
import {
  createThreadGroupResponseSchema,
  threadGroupMutationResponseSchema,
  threadGroupSchema,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ThreadGroupCreateResult = CreateThreadGroupResponse;

export type ThreadGroupUpdateResult = ThreadGroupMutationResponse;

export type ThreadGroupDeleteResult = ThreadGroupMutationResponse;

export type ThreadGroupListResult = ThreadGroupResponse[];

export interface ThreadGroupListArgs {
  projectId?: string;
  signal?: AbortSignal;
}

export interface ThreadGroupsArea {
  create(args: CreateThreadGroupRequest): Promise<ThreadGroupCreateResult>;
  delete(args: DeleteThreadGroupRequest): Promise<ThreadGroupDeleteResult>;
  list(args?: ThreadGroupListArgs): Promise<ThreadGroupListResult>;
  update(args: UpdateThreadGroupRequest): Promise<ThreadGroupUpdateResult>;
}

export function createThreadGroupsArea(
  args: CreateSdkAreaArgs,
): ThreadGroupsArea {
  const { transport } = args;

  return {
    async create(input) {
      const body = await transport.readJson(
        transport.api.v1["thread-groups"].$post({ json: input }),
      );

      return createThreadGroupResponseSchema.parse(body);
    },
    async delete(input) {
      const body = await transport.readJson(
        transport.api.v1["thread-groups"].$delete({ json: input }),
      );

      return threadGroupMutationResponseSchema.parse(body);
    },
    async list(input) {
      const body = await transport.readJson(
        transport.api.v1["thread-groups"].$get(
          { query: input?.projectId ? { projectId: input.projectId } : {} },
          ...signalRequestArgs(input?.signal),
        ),
      );

      return threadGroupSchema.array().parse(body);
    },
    async update(input) {
      const body = await transport.readJson(
        transport.api.v1["thread-groups"].$patch({ json: input }),
      );

      return threadGroupMutationResponseSchema.parse(body);
    },
  };
}
