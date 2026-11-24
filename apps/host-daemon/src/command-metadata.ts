import {
  assertCanonicalWorkspaceStateV1,
  workspaceStatePathsV1,
} from "@omnyo/config/skill-storage-paths";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { injectedSkillMetadataSchema } from "@omnyo/domain";
import {
  isPathWithinDirectory,
  readMarkdownHeader,
} from "@omnyo/process-utils";
import {
  CatalogCache,
  type CatalogObservationOptions,
  type CatalogCacheScope,
  type CatalogWatch,
  type HostWatcher,
} from "@omnyo/host-watcher";
import type { HostDaemonOnlineRpcResult } from "@omnyo/host-daemon-contract";
import { discoverProviderCommands } from "./command-discovery.js";
import { resolveDeclaredScanRoots } from "./command-handlers/list-commands.js";
import { listSharedSkills } from "./command-handlers/list-skills.js";
import type { CommandOf } from "./command-dispatch-support.js";
import { CommandDispatchError } from "./command-errors.js";
import { resolveNonSymlinkDirectoryPath } from "./command-handlers/root-path.js";

type Metadata = HostDaemonOnlineRpcResult<"host.list_command_metadata">;

export class CommandMetadataCatalog {
  private readonly cache: CatalogCache<Metadata>;

  constructor(watcher: HostWatcher, onChange: () => void);
  constructor(options: CatalogObservationOptions);
  constructor(
    source: HostWatcher | CatalogObservationOptions,
    onChange?: () => void,
  ) {
    if ("mode" in source) this.cache = new CatalogCache(source);
    else {
      if (!onChange)
        throw new Error("Command catalog requires a change handler");
      this.cache = new CatalogCache(source, onChange);
    }
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  retain(scopes: readonly CatalogCacheScope[]): Promise<void> {
    return this.cache.retain(scopes);
  }

  dispose(): Promise<void> {
    return this.cache.dispose();
  }

  async list(
    command: CommandOf<"host.list_command_metadata">,
  ): Promise<Metadata> {
    return (await this.listSnapshot(command)).result;
  }

  async listSnapshot(
    command: CommandOf<"host.list_command_metadata">,
  ): Promise<{ result: Metadata; watches: CatalogWatch[] }> {
    if (command.cwd !== null && !path.isAbsolute(command.cwd)) {
      throw new CommandDispatchError("invalid_path", "cwd must be absolute");
    }

    const snapshot = await this.cache.getSnapshot(
      JSON.stringify(command),
      async (observe) => {
        if (command.nativeRoots.resolved.watchPaths === undefined) {
          for (const root of [
            ...command.nativeRoots.skills.user,
            ...command.nativeRoots.commands.user,
          ]) {
            const parent = path.dirname(path.resolve(os.homedir(), root.path));

            if (parent !== os.homedir()) await observe(parent, true);
          }
        } else {
          for (const target of command.nativeRoots.resolved.watchPaths)
            await observe(target);
        }

        const roots = await resolveDeclaredScanRoots({
          cwd: command.cwd,
          homeDir: os.homedir(),
          providerId: command.providerId,
          nativeRoots: command.nativeRoots,
        });

        for (const root of roots)
          await observe("rootPath" in root ? root.rootPath : root.filePath);

        const [commands, sharedSkills, projectSkills] = await Promise.all([
          discoverProviderCommands({
            roots: roots.map((root) => ({ ...root, observePath: observe })),
          }),
          listSharedSkills({
            cwd: command.cwd ?? os.homedir(),
            roots: command.sharedSkillRoots,
            observePath: observe,
          }),
          this.projectSkills(command.cwd, observe, command.projectSkillRead),
        ]);

        return { commands, sharedSkills, projectSkills };
      },
      command,
    );

    return { result: snapshot.value, watches: snapshot.watches };
  }

  private async projectSkills(
    cwd: string | null,
    observe: (target: string) => Promise<void>,
    policy: CommandOf<"host.list_command_metadata">["projectSkillRead"],
  ): Promise<Metadata["projectSkills"]> {
    if (cwd === null) return [];
    await assertCanonicalWorkspaceStateV1(cwd);
    const root = path.join(cwd, ".omnyo", "skills");
    await Promise.all([
      observe(root),
      observe(workspaceStatePathsV1(cwd).legacyRootPath),
    ]);

    try {
      const realSkillsRoot = await resolveNonSymlinkDirectoryPath({
        description: "Skills path",
        path: root,
      });

      if (!isPathWithinDirectory(await fs.realpath(cwd), realSkillsRoot))
        throw new CommandDispatchError(
          "invalid_path",
          "Skills path escapes workspace",
        );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    }

    const entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !policy.excludeNames.includes(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    if (entries.length > policy.limit)
      throw new Error("Project command metadata exceeds the skill count limit");
    const skills: Metadata["projectSkills"] = [];

    for (let start = 0; start < entries.length; start += 8) {
      const batch = await Promise.all(
        entries
          .slice(start, start + 8)
          .map(
            async (
              entry,
            ): Promise<Metadata["projectSkills"][number] | null> => {
              const sourceRootPath = path.join(root, entry.name);
              await observe(sourceRootPath);
              const filePath = path.join(sourceRootPath, "SKILL.md");

              const stat = await fs.lstat(filePath).catch((error: unknown) => {
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
                  return null;
                throw error;
              });

              if (!stat?.isFile() || stat.size > policy.maxFileBytes)
                return null;
              await observe(filePath);
              const header = await readMarkdownHeader(filePath);
              let parsed;

              try {
                parsed = injectedSkillMetadataSchema.safeParse(
                  matter(header).data,
                );
              } catch {
                return null;
              }

              if (!parsed.success || parsed.data.name !== entry.name)
                return null;

              return {
                name: parsed.data.name,
                description: parsed.data.description,
                sourceRootPath,
              };
            },
          ),
      );

      skills.push(...batch.filter((skill) => skill !== null));
    }

    return skills;
  }
}
