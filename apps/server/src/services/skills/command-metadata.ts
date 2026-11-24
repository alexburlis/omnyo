import { REGISTRY_SKILL_PROVENANCE_FILE_NAME } from "./registry-skill-provenance.js";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { injectedSkillMetadataSchema } from "@omnyo/domain";
import { resolveDataDirSkillsRootPath } from "@omnyo/config/skill-storage-paths";
import { readMarkdownHeader } from "@omnyo/process-utils";
import type { ServerRuntimeConfig, ServerLogger } from "../../types.js";
import { getPluginSkillRootContributions } from "../plugins/plugin-agent-contributions.js";
import { generatedSkillsRootPath } from "../plugins/plugin-commands-skill.js";
import {
  mergeSkillCatalogEntries,
  type SkillMetadataSource,
} from "./injected-skills.js";

export class ServerCommandMetadata {
  private readonly roots = new Map<
    string,
    Map<string, { stamp: string; source: SkillMetadataSource | null }>
  >();
  private readonly pending = new Map<string, Promise<SkillMetadataSource[]>>();

  constructor(
    private readonly deps: {
      config: Pick<ServerRuntimeConfig, "dataDir" | "inheritedSkillsRootPaths">;
      logger: ServerLogger;
    },
  ) {}

  async dispose(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    this.roots.clear();
  }

  async resolve(args: {
    projectSources: SkillMetadataSource[];
    sharedSources: SkillMetadataSource[];
  }) {
    const config = this.deps.config;

    const read = (root: string): Promise<SkillMetadataSource[]> => {
      const pending = this.pending.get(root);

      if (pending) return pending;

      const work = (async () => {
        const cached =
          this.roots.get(root) ??
          new Map<
            string,
            { stamp: string; source: SkillMetadataSource | null }
          >();

        const next = new Map<
          string,
          { stamp: string; source: SkillMetadataSource | null }
        >();

        let stat;

        try {
          stat = await fs.lstat(root);
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

        if (!stat.isDirectory()) return [];

        const entries = (await fs.readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name));

        const results: SkillMetadataSource[] = [];

        for (let start = 0; start < entries.length; start += 8) {
          const batch = await Promise.all(
            entries
              .slice(start, start + 8)
              .map(async (entry): Promise<SkillMetadataSource | null> => {
                const candidate = path.join(root, entry.name);
                const file = path.join(candidate, "SKILL.md");

                const fileStat = await fs
                  .lstat(file)
                  .catch((error: unknown) => {
                    if (
                      typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      error.code === "ENOENT"
                    )
                      return null;
                    throw error;
                  });

                if (!fileStat?.isFile()) return null;
                const stamp = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
                const previous = cached.get(file);

                if (previous?.stamp === stamp) {
                  next.set(file, previous);

                  return previous.source !== null &&
                    (await this.validTree(candidate))
                    ? previous.source
                    : null;
                }

                const header = await readMarkdownHeader(file);
                let data;

                try {
                  data = injectedSkillMetadataSchema.safeParse(
                    matter(header).data,
                  );
                } catch {
                  this.deps.logger.warn(
                    { candidatePath: candidate },
                    "Skipping invalid command metadata",
                  );

                  return null;
                }

                if (!data.success || data.data.name !== entry.name) return null;

                if (!(await this.validTree(candidate))) return null;

                const source: SkillMetadataSource = {
                  kind: "metadata",
                  sourceType: "data-dir",
                  name: data.data.name,
                  description: data.data.description,
                  sourceRootPath: candidate,
                };

                next.set(file, { stamp, source });

                return source;
              }),
          );

          results.push(...batch.filter((entry) => entry !== null));
        }

        this.roots.delete(root);
        this.roots.set(root, next);

        while (
          this.roots.size > 32 ||
          Buffer.byteLength(
            JSON.stringify([...this.roots.values()].map((files) => [...files])),
          ) >
            16 * 1024 * 1024
        ) {
          const oldest = this.roots.keys().next().value;

          if (oldest === undefined) break;
          this.roots.delete(oldest);
        }

        return results;
      })();

      this.pending.set(root, work);

      return work.finally(() => this.pending.delete(root));
    };

    const [dataDirSources, inheritedSourceGroups, pluginSourceGroups] =
      await Promise.all([
        read(resolveDataDirSkillsRootPath(config.dataDir)),
        Promise.all(
          [
            ...config.inheritedSkillsRootPaths,
            generatedSkillsRootPath(config.dataDir),
          ].map(read),
        ),
        Promise.all(
          getPluginSkillRootContributions().map(
            async ({ pluginId, rootPath }) => ({
              pluginId,
              sources: await read(rootPath),
            }),
          ),
        ),
      ]);

    return mergeSkillCatalogEntries(this.deps.logger, {
      ...args,
      dataDirSources,
      inheritedSourceGroups,
      pluginSourceGroups,
    });
  }

  private async validTree(root: string, topLevel = true): Promise<boolean> {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (topLevel && entry.name === REGISTRY_SKILL_PROVENANCE_FILE_NAME)
        continue;

      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        return false;

      if (
        entry.isDirectory() &&
        !(await this.validTree(path.join(root, entry.name), false))
      )
        return false;
    }

    return true;
  }
}
