import fs from "node:fs/promises";
import path from "node:path";
import { detectGitRepo, runGit } from "@omnyo/host-workspace";

const ICON_NAME = /^(?:icon|favicon|app-icon|appicon)\.(?:png|svg|ico)$/iu;

const ICON_PATHS = ["icon", "favicon", "app-icon", "appicon"].flatMap((stem) =>
  ["png", "svg", "ico"].map((ext) => `:(glob,icase)**/${stem}.${ext}`),
);

const MAX_DIRECTORIES = 256;

const MAX_ENTRIES_PER_DIRECTORY = 256;

const MAX_DEPTH = 6;

export async function discoverProjectIcons(args: {
  root: string;
  excludeNames: readonly string[];
  limit: number;
}) {
  const files: { path: string; name: string }[] = [];
  const queue = [{ directory: args.root, depth: 0, repositoryOnly: false }];
  let truncated = false;
  const excluded = new Set([".git", ...args.excludeNames]);

  const add = async (relative: string) => {
    const segments = relative.split("/");
    const name = segments.at(-1) ?? "";

    if (
      segments.some(
        (segment, index) =>
          segment.startsWith(".") ||
          excluded.has(segment) ||
          excluded.has(segments.slice(0, index + 1).join("/")),
      )
    )
      return;

    if (!ICON_NAME.test(name)) return;

    const entry = await fs
      .lstat(path.join(args.root, relative))
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });

    if (entry === null || !entry.isFile()) return;

    if (files.length >= args.limit) truncated = true;
    else files.push({ path: relative, name });
  };

  for (
    let index = 0;
    index < queue.length && index < MAX_DIRECTORIES;
    index += 1
  ) {
    const current = queue[index];

    if (current === undefined) break;

    const gitEntry = await fs
      .lstat(path.join(current.directory, ".git"))
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });

    const isRepository =
      gitEntry !== null &&
      (await detectGitRepo(current.directory, { timeoutMs: 5000 }));

    if (current.repositoryOnly && !isRepository) continue;

    if (isRepository) {
      const result = await runGit(
        ["ls-files", "--cached", "-z", "--", ...ICON_PATHS],
        {
          cwd: current.directory,
          timeoutMs: 5000,
          maxBufferBytes: 256 * 1024,
        },
      );

      for (const name of result.stdout.split("\0")) {
        if (name !== "")
          await add(
            path
              .relative(args.root, path.join(current.directory, name))
              .split(path.sep)
              .join("/"),
          );
      }

      if (result.stdout.length > 0) continue;
    }

    const dir = await fs.opendir(current.directory);
    let entries = 0;

    for await (const entry of dir) {
      entries += 1;

      if (entries > MAX_ENTRIES_PER_DIRECTORY) {
        truncated = true;
        break;
      }

      if (
        entry.name.startsWith(".") ||
        excluded.has(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const full = path.join(current.directory, entry.name);
      const relative = path.relative(args.root, full).split(path.sep).join("/");

      if (excluded.has(relative)) continue;

      if (entry.isFile() && !isRepository) await add(relative);
      else if (entry.isDirectory()) {
        if (current.depth >= MAX_DEPTH || queue.length >= MAX_DIRECTORIES)
          truncated = true;
        else
          queue.push({
            directory: full,
            depth: current.depth + 1,
            repositoryOnly: isRepository,
          });
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, truncated };
}
