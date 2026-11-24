import {
  provisionWorkspace,
  readWorkspaceGitActivity,
  WorkspaceError,
} from "@omnyo/host-workspace";
import {
  browseHostDirectory,
  checkHostPathsExist,
  listHostFiles,
  listHostPaths,
  readHostFile,
  readHostFileChunk,
  readHostRelativeFile,
} from "./command-handlers/host-files.js";
import { listHostCommands } from "./command-handlers/list-commands.js";
import { listHostSkills } from "./command-handlers/list-skills.js";
import { inspectProjectPath } from "./command-handlers/project.js";
import { discoverRepos } from "./command-handlers/discover-repos.js";
import { readGlobalSkillsStatus } from "./command-handlers/install-global-skills.js";
import type { ReadonlyFilesystemCommand } from "./workspace-read-protocol.js";
import { realpath } from "node:fs/promises";
import { isPathWithinDirectory } from "@omnyo/process-utils";

export async function executeReadonlyFilesystemCommand(
  command: ReadonlyFilesystemCommand,
  shellPath: string | undefined,
): Promise<unknown> {
  const options = shellPath === undefined ? {} : { shellPath };

  switch (command.type) {
    case "host.global_skills_status":
      return readGlobalSkillsStatus(command, {});
    case "host.paths_exist":
      return checkHostPathsExist(command);
    case "host.browse_directory":
      return browseHostDirectory(command);
    case "host.list_files":
      return listHostFiles(command);
    case "host.list_paths":
      return listHostPaths(command);
    case "host.read_file":
      return readHostFile(command, options);
    case "host.read_file_chunk":
      return readHostFileChunk(command);
    case "host.read_file_relative":
      return readHostRelativeFile(command);
    case "host.list_commands":
      return listHostCommands(command);
    case "host.list_skills":
      return listHostSkills(command);
    case "project.inspect":
      return inspectProjectPath(command.path, options);
    case "host.discover_repos":
      return discoverRepos(command);
  }

  let workspacePath = command.workspaceContext.workspacePath;

  if (
    command.type === "workspace.gitActivity" &&
    command.repositoryPath !== undefined
  ) {
    const [root, repository] = await Promise.all([
      realpath(workspacePath),
      realpath(command.repositoryPath),
    ]);

    if (!isPathWithinDirectory(root, repository)) {
      throw new WorkspaceError(
        "not_git_repo",
        "Repository is outside the workspace",
      );
    }

    workspacePath = repository;
  }

  const workspace = await provisionWorkspace({
    path: workspacePath,
    ...options,
  });

  if (!workspace.isGitRepo)
    throw new WorkspaceError("not_git_repo", "Path is not a git repository");

  switch (command.type) {
    case "workspace.status":
      return {
        outcome: "available",
        workspaceStatus: await workspace.getStatus({
          mergeBaseBranch: command.mergeBaseBranch,
          maxFiles: command.maxFiles,
          maxUntrackedLineStatFiles: command.maxUntrackedLineStatFiles,
          maxUntrackedLineStatBytes: command.maxUntrackedLineStatBytes,
        }),
      };
    case "workspace.diff":
      return {
        outcome: "available",
        diff: await workspace.getDiff({
          target: command.target,
          maxDiffBytes: command.maxDiffBytes,
          maxFileListBytes: command.maxFileListBytes,
          maxUntrackedFiles: command.maxUntrackedFiles,
        }),
      };
    case "workspace.diffFiles":
      return {
        outcome: "available",
        ...(await workspace.diffFiles({
          target: command.target,
          maxFiles: command.maxFiles,
        })),
      };
    case "workspace.diffPatch":
      return {
        outcome: "available",
        patches: await workspace.diffPatch({
          target: command.target,
          paths: command.paths,
          maxBytesPerFile: command.maxBytesPerFile,
        }),
      };
    case "workspace.gitActivity":
      return {
        outcome: "available",
        activity: await readWorkspaceGitActivity(
          {
            workspacePath: workspace.path,
            windows: command.windows,
            maxCommits: command.maxCommits,
            maxPushes: command.maxPushes,
          },
          options,
        ),
      };
  }
}
