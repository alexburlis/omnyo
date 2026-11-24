import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@omnyo/config/skill-storage-paths";
import { resolveBundledNpxCli } from "@omnyo/plugin-build";
import type { RegistrySkillStage } from "@omnyo/server-contract";
import matter from "gray-matter";
import { ApiError } from "../../errors.js";
import { REGISTRY_SKILL_NAME_PATTERN } from "./registry-parse.js";
import {
  readRegistrySkillProvenance,
  REGISTRY_SKILL_PROVENANCE_FILE_NAME,
  writeRegistrySkillProvenance,
} from "./registry-skill-provenance.js";

const SKILL_FILE_NAME = "SKILL.md";

const SKILLS_INSTALL_TIMEOUT_MS = 120_000;

const MAX_INSTALL_OUTPUT_BYTES = 1_000_000;

const MAX_SKILL_FILES = 1_000;

const MAX_SKILL_DIRECTORIES = 1_000;

const MAX_SKILL_BYTES = 10 * 1024 * 1024;

const MAX_SKILL_DEPTH = 24;

const REGISTRY_SKILLS_CLI_VERSION = "1.5.19";

interface InstallCommandResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function appendBounded(current: string, chunk: unknown): string {
  if (current.length >= MAX_INSTALL_OUTPUT_BYTES) return current;

  return `${current}${String(chunk)}`.slice(0, MAX_INSTALL_OUTPUT_BYTES);
}

function registrySkillsCliInvocation(args: {
  cwd: string;
  packageRef: string;
  skillId: string;
}): {
  args: string[];
  command: string;
  options: { cwd: string; env: NodeJS.ProcessEnv };
} {
  const allowedKeys =
    process.platform === "win32"
      ? [
          "PATH",
          "Path",
          "PATHEXT",
          "SYSTEMROOT",
          "SystemRoot",
          "COMSPEC",
          "ComSpec",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "ELECTRON_RUN_AS_NODE",
        ]
      : ["PATH", "HOME", "TMPDIR", "ELECTRON_RUN_AS_NODE"];

  const env: NodeJS.ProcessEnv = { DISABLE_TELEMETRY: "1" };

  for (const key of allowedKeys) {
    const value = process.env[key];

    if (value !== undefined) env[key] = value;
  }

  return {
    command: process.execPath,
    args: [
      resolveBundledNpxCli(),
      "-y",
      `skills@${REGISTRY_SKILLS_CLI_VERSION}`,
      "add",
      args.packageRef,
      "--agent",
      "universal",
      "--skill",
      args.skillId,
      "--copy",
      "--yes",
    ],
    options: { cwd: args.cwd, env },
  };
}

async function runRegistrySkillsCli(args: {
  cwd: string;
  packageRef: string;
  skillId: string;
}): Promise<InstallCommandResult> {
  const invocation = registrySkillsCliInvocation({
    cwd: args.cwd,
    packageRef: args.packageRef,
    skillId: args.skillId,
  });

  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      invocation.args,
      invocation.options,
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: InstallCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_INSTALL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: !timedOut && code === 0,
        stdout,
        stderr: timedOut ? "Skill install timed out" : stderr,
      });
    });
  });
}

function validateSkillFile(
  content: string | null,
  skillId: string,
): string | null {
  if (content === null) {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill is missing SKILL.md",
    );
  }

  let data: Record<string, unknown>;

  try {
    if (!/^\uFEFF?---(?:[ \t]*(?:yaml|json))?[ \t]*\r?\n/u.test(content)) {
      throw new Error("Expected data-only frontmatter");
    }

    data = matter(content, {}).data;
  } catch {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill has invalid frontmatter",
    );
  }

  if (
    data.name !== skillId ||
    typeof data.description !== "string" ||
    data.description.trim().length === 0 ||
    data.description.length > 1_024
  ) {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill metadata does not match the registry entry",
    );
  }

  return typeof data.license === "string" ? data.license : null;
}

