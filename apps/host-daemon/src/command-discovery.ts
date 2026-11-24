import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ExpectedCommandDispatchError } from "./command-errors.js";
import type {
  DiscoveredSkill,
  HostCommandOrigin,
  HostCommandSource,
  HostProviderCommand,
  SkillRootKind,
} from "@omnyo/host-daemon-contract";
import {
  isPathWithinDirectory,
  readMarkdownHeader,
} from "@omnyo/process-utils";

export const SKILL_FILE_NAME = "SKILL.md";

const MARKDOWN_FILE_EXTENSION = ".md";

const FRONTMATTER_DELIMITER = "---";

const MAX_SCAN_DEPTH = 24;

const MAX_SCAN_ENTRY_COUNT = 1_000;

const MIN_LINKED_SKILLS_PER_COLLECTION = 2;

interface CommandScanRootBase {
  observePath?: (filePath: string) => Promise<void>;
  namePrefix: string;
  skipIfManifest?: string;
  source: HostCommandSource;
  origin: HostCommandOrigin;
  skillIdentitySeed?: string;
}

interface CommandScanDirectoryRoot extends CommandScanRootBase {
  boundaryPath?: string;
  rootPath: string;
  shape: "skill" | "skill-recursive" | "skill-directory" | "command";
}

interface CommandScanFileRoot extends CommandScanRootBase {
  filePath: string;
  shape: "command-file";
}

interface CommandScanSkillFileRoot extends CommandScanRootBase {
  fallbackName: string;
  filePath: string;
  shape: "skill-file";
  source: "skill";
}

export type CommandScanRoot =
  | CommandScanDirectoryRoot
  | CommandScanFileRoot
  | CommandScanSkillFileRoot;

interface DiscoverProviderCommandsArgs {
  roots: readonly CommandScanRoot[];
}

interface ScanRootArgs {
  budget: ScanBudget;
  root: CommandScanRoot;
}

interface ScanBudget {
  remainingEntries: number;
}

interface SkillDirectoryCheckArgs {
  entry: Dirent;
  entryPath: string;
  root: CommandScanDirectoryRoot;
}

interface WalkMarkdownTreeArgs {
  observePath?: (filePath: string) => Promise<void>;
  budget: ScanBudget;
  currentPath: string;
  depth: number;
  matchedFiles: string[];
  matches: (entry: Dirent) => boolean;
}

type OwnedSourceSkillIdentityV1 = "absent" | "core-verification" | "invalid";

const OWNED_SOURCE_SKILL_IDENTITY_FIELD_V1 = "omnyo-source-skill-v1";

const CORE_VERIFICATION_SOURCE_IDENTITIES_V1 = new Set<unknown>([
  "example/omnyo/core-verification",
  "example/bb-private/core-verification",
]);

const CORE_VERIFICATION_SKILL_ID_SEED_V1 = "verify-bb/SKILL.md";

interface ParsedFrontmatter {
  ownedSourceIdentity: OwnedSourceSkillIdentityV1;
  name: string | null;
  description: string | null;
  argumentHint: string | null;
}

interface SkillFileMatch {
  filePath: string;
  frontmatter: ParsedFrontmatter;
  linked: boolean;
  name: string;
}

