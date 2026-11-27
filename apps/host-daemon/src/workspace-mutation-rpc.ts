import path from "node:path";
import { removeThreadStorage } from "./thread-storage-removal.js";
import type { FilesystemMutationCommand } from "./workspace-read-protocol.js";
import { writeHostFile } from "./command-handlers/file-write.js";
import {
  mkdirHostPath,
  moveHostPath,
  removeHostPath,
} from "./command-handlers/path-mutations.js";
import {
  deleteHostSkill,
  writeHostSkill,
} from "./command-handlers/list-skills.js";
import { replaceSkillDirectory } from "./command-handlers/install-global-skills.js";
import {
  inspectHostGitSource,
  listHostBranchOptions,
} from "./command-handlers/host-branches.js";

export function executeFilesystemMutation(
  command: FilesystemMutationCommand,
  options: {
    dataDir: string;
    shellPath?: string;
  },
): Promise<unknown> {
  switch (command.type) {
    case "host.write_file":
      return writeHostFile(command);
    case "host.mkdir":
      return mkdirHostPath(command);
    case "host.move_path":
      return moveHostPath(command);
    case "host.delete_thread_storage":
      return removeThreadStorage({
        rootPath: path.join(options.dataDir, "thread-storage"),
        threadId: command.threadId,
        missingDirectory: "error",
      }).then(() => ({ ok: true }));
    case "host.remove_path":
      return removeHostPath(command);
    case "host.delete_skill":
      return deleteHostSkill(command, options);
    case "host.write_skill":
      return writeHostSkill(command, options);
    case "skill.replace_directory":
      return replaceSkillDirectory(command).then(() => ({ ok: true }));
    case "host.inspect_git_source":
      return inspectHostGitSource(command, options);
    case "host.list_branch_options":
      return listHostBranchOptions(command, options);
  }
}
