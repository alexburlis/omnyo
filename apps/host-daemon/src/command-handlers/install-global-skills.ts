import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDaemonOnlineRpcResult } from "@omnyo/host-daemon-contract";
import { CommandDispatchError } from "../command-errors.js";
import type { CommandOf } from "../command-dispatch-support.js";
import {
  copyInjectedSkillSource,
  ensureStoredSkillTree,
  hashInstalledSkillDirectory,
  scheduleSkillStoreGc,
  type InjectedSkillsLogger,
} from "../injected-skills.js";
import type { FetchSkillTree } from "../skill-trees.js";
import { isFsErrorWithCode } from "../fs-errors.js";

const GLOBAL_SKILL_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  [".agents", "skills"],
  [".claude", "skills"],
];

const CANONICAL_CLI_SKILL_NAME = "omnyo-cli";

interface InstallGlobalSkillsOptions {
  dataDir: string;
  fetchSkillTree?: FetchSkillTree;
  homeDir?: string;
  logger: InjectedSkillsLogger;
  replaceDirectory?: (args: ReplaceSkillDirectoryArgs) => Promise<void>;
}

interface GlobalSkillsStatusOptions {
  homeDir?: string;
}

function globalSkillPaths(homeDir: string, name: string): string[] {
  return GLOBAL_SKILL_ROOT_SEGMENTS.map((segments) =>
    path.join(homeDir, ...segments, name),
  );
}

export async function readGlobalSkillsStatus(
  command: CommandOf<"host.global_skills_status">,
  options: GlobalSkillsStatusOptions,
): Promise<HostDaemonOnlineRpcResult<"host.global_skills_status">> {
  const homeDir = options.homeDir ?? os.homedir();

  const entries = await Promise.all(
    command.names.flatMap((name) =>
      globalSkillPaths(homeDir, name).map(async (skillDirectoryPath) => ({
        name,
        path: skillDirectoryPath,
        treeHash: await hashInstalledSkillDirectory({
          name,
          skillDirectoryPath,
        }),
      })),
    ),
  );

  return { entries };
}

async function globalSkillPathExists(skillPath: string): Promise<boolean> {
  try {
    await fs.lstat(skillPath);

    return true;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function isCanonicalCliSkillInstalled(args: {
  destinationPath: string;
  treeHash: string;
}): Promise<boolean> {
  if (!(await globalSkillPathExists(args.destinationPath))) return false;

  const installedHash = await hashInstalledSkillDirectory({
    name: CANONICAL_CLI_SKILL_NAME,
    skillDirectoryPath: args.destinationPath,
  });

  if (installedHash !== args.treeHash) {
    throw new CommandDispatchError(
      "global_skill_conflict",
      `The CLI skill at ${args.destinationPath} differs from the requested tree; its existing contents were preserved`,
    );
  }

  return true;
}

export interface ReplaceSkillDirectoryArgs {
  destinationPath: string;
  name: string;
  skillFilePath: string;
  sourceRootPath: string;
}

export async function replaceSkillDirectory(
  args: ReplaceSkillDirectoryArgs,
): Promise<void> {
  const canonicalTreeHash =
    args.name === CANONICAL_CLI_SKILL_NAME
      ? await hashInstalledSkillDirectory({
          name: args.name,
          skillDirectoryPath: args.sourceRootPath,
        })
      : null;

  if (args.name === CANONICAL_CLI_SKILL_NAME) {
    if (canonicalTreeHash === null) {
      throw new CommandDispatchError(
        "invalid_skill_tree",
        "The canonical CLI skill source is not a complete skill tree",
      );
    }

    if (
      await isCanonicalCliSkillInstalled({
        destinationPath: args.destinationPath,
        treeHash: canonicalTreeHash,
      })
    ) {
      return;
    }
  }

  const parentPath = path.dirname(args.destinationPath);
  await fs.mkdir(parentPath, { recursive: true });

  const stagingPath = path.join(
    parentPath,
    `.omnyo-tmp-${args.name}-${process.pid}-${randomUUID()}`,
  );

  try {
    await copyInjectedSkillSource({
      destinationPath: stagingPath,
      name: args.name,
      skillFilePath: args.skillFilePath,
      sourceRootPath: args.sourceRootPath,
    });

    if (canonicalTreeHash !== null) {
      const stagedHash = await hashInstalledSkillDirectory({
        name: args.name,
        skillDirectoryPath: stagingPath,
      });

      if (stagedHash !== canonicalTreeHash) {
        throw new CommandDispatchError(
          "invalid_skill_tree",
          "The staged CLI skill differs from its verified source tree",
        );
      }

      if (
        await isCanonicalCliSkillInstalled({
          destinationPath: args.destinationPath,
          treeHash: canonicalTreeHash,
        })
      ) {
        return;
      }
    } else {
      await fs.rm(args.destinationPath, { force: true, recursive: true });
    }

    await fs.rename(stagingPath, args.destinationPath);
  } finally {
    await fs.rm(stagingPath, { force: true, recursive: true });
  }
}

export async function installGlobalSkills(
  command: CommandOf<"host.install_global_skills">,
  options: InstallGlobalSkillsOptions,
): Promise<HostDaemonOnlineRpcResult<"host.install_global_skills">> {
  const { fetchSkillTree } = options;

  if (fetchSkillTree === undefined) {
    throw new CommandDispatchError(
      "skill_tree_transport_unavailable",
      "Skill tree fetch transport is unavailable",
    );
  }

  const homeDir = options.homeDir ?? os.homedir();
  const installations: { name: string; path: string }[] = [];

  const plans: {
    skill: CommandOf<"host.install_global_skills">["skills"][number];
    destinations: { destinationPath: string; installed: boolean }[];
  }[] = [];

  for (const skill of command.skills) {
    const destinations = await Promise.all(
      globalSkillPaths(homeDir, skill.name).map(async (destinationPath) => ({
        destinationPath,
        installed:
          skill.name === CANONICAL_CLI_SKILL_NAME &&
          (await isCanonicalCliSkillInstalled({
            destinationPath,
            treeHash: skill.treeHash,
          })),
      })),
    );

    plans.push({ skill, destinations });
  }

  for (const { skill, destinations } of plans) {
    if (destinations.every((destination) => destination.installed)) {
      installations.push(
        ...destinations.map(({ destinationPath }) => ({
          name: skill.name,
          path: destinationPath,
        })),
      );
      continue;
    }

    const sourceRootPath = await ensureStoredSkillTree({
      dataDir: options.dataDir,
      fetchSkillTree,
      treeHash: skill.treeHash,
    });

    const skillFilePath = path.resolve(sourceRootPath, skill.entryPath);

    if (
      path.relative(sourceRootPath, skillFilePath).startsWith("..") ||
      path.isAbsolute(path.relative(sourceRootPath, skillFilePath))
    ) {
      throw new CommandDispatchError(
        "invalid_path",
        `Skill entry path escapes its tree: ${skill.entryPath}`,
      );
    }

    for (const { destinationPath, installed } of destinations) {
      if (!installed) {
        await (options.replaceDirectory ?? replaceSkillDirectory)({
          destinationPath,
          name: skill.name,
          skillFilePath,
          sourceRootPath,
        });
      }

      installations.push({ name: skill.name, path: destinationPath });
    }
  }

  if (command.skills.length > 0) {
    scheduleSkillStoreGc(options.dataDir, options.logger);
  }

  return { installations };
}