async function copyBoundedSkillTree(args: {
  destinationPath: string;
  sourcePath: string;
}): Promise<void> {
  const entries = await collectBoundedSkillTree(args.sourcePath);
  await fs.mkdir(args.destinationPath, { recursive: true });

  for (const entry of entries) {
    const destinationPath = path.join(args.destinationPath, entry.path);

    if (entry.kind === "directory") {
      await fs.mkdir(destinationPath);
      continue;
    }

    await fs.copyFile(path.join(args.sourcePath, entry.path), destinationPath);
    await fs.chmod(destinationPath, entry.mode);
  }
}

type SkillTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; mode: number; path: string; size: number };

async function collectBoundedSkillTree(
  rootPath: string,
  ignoreProvenance = false,
): Promise<SkillTreeEntry[]> {
  const rootStat = await fs.lstat(rootPath);

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Skill root is not a directory");
  }

  const entries: SkillTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_DEPTH) {
      throw new Error(`Skill tree exceeds max depth ${MAX_SKILL_DEPTH}`);
    }

    const children = await fs.readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const relativePath = path.relative(rootPath, childPath);

      if (
        ignoreProvenance &&
        relativePath === REGISTRY_SKILL_PROVENANCE_FILE_NAME
      )
        continue;
      const stat = await fs.lstat(childPath);

      if (stat.isSymbolicLink()) {
        throw new Error("Skill tree contains a symlink");
      }

      if (stat.isDirectory()) {
        directoryCount += 1;

        if (directoryCount > MAX_SKILL_DIRECTORIES) {
          throw new Error("Skill tree exceeds installation limits");
        }

        entries.push({ kind: "directory", path: relativePath });
        await walk(childPath, depth + 1);
        continue;
      }

      if (!stat.isFile()) {
        throw new Error("Skill tree contains a special file");
      }

      fileCount += 1;
      totalBytes += stat.size;

      if (fileCount > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
        throw new Error("Skill tree exceeds installation limits");
      }

      entries.push({
        kind: "file",
        mode: stat.mode & 0o777,
        path: relativePath,
        size: stat.size,
      });
    }
  }

  await walk(rootPath, 0);

  return entries;
}