function sortDirentsByName(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

async function readDirEntries(
  dirPath: string,
  budget?: ScanBudget,
): Promise<Dirent[] | null> {
  try {
    const directory = await fs.opendir(dirPath);
    const entries: Dirent[] = [];

    for await (const entry of directory) {
      if (budget?.remainingEntries === 0) {
        break;
      }

      if (budget !== undefined) {
        budget.remainingEntries -= 1;
      }

      entries.push(entry);
    }

    return entries.sort(sortDirentsByName);
  } catch {
    return null;
  }
}

function hasSupportedFrontmatterDelimiter(content: string): boolean {
  const trimmed = content.trimStart();

  return (
    trimmed.startsWith(`${FRONTMATTER_DELIMITER}\n`) ||
    trimmed.startsWith(`${FRONTMATTER_DELIMITER}\r\n`)
  );
}

function readFrontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

async function parseFrontmatter(
  filePath: string,
  observe?: (filePath: string) => Promise<void>,
): Promise<ParsedFrontmatter> {
  if (observe) await observe(filePath);
  let content: string;

  try {
    content = await readMarkdownHeader(filePath);
  } catch {
    return {
      name: null,
      description: null,
      argumentHint: null,
      ownedSourceIdentity: "absent",
    };
  }

  if (!hasSupportedFrontmatterDelimiter(content)) {
    return {
      name: null,
      description: null,
      argumentHint: null,
      ownedSourceIdentity: "absent",
    };
  }

  let data: Record<string, unknown>;

  try {
    data = matter(content).data;
  } catch {
    const explicit =
      /^(?:omnyo-source-skill-v1|"omnyo-source-skill-v1"|'omnyo-source-skill-v1')[ \t]*:/mu.test(
        content,
      );

    return {
      name: null,
      description: null,
      argumentHint: null,
      ownedSourceIdentity: explicit ? "invalid" : "absent",
    };
  }

  const marker = data[OWNED_SOURCE_SKILL_IDENTITY_FIELD_V1];

  const ownedSourceIdentity: OwnedSourceSkillIdentityV1 = !Object.hasOwn(
    data,
    OWNED_SOURCE_SKILL_IDENTITY_FIELD_V1,
  )
    ? "absent"
    : CORE_VERIFICATION_SOURCE_IDENTITIES_V1.has(marker)
      ? "core-verification"
      : "invalid";

  return {
    ownedSourceIdentity,
    name: readFrontmatterString(data, "name"),
    description: readFrontmatterString(data, "description"),
    argumentHint: readFrontmatterString(data, "argument-hint"),
  };
}

function canFollowSkillSymlink(root: CommandScanRoot): boolean {
  return root.origin === "user" && root.source === "skill";
}

async function isSkillDirectory(
  args: SkillDirectoryCheckArgs,
): Promise<boolean> {
  if (args.entry.isDirectory()) {
    return true;
  }

  if (!args.entry.isSymbolicLink() || !canFollowSkillSymlink(args.root)) {
    return false;
  }

  try {
    const stat = await fs.stat(args.entryPath);

    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function statSkillFile(
  filePath: string,
  root: CommandScanRoot,
): Promise<{ linked: boolean } | null> {
  try {
    const stat = await fs.lstat(filePath);

    if (stat.isFile()) {
      return { linked: false };
    }

    if (!stat.isSymbolicLink() || !canFollowSkillSymlink(root)) {
      return null;
    }

    const targetStat = await fs.stat(filePath);

    return targetStat.isFile() ? { linked: true } : null;
  } catch {
    return null;
  }
}

async function isSymbolicLinkPath(filePath: string): Promise<boolean> {
  return (
    (await fs.lstat(filePath).catch(() => null))?.isSymbolicLink() ?? false
  );
}

async function buildRecord(
  args: CommandScanRoot,
  filePath: string,
  name: string,
): Promise<HostProviderCommand> {
  const frontmatter = await parseFrontmatter(filePath, args.observePath);

  return buildRecordFromFrontmatter(args, name, frontmatter);
}

function buildRecordFromFrontmatter(
  args: CommandScanRoot,
  name: string,
  frontmatter: ParsedFrontmatter,
): HostProviderCommand {
  return {
    name: `${args.namePrefix}${name}`,
    source: args.source,
    origin: args.origin,
    description: frontmatter.description,
    argumentHint: frontmatter.argumentHint,
  };
}

async function hasManifestMarker(
  root: CommandScanRootBase,
  skillDirPath: string,
): Promise<boolean> {
  if (root.skipIfManifest === undefined) {
    return false;
  }

  try {
    const manifestStat = await fs.lstat(
      path.join(skillDirPath, root.skipIfManifest),
    );

    return manifestStat.isFile();
  } catch {
    return false;
  }
}

async function observeLinkedSkillCollections(
  root: CommandScanDirectoryRoot,
  entries: readonly Dirent[],
): Promise<void> {
  if (root.observePath === undefined) {
    return;
  }

  const linkedEntries = entries.filter((entry) => entry.isSymbolicLink());
  const linkedSkillCounts = new Map<string, number>();

  for (let start = 0; start < linkedEntries.length; start += 8) {
    const collections = await Promise.all(
      linkedEntries.slice(start, start + 8).map(async (entry) => {
        const entryPath = path.join(root.rootPath, entry.name);

        if (!(await isSkillDirectory({ entry, entryPath, root }))) {
          return null;
        }

        const physicalPath = await fs.realpath(entryPath).catch(() => null);

        return physicalPath === null ? null : path.dirname(physicalPath);
      }),
    );

    for (const collection of collections) {
      if (collection !== null) {
        linkedSkillCounts.set(
          collection,
          (linkedSkillCounts.get(collection) ?? 0) + 1,
        );
      }
    }
  }

  for (const [collection, linkedSkills] of linkedSkillCounts) {
    if (linkedSkills < MIN_LINKED_SKILLS_PER_COLLECTION) {
      continue;
    }

    const collectionEntries = await readDirEntries(collection);

    if (
      collectionEntries !== null &&
      linkedSkills * 2 >= collectionEntries.length
    ) {
      await root.observePath(collection);
    }
  }
}

async function scanSkillRootFiles(
  root: CommandScanDirectoryRoot,
): Promise<SkillFileMatch[]> {
  const entries = await readDirEntries(root.rootPath);

  if (entries === null) {
    return [];
  }

  await observeLinkedSkillCollections(root, entries);

  const rootLinked = await isSymbolicLinkPath(root.rootPath);
  const matches: SkillFileMatch[] = [];

  for (let start = 0; start < entries.length; start += 8) {
    const batch = await Promise.allSettled(
      entries
        .slice(start, start + 8)
        .map(async (entry): Promise<SkillFileMatch | null> => {
          const skillDirPath = path.join(root.rootPath, entry.name);

          if (
            !(await isSkillDirectory({ entry, entryPath: skillDirPath, root }))
          ) {
            return null;
          }

          await root.observePath?.(skillDirPath);

          if (await hasManifestMarker(root, skillDirPath)) {
            return null;
          }

          const skillFilePath = path.join(skillDirPath, SKILL_FILE_NAME);
          const skillFile = await statSkillFile(skillFilePath, root);

          if (skillFile === null) {
            return null;
          }

          return {
            filePath: skillFilePath,
            frontmatter: await parseFrontmatter(
              skillFilePath,
              root.observePath,
            ),
            linked: rootLinked || entry.isSymbolicLink() || skillFile.linked,
            name: entry.name,
          };
        }),
    );

    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;

      if (result.value !== null) matches.push(result.value);
    }
  }

  return matches;
}

async function walkMarkdownTree(args: WalkMarkdownTreeArgs): Promise<void> {
  if (args.depth > MAX_SCAN_DEPTH || args.budget.remainingEntries === 0) {
    return;
  }

  await args.observePath?.(args.currentPath);
  const entries = await readDirEntries(args.currentPath, args.budget);

  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(args.currentPath, entry.name);

    if (entry.isDirectory()) {
      await walkMarkdownTree({
        observePath: args.observePath,
        budget: args.budget,
        currentPath: entryPath,
        depth: args.depth + 1,
        matchedFiles: args.matchedFiles,
        matches: args.matches,
      });
      continue;
    }

    if (entry.isFile() && args.matches(entry)) {
      args.matchedFiles.push(entryPath);
    }
  }
}

async function resolveRecursiveRootPath(
  root: CommandScanDirectoryRoot,
): Promise<string | null> {
  const resolvedRoot = await fs.realpath(root.rootPath).catch(() => null);

  if (resolvedRoot === null) {
    return null;
  }

  if (root.origin !== "project" || root.boundaryPath === undefined) {
    return resolvedRoot;
  }

  const resolvedBoundary = await fs
    .realpath(root.boundaryPath)
    .catch(() => null);

  return resolvedBoundary !== null &&
    isPathWithinDirectory(resolvedBoundary, resolvedRoot)
    ? resolvedRoot
    : null;
}

async function scanRecursiveSkillRootFiles(
  root: CommandScanDirectoryRoot,
  budget: ScanBudget,
): Promise<SkillFileMatch[]> {
  const rootPath = await resolveRecursiveRootPath(root);

  if (rootPath === null) {
    return [];
  }

  const matchedFiles: string[] = [];
  await walkMarkdownTree({
    observePath: root.observePath,
    budget,
    currentPath: rootPath,
    depth: 0,
    matchedFiles,
    matches: (entry) => entry.name === SKILL_FILE_NAME,
  });
  const linked = await isSymbolicLinkPath(root.rootPath);

  return Promise.all(
    matchedFiles.map(async (physicalFilePath) => ({
      filePath: path.join(
        root.rootPath,
        path.relative(rootPath, physicalFilePath),
      ),
      frontmatter: await parseFrontmatter(physicalFilePath, root.observePath),
      linked,
      name: path.basename(path.dirname(physicalFilePath)),
    })),
  );
}

async function scanSingleSkillDirectoryFiles(
  root: CommandScanDirectoryRoot,
): Promise<SkillFileMatch[]> {
  const skillFilePath = path.join(root.rootPath, SKILL_FILE_NAME);
  const skillFile = await statSkillFile(skillFilePath, root);

  if (skillFile === null) {
    return [];
  }

  return [
    {
      filePath: skillFilePath,
      frontmatter: await parseFrontmatter(skillFilePath, root.observePath),
      linked: (await isSymbolicLinkPath(root.rootPath)) || skillFile.linked,
      name: path.basename(root.rootPath),
    },
  ];
}

async function scanSkillFileRootFiles(
  root: CommandScanSkillFileRoot,
): Promise<SkillFileMatch[]> {
  const skillFile = await statSkillFile(root.filePath, root);

  if (skillFile === null) {
    return [];
  }

  const frontmatter = await parseFrontmatter(root.filePath, root.observePath);

  return [
    {
      filePath: root.filePath,
      frontmatter,
      linked: skillFile.linked,
      name: frontmatter.name ?? root.fallbackName,
    },
  ];
}

async function scanSkillFiles(args: ScanRootArgs): Promise<SkillFileMatch[]> {
  const { root } = args;

  switch (root.shape) {
    case "skill":
      return scanSkillRootFiles(root);
    case "skill-recursive":
      return scanRecursiveSkillRootFiles(root, args.budget);
    case "skill-directory":
      return scanSingleSkillDirectoryFiles(root);
    case "skill-file":
      return scanSkillFileRootFiles(root);
    case "command":
    case "command-file":
      return [];
  }
}

function commandNameFromPath(rootPath: string, filePath: string): string {
  const relativePath = path.relative(rootPath, filePath);

  const withoutExtension = relativePath.slice(
    0,
    relativePath.length - MARKDOWN_FILE_EXTENSION.length,
  );

  return withoutExtension.split(path.sep).join(":");
}

async function scanCommandRoot(
  args: ScanRootArgs,
): Promise<HostProviderCommand[]> {
  if (args.root.shape !== "command") {
    throw new Error("scanCommandRoot requires a command root");
  }

  const matchedFiles: string[] = [];
  await walkMarkdownTree({
    observePath: args.root.observePath,
    budget: args.budget,
    currentPath: args.root.rootPath,
    depth: 0,
    matchedFiles,
    matches: (entry) => entry.name.endsWith(MARKDOWN_FILE_EXTENSION),
  });

  const records: HostProviderCommand[] = [];

  for (const filePath of matchedFiles) {
    const name = commandNameFromPath(args.root.rootPath, filePath);
    records.push(await buildRecord(args.root, filePath, name));
  }

  return records;
}

async function scanCommandFileRoot(
  args: ScanRootArgs,
): Promise<HostProviderCommand[]> {
  if (args.root.shape !== "command-file") {
    throw new Error("scanCommandFileRoot requires a command-file root");
  }

  try {
    const stat = await fs.lstat(args.root.filePath);

    if (!stat.isFile()) {
      return [];
    }
  } catch {
    return [];
  }

  const name = path.basename(args.root.filePath, MARKDOWN_FILE_EXTENSION);

  return [await buildRecord(args.root, args.root.filePath, name)];
}

async function scanRoot(args: ScanRootArgs): Promise<HostProviderCommand[]> {
  switch (args.root.shape) {
    case "skill":
    case "skill-recursive":
    case "skill-directory":
    case "skill-file":
      return (await scanSkillFiles(args)).map((match) =>
        buildRecordFromFrontmatter(args.root, match.name, match.frontmatter),
      );
    case "command":
      return scanCommandRoot(args);
    case "command-file":
      return scanCommandFileRoot(args);
  }
}

export async function discoverProviderCommands(
  args: DiscoverProviderCommandsArgs,
): Promise<HostProviderCommand[]> {
  const records: HostProviderCommand[] = [];
  const budget = { remainingEntries: MAX_SCAN_ENTRY_COUNT };

  for (const root of args.roots) {
    records.push(...(await scanRoot({ budget, root })));
  }

  return records;
}

export type SkillScanRoot = CommandScanRoot & {
  identitySeed: string;
  rootKind: SkillRootKind;
};

interface DiscoverSkillsArgs {
  roots: readonly SkillScanRoot[];
}

function ownedSourceSkillPathV1(
  root: SkillScanRoot,
  match: SkillFileMatch,
  logicalPath: string,
): { path: string; claimed: boolean } {
  if (
    root.rootKind !== "omnyo-project" ||
    match.frontmatter.ownedSourceIdentity === "absent"
  )
    return { path: logicalPath, claimed: false };

  if (
    match.frontmatter.ownedSourceIdentity !== "core-verification" ||
    !["verify-bb/SKILL.md", "verify-omnyo/SKILL.md"].includes(logicalPath)
  )
    throw new ExpectedCommandDispatchError(
      "invalid_path",
      "Invalid owned source skill identity; the source was preserved.",
    );

  return { path: CORE_VERIFICATION_SKILL_ID_SEED_V1, claimed: true };
}

function buildSkillRecord(
  root: SkillScanRoot,
  match: SkillFileMatch,
): { record: DiscoveredSkill; ownsSourceIdentity: boolean } {
  const rootPath =
    "rootPath" in root ? root.rootPath : path.dirname(root.filePath);

  const logicalPath = path
    .relative(rootPath, match.filePath)
    .split(path.sep)
    .join("/");

  const identity = ownedSourceSkillPathV1(root, match, logicalPath);

  return {
    ownsSourceIdentity: identity.claimed,
    record: {
      id: `skill_${createHash("sha256").update(`${root.identitySeed}\0${identity.path}`).digest("hex")}`,
      name: `${root.namePrefix}${match.name}`,
      description: match.frontmatter.description,
      filePath: match.filePath,
      rootKind: root.rootKind,
      linked: match.linked,
    },
  };
}

export async function discoverSkills(
  args: DiscoverSkillsArgs,
): Promise<DiscoveredSkill[]> {
  const records: ReturnType<typeof buildSkillRecord>[] = [];
  const budget = { remainingEntries: MAX_SCAN_ENTRY_COUNT };

  for (const root of args.roots) {
    for (const match of await scanSkillFiles({ budget, root })) {
      records.push(buildSkillRecord(root, match));
    }
  }

  const uniqueRecords: DiscoveredSkill[] = [];
  const seenFiles = new Set<string>();

  const ownedIdentities = new Set(
    records
      .filter((entry) => entry.ownsSourceIdentity)
      .map((entry) => entry.record.id),
  );

  const identityFiles = new Map<string, string>();

  for (const { record } of records) {
    const canonicalFilePath = await fs
      .realpath(record.filePath)
      .catch(() => record.filePath);

    if (!seenFiles.has(canonicalFilePath)) {
      const previous = identityFiles.get(record.id);

      if (
        previous !== undefined &&
        previous !== canonicalFilePath &&
        ownedIdentities.has(record.id)
      )
        throw new ExpectedCommandDispatchError(
          "invalid_path",
          "Duplicate owned source skill identity; both sources were preserved.",
        );
      seenFiles.add(canonicalFilePath);
      identityFiles.set(record.id, canonicalFilePath);
      uniqueRecords.push(record);
    }
  }

  return uniqueRecords;
}
