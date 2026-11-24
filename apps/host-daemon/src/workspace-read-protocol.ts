import { z } from "zod";
import path from "node:path";
import {
  hostDaemonCommandRegistry,
  hostDaemonInjectedSkillSourceSchema,
  hostDaemonOnlineRpcResultSchemaByType,
} from "@omnyo/host-daemon-contract";

const skillRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );

export const localSkillCollectionSchema = z.object({
  directories: z.array(z.object({ relativePath: skillRelativePathSchema })),
  files: z.array(
    z.object({
      relativePath: skillRelativePathSchema,
      contentBase64: z.string(),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      mode: z.number().int().min(0).max(0o777),
    }),
  ),
  totalBytes: z.number().int().min(0),
});

export type LocalSkillCollection = z.infer<typeof localSkillCollectionSchema>;

export const workspaceSnapshotSchema = z.object({
  path: z.string(),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
  additionalWorkspaceWriteRoots: z.array(z.string()),
});

export const catalogWatchSchema = z.object({
  rootPath: z.string(),
  ignoredPaths: z.array(z.string()),
  targets: z.array(z.object({ path: z.string(), shallow: z.boolean() })),
});

export const readonlyFilesystemCommandSchema = z.discriminatedUnion("type", [
  hostDaemonCommandRegistry["host.global_skills_status"].schema,
  hostDaemonCommandRegistry["host.paths_exist"].schema,
  hostDaemonCommandRegistry["host.browse_directory"].schema,
  hostDaemonCommandRegistry["host.list_files"].schema,
  hostDaemonCommandRegistry["host.list_paths"].schema,
  hostDaemonCommandRegistry["host.read_file"].schema,
  hostDaemonCommandRegistry["host.read_file_chunk"].schema,
  hostDaemonCommandRegistry["host.read_file_relative"].schema,
  hostDaemonCommandRegistry["host.list_commands"].schema,
  hostDaemonCommandRegistry["host.list_skills"].schema,
  hostDaemonCommandRegistry["project.inspect"].schema,
  hostDaemonCommandRegistry["host.discover_repos"].schema,
  hostDaemonCommandRegistry["workspace.status"].schema,
  hostDaemonCommandRegistry["workspace.diff"].schema,
  hostDaemonCommandRegistry["workspace.diffFiles"].schema,
  hostDaemonCommandRegistry["workspace.diffPatch"].schema,
  hostDaemonCommandRegistry["workspace.gitActivity"].schema,
]);

export type ReadonlyFilesystemCommand = z.infer<
  typeof readonlyFilesystemCommandSchema
>;

export const directoryReplacementResultSchema = z.object({
  ok: z.literal(true),
});

export const filesystemMutationCommandSchema = z.union([
  z.object({
    type: z.literal("skill.replace_directory"),
    destinationPath: z.string(),
    name: z.string(),
    skillFilePath: z.string(),
    sourceRootPath: z.string(),
  }),
  hostDaemonCommandRegistry["host.write_file"].schema,
  hostDaemonCommandRegistry["host.mkdir"].schema,
  hostDaemonCommandRegistry["host.move_path"].schema,
  hostDaemonCommandRegistry["host.remove_path"].schema,
  hostDaemonCommandRegistry["host.delete_skill"].schema,
  hostDaemonCommandRegistry["host.write_skill"].schema,
  hostDaemonCommandRegistry["host.inspect_git_source"].schema,
  hostDaemonCommandRegistry["host.list_branch_options"].schema,
]);

export type FilesystemMutationCommand = z.infer<
  typeof filesystemMutationCommandSchema
>;

export const workspaceReadRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("access"),
    id: z.number().int(),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("mutate"),
    id: z.number().int(),
    command: filesystemMutationCommandSchema,
    dataDir: z.string(),
    shellPath: z.string().optional(),
  }),

  z.object({
    kind: z.literal("rpc"),
    id: z.number().int(),
    command: readonlyFilesystemCommandSchema,
    shellPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("metadata"),
    id: z.number().int(),
    command: hostDaemonCommandRegistry["host.list_command_metadata"].schema,
  }),
  z.object({
    kind: z.literal("provision"),
    id: z.number().int(),
    path: z.string(),
    shellPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("context"),
    id: z.number().int(),
    command:
      hostDaemonCommandRegistry["host.read_workspace_agent_context"].schema,
  }),
  z.object({
    kind: z.literal("collect-local"),
    id: z.number().int(),
    source: hostDaemonInjectedSkillSourceSchema,
  }),
  z.object({ kind: z.literal("invalidate") }),
  z.object({ kind: z.literal("shutdown") }),
]);

export const workspaceReadResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("access"),
    id: z.number().int(),
    accessible: z.boolean(),
  }),
  z.object({
    kind: z.literal("mutate"),
    id: z.number().int(),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("rpc"),
    id: z.number().int(),
    result: z.unknown(),
  }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("changed") }),
  z.object({
    kind: z.literal("metadata"),
    id: z.number().int(),
    result: hostDaemonOnlineRpcResultSchemaByType["host.list_command_metadata"],
    watches: z.array(catalogWatchSchema),
  }),
  z.object({
    kind: z.literal("provision"),
    id: z.number().int(),
    result: workspaceSnapshotSchema,
  }),
  z.object({
    kind: z.literal("context"),
    id: z.number().int(),
    result:
      hostDaemonOnlineRpcResultSchemaByType[
        "host.read_workspace_agent_context"
      ],
  }),
  z.object({
    kind: z.literal("collect-local"),
    id: z.number().int(),
    result: localSkillCollectionSchema,
  }),
  z.object({
    kind: z.literal("error"),
    id: z.number().int(),
    message: z.string(),
    code: z.string(),
    expected: z.boolean(),
  }),
]);

export type WorkspaceReadRequest = z.infer<typeof workspaceReadRequestSchema>;

export type WorkspaceReadResponse = z.infer<typeof workspaceReadResponseSchema>;
