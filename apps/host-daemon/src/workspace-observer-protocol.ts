import { discoveredWorkspacePropertiesSchema } from "@omnyo/domain";
import { workspaceContextSchema } from "@omnyo/host-daemon-contract";
import { z } from "zod";

const watchSetSchema = z.object({
  generation: z.number().int().nonnegative(),
  workspaceTargets: z.array(
    z.object({
      environmentId: z.string(),
      workspaceContext: workspaceContextSchema,
    }),
  ),
  threadStorageTargets: z.array(
    z.object({ environmentId: z.string(), threadId: z.string() }),
  ),
});

const rawWatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    rootPath: z.string(),
    environmentId: z.string(),
  }),
  z.object({
    kind: z.literal("path"),
    rootPath: z.string(),
    ignoredPaths: z.array(z.string()),
  }),
  z.object({ kind: z.literal("thread-storage"), rootPath: z.string() }),
  z.object({ kind: z.literal("skills"), rootPath: z.string() }),
]);

export const workspaceObserverRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialize"),
    id: z.number().int(),
    threadStorageRootPath: z.string().nullable(),
    shellPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("replace"),
    id: z.number().int(),
    authoritative: z.boolean(),
    watchSet: watchSetSchema,
    shellPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("watch"),
    id: z.number().int(),
    watchId: z.number().int(),
    watch: rawWatchSchema,
  }),
  z.object({
    kind: z.literal("stop-watch"),
    id: z.number().int(),
    watchId: z.number().int(),
  }),
  z.object({ kind: z.literal("shutdown"), id: z.number().int() }),
]);

const pathChangesSchema = z.array(
  z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) }),
);

const workspaceChangeKindsSchema = z.array(
  z.enum([
    "workspace-content-changed",
    "workspace-git-changed",
    "workspace-git-repository-created",
    "shared-git-refs-changed",
  ]),
);

export const workspaceObserverResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({
    kind: z.literal("backend-failure"),
    rootPath: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("result"),
    id: z.number().int(),
    workspaceWatches: z.number().int().nonnegative(),
    threadStorageTargets: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("failure"),
    id: z.number().int(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("storage-change"),
    environmentId: z.string(),
    threadId: z.string(),
  }),
  z.object({
    kind: z.literal("storage-error"),
    rootPath: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("workspace-change"),
    environmentId: z.string(),
    changeKinds: z.array(
      z.enum([
        "work-status-changed",
        "git-refs-changed",
        "thread-storage-changed",
      ]),
    ),
  }),
  z.object({
    kind: z.literal("metadata-change"),
    environmentId: z.string(),
    workspace: discoveredWorkspacePropertiesSchema,
  }),
  z.object({
    kind: z.literal("workspace-error"),
    environmentId: z.string(),
    rootPath: z.string(),
    message: z.string(),
  }),
  z.object({ kind: z.literal("watch-ready"), watchId: z.number().int() }),
  z.object({
    kind: z.literal("watch-error"),
    watchId: z.number().int(),
    rootPath: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("watch-path-change"),
    watchId: z.number().int(),
    changes: pathChangesSchema,
  }),
  z.object({
    kind: z.literal("watch-workspace-change"),
    watchId: z.number().int(),
    changedPaths: z.array(z.string()),
    changeKinds: workspaceChangeKindsSchema,
  }),
  z.object({
    kind: z.literal("watch-storage-change"),
    watchId: z.number().int(),
  }),
  z.object({
    kind: z.literal("watch-skills-change"),
    watchId: z.number().int(),
    changedPaths: z.array(z.string()),
  }),
  z.object({ kind: z.literal("watch-rescan"), watchId: z.number().int() }),
]);

export type WorkspaceObserverRequest = z.infer<
  typeof workspaceObserverRequestSchema
>;

export type WorkspaceObserverResponse = z.infer<
  typeof workspaceObserverResponseSchema
>;

export type WorkspaceObserverCommand =
  WorkspaceObserverRequest extends infer Request
    ? Request extends { id: number }
      ? Omit<Request, "id">
      : never
    : never;
