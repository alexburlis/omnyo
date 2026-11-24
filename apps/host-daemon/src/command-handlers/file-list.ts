import fs from "node:fs/promises";
import path from "node:path";
import { fuzzyMatchPaths } from "@omnyo/fuzzy-match";
import { detectGitRepo, runGit } from "@omnyo/host-workspace";
import type {
  HostPathEntry,
  HostPathEntryKind,
} from "@omnyo/host-daemon-contract";

interface FinalizeListedFilesArgs {
  filePaths: string[];
  limit: number;
  query?: string;
}

interface FinalizedFileList {
  files: FileListEntry[];
  truncated: boolean;
}

interface FileListEntry {
  path: string;
  name: string;
}

interface ListedPath {
  kind: HostPathEntryKind;
  path: string;
  name: string;
}

interface PathListInclusion {
  includeFiles: boolean;
  includeDirectories: boolean;
}

interface FinalizeListedPathsArgs extends PathListInclusion {
  paths: ListedPath[];
  limit: number;
  query?: string;
}

interface FinalizedPathList {
  paths: HostPathEntry[];
  truncated: boolean;
}

interface ListPathsRecursivelyArgs extends PathListInclusion {
  dir: string;
  root: string;
  includeHidden: boolean;
  excludeNames: ReadonlySet<string>;
  ignoredPaths: ReadonlySet<string>;
  listing: WorkspacePathListing;
  maxEntries: number;
}

interface ListWorkspacePathsArgs extends PathListInclusion {
  root: string;
  includeHidden: boolean;
  excludeNames: readonly string[];
  respectGitIgnore: boolean;
  maxEntries: number;
}

export interface WorkspacePathListing {
  paths: ListedPath[];
  truncated: boolean;
}

export const WORKSPACE_PATH_LIST_MAX_ENTRIES = 50_000;

const WORKSPACE_PATH_LISTING_REUSE_MS = 5_000;

const listings = new Map<string, Promise<WorkspacePathListing>>();

export function listWorkspacePaths(
  args: ListWorkspacePathsArgs,
): Promise<WorkspacePathListing> {
  const key = JSON.stringify([
    args.root,
    args.includeHidden,
    [...new Set(args.excludeNames)].sort(),
    args.respectGitIgnore,
    args.includeFiles,
    args.includeDirectories,
    args.maxEntries,
  ]);

  const existing = listings.get(key);

  if (existing) return existing;

  const listing = discoverWorkspacePaths(args);

  listings.set(key, listing);
  listing.then(
    () => {
      setTimeout(
        () => listings.delete(key),
        WORKSPACE_PATH_LISTING_REUSE_MS,
      ).unref();
    },
    () => listings.delete(key),
  );

  return listing;
}

async function discoverWorkspacePaths(
  args: ListWorkspacePathsArgs,
): Promise<WorkspacePathListing> {
  const ignoredPaths = new Set<string>();

  if (
    args.respectGitIgnore &&
    (await detectGitRepo(args.root, { timeoutMs: 5_000 }))
  ) {
    const result = await runGit(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      { cwd: args.root, timeoutMs: 5_000 },
    );

    for (const entry of result.stdout.split("\0")) {
      if (entry.length > 0) ignoredPaths.add(entry.replace(/\/$/, ""));
    }
  }

  const listing: WorkspacePathListing = { paths: [], truncated: false };

  await listPathsRecursively({
    dir: args.root,
    root: args.root,
    includeHidden: args.includeHidden,
    excludeNames: new Set(args.excludeNames),
    ignoredPaths,
    includeFiles: args.includeFiles,
    includeDirectories: args.includeDirectories,
    listing,
    maxEntries: args.maxEntries,
  });

  return listing;
}

const ALWAYS_EXCLUDED_NAMES: ReadonlySet<string> = new Set([".git"]);

function shouldIncludePath(
  pathKind: HostPathEntryKind,
  inclusion: PathListInclusion,
): boolean {
  return pathKind === "directory"
    ? inclusion.includeDirectories
    : inclusion.includeFiles;
}

function toFileListEntry(pathEntry: HostPathEntry): FileListEntry {
  return {
    path: pathEntry.path,
    name: pathEntry.name,
  };
}

function toListedFile(filePath: string): ListedPath {
  return {
    kind: "file",
    path: filePath,
    name: path.basename(filePath),
  };
}

export function normalizeListedPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function finalizeListedFiles(
  args: FinalizeListedFilesArgs,
): FinalizedFileList {
  const result = finalizeListedPaths({
    paths: args.filePaths.map(toListedFile),
    limit: args.limit,
    includeFiles: true,
    includeDirectories: false,
    ...(args.query ? { query: args.query } : {}),
  });

  return {
    files: result.paths.map(toFileListEntry),
    truncated: result.truncated,
  };
}

export function finalizeListedPaths(
  args: FinalizeListedPathsArgs,
): FinalizedPathList {
  let pathEntries = args.paths.filter((pathEntry) =>
    shouldIncludePath(pathEntry.kind, args),
  );

  let rankedEntries: HostPathEntry[];

  if (args.query) {
    const matches = fuzzyMatchPaths({
      items: pathEntries,
      query: args.query,
      getPath: (pathEntry) => pathEntry.path,
      limit: args.limit + 1,
    });

    rankedEntries = matches.map((match) => ({
      ...match.item,
      score: match.score,
      positions: match.positions,
    }));
  } else {
    rankedEntries = pathEntries.map((pathEntry) => ({
      ...pathEntry,
      score: 0,
      positions: [],
    }));
  }

  let truncated = false;

  if (rankedEntries.length > args.limit) {
    rankedEntries = rankedEntries.slice(0, args.limit);
    truncated = true;
  }

  return {
    paths: rankedEntries,
    truncated,
  };
}

function addListedPath(args: ListPathsRecursivelyArgs, entry: ListedPath) {
  if (args.listing.paths.length >= args.maxEntries) {
    args.listing.truncated = true;

    return;
  }

  args.listing.paths.push(entry);
}

async function listPathsRecursively(
  args: ListPathsRecursivelyArgs,
): Promise<void> {
  const entries = await fs.readdir(args.dir, { withFileTypes: true });

  for (const entry of entries) {
    if (args.listing.truncated) return;

    if (ALWAYS_EXCLUDED_NAMES.has(entry.name)) continue;

    if (args.excludeNames.has(entry.name)) continue;

    if (!args.includeHidden && entry.name.startsWith(".")) continue;

    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(args.dir, entry.name);

    const relativePath = normalizeListedPath(
      path.relative(args.root, fullPath),
    );

    if (
      args.excludeNames.has(relativePath) ||
      args.ignoredPaths.has(relativePath)
    )
      continue;

    if (entry.isDirectory()) {
      if (args.includeDirectories) {
        addListedPath(args, {
          kind: "directory",
          path: relativePath,
          name: entry.name,
        });
      }

      await listPathsRecursively({ ...args, dir: fullPath });
      continue;
    }

    if (args.includeFiles) {
      addListedPath(args, {
        kind: "file",
        path: relativePath,
        name: entry.name,
      });
    }
  }
}