async function boundedSkillTreesMatch(
  leftRootPath: string,
  rightRootPath: string,
): Promise<boolean> {
  try {
    const [leftEntries, rightEntries] = await Promise.all([
      collectBoundedSkillTree(leftRootPath),
      collectBoundedSkillTree(rightRootPath),
    ]);

    if (leftEntries.length !== rightEntries.length) return false;

    for (const [index, left] of leftEntries.entries()) {
      const right = rightEntries[index];

      if (
        right === undefined ||
        left.kind !== right.kind ||
        left.path !== right.path
      ) {
        return false;
      }

      if (left.kind === "directory" || right.kind === "directory") continue;

      if (
        left.size !== right.size ||
        (process.platform !== "win32" && left.mode !== right.mode)
      ) {
        return false;
      }

      const [leftBytes, rightBytes] = await Promise.all([
        fs.readFile(path.join(leftRootPath, left.path)),
        fs.readFile(path.join(rightRootPath, right.path)),
      ]);

      if (!leftBytes.equals(rightBytes)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function installConflict(skillId: string): ApiError {
  return new ApiError(
    409,
    "skill_install_conflict",
    `Skill "${skillId}" already exists with different or unsafe contents; Omnyo left it unchanged`,
  );
}

interface RegistryInstallSource {
  packageRef: string;
  registrySkillId: string;
  skillId: string;
}

interface StagedSkill {
  directory: string;
  sourcePath: string;
  manifest: RegistrySkillStage;
  expiry: ReturnType<typeof setTimeout>;
}

const STAGE_TTL_MS = 15 * 60 * 1000;

const MAX_STAGES = 4;

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inspectSkillTree(sourcePath: string, ignoreProvenance = false) {
  const entries = await collectBoundedSkillTree(sourcePath, ignoreProvenance);
  const files: RegistrySkillStage["files"] = [];
  let skillMarkdown: string | null = null;

  for (const entry of entries) {
    if (entry.kind !== "file") continue;

    const relativePath = entry.path.split(path.sep).join("/");
    const bytes = await fs.readFile(path.join(sourcePath, entry.path));
    files.push({ path: relativePath, size: bytes.length, sha256: hash(bytes) });

    if (relativePath === SKILL_FILE_NAME)
      skillMarkdown = bytes.toString("utf8");
  }

  files.sort((left, right) =>
    left.path < right.path ? -1 : Number(left.path > right.path),
  );

  const treeDigest = hash(
    Buffer.from(
      JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])),
    ),
  );

  return { files, treeDigest, skillMarkdown };
}

async function inspectInstallTarget(
  finalSkillPath: string,
  source: RegistryInstallSource,
  staged: { sourcePath: string; treeDigest: string },
): Promise<"vacant" | "identical" | "adopt" | "conflict"> {
  try {
    const existing = await fs.lstat(finalSkillPath);

    if (!existing.isDirectory() || existing.isSymbolicLink()) return "conflict";

    const owner = readRegistrySkillProvenance(finalSkillPath);

    if (owner === null) {
      return (await boundedSkillTreesMatch(staged.sourcePath, finalSkillPath))
        ? "adopt"
        : "conflict";
    }

    if (owner !== source.registrySkillId) return "conflict";

    const { treeDigest } = await inspectSkillTree(finalSkillPath, true);

    return treeDigest === staged.treeDigest ? "identical" : "conflict";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "vacant"
      : "conflict";
  }
}

function stageExpired() {
  return new ApiError(
    404,
    "registry_stage_expired",
    "Review expired. Open the skill again.",
  );
}

export function createRegistrySkillInstaller(
  dataDir: string,
  reportCleanupFailure: () => void = () => undefined,
) {
  const skillsRoot = resolveDataDirSkillsRootPath(dataDir);
  const stagingRoot = path.join(dataDir, "registry-skill-staging");
  const ready = fs.rm(stagingRoot, { recursive: true, force: true });
  void ready.catch(reportCleanupFailure);

  const stages = new Map<string, Promise<StagedSkill>>();
  const commits = new Map<string, Promise<unknown>>();
  const removals = new Map<string, Promise<void>>();

  function finalPath(skillId: string) {
    return path.join(skillsRoot, skillId);
  }

  function removeStage(
    id: string,
    pending: Promise<StagedSkill>,
  ): Promise<void> {
    if (stages.get(id) !== pending) return Promise.resolve();
    const existing = removals.get(id);

    if (existing !== undefined) return existing;

    const removal = pending
      .then(async (stage) => {
        await fs.rm(stage.directory, { recursive: true, force: true });
        clearTimeout(stage.expiry);

        if (stages.get(id) === pending) stages.delete(id);
      })
      .finally(() => removals.delete(id));

    removals.set(id, removal);

    return removal;
  }

  function stage(source: RegistryInstallSource): Promise<StagedSkill> {
    const id = source.registrySkillId;

    if (!REGISTRY_SKILL_NAME_PATTERN.test(source.skillId)) {
      throw new ApiError(
        400,
        "invalid_registry_skill",
        "Registry skill id is invalid",
      );
    }

    const pending = stages.get(id);

    if (pending !== undefined) return pending;

    if (stages.size >= MAX_STAGES) {
      throw new ApiError(
        429,
        "registry_staging_busy",
        "Four skill reviews are open. Close one and try again.",
      );
    }

    const request: Promise<StagedSkill> = (async () => {
      await ready;
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(stagingRoot, "stage-"));

      try {
        const result = await runRegistrySkillsCli({
          ...source,
          cwd: directory,
        });

        if (!result.ok) {
          throw new ApiError(
            502,
            "registry_install_failed",
            "Unable to download the skill package",
          );
        }

        const sourcePath = path.join(
          directory,
          ".agents",
          "skills",
          source.skillId,
        );

        const tree = await inspectSkillTree(sourcePath);

        if (
          tree.files.some(
            (file) => file.path === REGISTRY_SKILL_PROVENANCE_FILE_NAME,
          )
        ) {
          throw new Error("Downloaded skill contains reserved Omnyo metadata");
        }

        const license = validateSkillFile(tree.skillMarkdown, source.skillId);

        const target = await inspectInstallTarget(
          finalPath(source.skillId),
          source,
          {
            sourcePath,
            treeDigest: tree.treeDigest,
          },
        );

        const expiresAt = Date.now() + STAGE_TTL_MS;

        return {
          directory,
          sourcePath,
          expiry: setTimeout(() => {
            void (async () => {
              await commits.get(source.skillId)?.catch(() => undefined);
              await removeStage(id, request);
            })().catch(reportCleanupFailure);
          }, STAGE_TTL_MS).unref(),
          manifest: {
            registrySkillId: id,
            source: source.packageRef,
            skillId: source.skillId,
            destination: "omnyo-user",
            expiresAt,
            treeDigest: tree.treeDigest,
            files: tree.files,
            skillMarkdown: tree.skillMarkdown ?? "",
            license,
            licenseFiles: tree.files
              .map((file) => file.path)
              .filter((filePath) =>
                /^(?:licen[sc]e|copying)(?:[._-]|$)/iu.test(
                  path.posix.basename(filePath),
                ),
              ),
            conflict:
              target === "conflict"
                ? installConflict(source.skillId).message
                : null,
          },
        } satisfies StagedSkill;
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });

        if (error instanceof ApiError) throw error;
        throw new ApiError(
          422,
          "registry_skill_invalid",
          "Downloaded skill contains invalid files or exceeds the installation limits",
        );
      }
    })().catch((error: unknown) => {
      if (stages.get(id) === request) stages.delete(id);
      throw error;
    });

    stages.set(id, request);

    return request;
  }

  async function activeStage(source: RegistryInstallSource) {
    await removals.get(source.registrySkillId);
    const pending = stages.get(source.registrySkillId);

    if (
      pending !== undefined &&
      (await pending).manifest.expiresAt <= Date.now()
    ) {
      await removeStage(source.registrySkillId, pending);
    }

    return stage(source);
  }

  async function isInstalled(
    skillId: string,
    id: string,
    treeDigest: string,
  ): Promise<boolean> {
    const destination = finalPath(skillId);

    try {
      const target = await fs.lstat(destination);

      return (
        target.isDirectory() &&
        readRegistrySkillProvenance(destination) === id &&
        (await inspectSkillTree(destination, true)).treeDigest === treeDigest
      );
    } catch {
      return false;
    }
  }

  async function commitTree(source: RegistryInstallSource, treeDigest: string) {
    const id = source.registrySkillId;
    const destination = finalPath(source.skillId);

    const result = {
      filePath: path.join(destination, SKILL_FILE_NAME),
      treeDigest,
    };

    if (await isInstalled(source.skillId, id, treeDigest)) {
      const pending = stages.get(id);

      if (
        pending !== undefined &&
        (await pending).manifest.treeDigest === treeDigest
      ) {
        await removeStage(id, pending);
      }

      return result;
    }

    const staged = await activeStage(source);

    if (staged.manifest.treeDigest !== treeDigest) {
      throw new ApiError(
        409,
        "registry_skill_changed",
        "The skill files changed. Review the new files before adding.",
        {
          details: staged.manifest,
        },
      );
    }

    const pending = stages.get(id);

    const temporaryPath = path.join(
      skillsRoot,
      `.tmp-import-${source.skillId}-${randomUUID()}`,
    );

    try {
      const target = await inspectInstallTarget(destination, source, {
        sourcePath: staged.sourcePath,
        treeDigest,
      });

      if (target === "conflict") throw installConflict(source.skillId);

      if (target === "identical") return result;

      const installPath = target === "adopt" ? destination : temporaryPath;

      if (target === "vacant") {
        await fs.mkdir(skillsRoot, { recursive: true });
        await copyBoundedSkillTree({
          destinationPath: temporaryPath,
          sourcePath: staged.sourcePath,
        });

        if ((await inspectSkillTree(temporaryPath)).treeDigest !== treeDigest) {
          throw new ApiError(
            409,
            "registry_skill_changed",
            "The staged files changed. Open a new review.",
          );
        }
      }

      try {
        await writeRegistrySkillProvenance({
          registrySkillId: id,
          skillDirectoryPath: installPath,
        });
      } catch {
        throw installConflict(source.skillId);
      }

      if (target === "vacant") {
        if (
          await fs
            .lstat(destination)
            .then(() => true)
            .catch((error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return false;
              throw error;
            })
        )
          throw installConflict(source.skillId);

        try {
          await fs.rename(temporaryPath, destination);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "EEXIST" || error.code === "ENOTEMPTY")
          ) {
            throw installConflict(source.skillId);
          }

          throw error;
        }
      }

      return result;
    } finally {
      await Promise.all([
        fs.rm(temporaryPath, { recursive: true, force: true }),
        pending === undefined ? undefined : removeStage(id, pending),
      ]);
    }
  }

  function commit(source: RegistryInstallSource, treeDigest: string) {
    const previous = commits.get(source.skillId);

    const request = (previous?.catch(() => undefined) ?? Promise.resolve())
      .then(() => commitTree(source, treeDigest))
      .finally(() => {
        if (commits.get(source.skillId) === request)
          commits.delete(source.skillId);
      });

    commits.set(source.skillId, request);

    return request;
  }

  async function requireStage(id: string, treeDigest: string) {
    const pending = stages.get(id);
    const staged = await pending;

    if (
      !staged ||
      removals.has(id) ||
      staged.manifest.expiresAt <= Date.now() ||
      staged.manifest.treeDigest !== treeDigest
    )
      throw stageExpired();

    return staged;
  }

  return {
    async stage(source: RegistryInstallSource) {
      return (await activeStage(source)).manifest;
    },
    isInstalled,
    async readFile(id: string, treeDigest: string, filePath: string) {
      const staged = await requireStage(id, treeDigest);

      const file = staged.manifest.files.find(
        (entry) => entry.path === filePath,
      );

      if (file === undefined) {
        throw new ApiError(
          404,
          "registry_stage_file_not_found",
          "File is not in the review",
        );
      }

      const bytes = await fs
        .readFile(path.join(staged.sourcePath, filePath))
        .catch(() => null);

      if (bytes === null || hash(bytes) !== file.sha256) throw stageExpired();

      let contents: string;

      try {
        if (bytes.includes(0)) throw new Error("Binary file");
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ApiError(
          415,
          "registry_stage_file_binary",
          "This file has no text preview",
        );
      }

      return { path: filePath, contents };
    },
    async discard(id: string, treeDigest: string) {
      const pending = stages.get(id);

      if (!pending) return;
      const { manifest } = await pending;

      if (
        manifest.treeDigest === treeDigest &&
        !commits.has(manifest.skillId)
      ) {
        await removeStage(id, pending);
      }
    },
    commit,
    async install(source: RegistryInstallSource) {
      const manifest = (await activeStage(source)).manifest;

      return commit(source, manifest.treeDigest);
    },
  };
}

export function installServerRegistrySkill(
  args: RegistryInstallSource & { dataDir: string },
) {
  return createRegistrySkillInstaller(args.dataDir).install(args);
}
