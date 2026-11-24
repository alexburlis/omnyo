import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { ownerRpcContract as rpcContract } from "./contract.js";

export const ownerMetadata = z.object({
  hostId: z.string().min(1),
  chatTargets: z.array(z.string()).optional(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sources: z.array(z.object({ hostId: z.string(), path: z.string() })),
      repositories: z.array(z.string()).optional(),
    }),
  ),
  environments: z.array(
    z.object({
      projectId: z.string(),
      path: z.string().nullable(),
      status: z.string(),
      isGitRepo: z.boolean(),
    }),
  ),
});

export type OwnerMetadata = z.infer<typeof ownerMetadata>;

function owned<I extends z.ZodType, O extends z.ZodType>(method: {
  input: I;
  output: O;
}) {
  return {
    input: z
      .object({ request: method.input, metadata: ownerMetadata })
      .strict(),
    output: method.output,
  };
}

export const hostContract = defineRpcContract({
  inventory: owned(rpcContract.inventory),
  cleanSaved: owned(rpcContract.cleanSaved),
  catalog: owned(rpcContract.catalog),
  sidebar: owned(rpcContract.sidebar),
  inspect: owned(rpcContract.inspect),
  storage: owned(rpcContract.storage),
  cleanupSummary: owned(rpcContract.cleanupSummary),
  projects: owned(rpcContract.projects),
  scan: owned(rpcContract.scan),
  files: owned(rpcContract.files),
  diff: owned(rpcContract.diff),
  prepare: owned(rpcContract.prepare),
  prepareBranch: owned(rpcContract.prepareBranch),
  deleteBranch: owned(rpcContract.deleteBranch),
  prepareAll: owned(rpcContract.prepareAll),
  cleanupAll: owned(rpcContract.cleanupAll),
  purge: owned(rpcContract.purge),
});

export const hostSignals = {
  "git-changed": { payload: z.object({}).strict() },
  "repository-found": {
    payload: z
      .object({
        projectId: z.string(),
        projectName: z.string(),
        path: z.string(),
      })
      .strict(),
  },
  "cleanup-progress": {
    payload: z
      .object({ token: z.string(), done: z.number(), total: z.number() })
      .strict(),
  },
};

export type WorktreePublish = <N extends keyof typeof hostSignals>(
  name: N,
  payload: z.infer<(typeof hostSignals)[N]["payload"]>,
) => void;
