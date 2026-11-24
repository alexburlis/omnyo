import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const markerName = "omnyo-setup-outputs-v1";

const generatedOutputs = new Set([
  "apps/server/src/generated",
  "packages/plugin-build/src/generated",
  "packages/templates/src/generated",
]);

function setupOutputDirectories(status: string): string[] | null {
  const directories = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("!! ") || !entry.endsWith("/")) return null;

      const directory = entry.slice(3, -1);
      const parts = directory.split("/");

      if (
        parts.some(
          (part) =>
            !part || part === "." || part === ".." || /[\\:\t\r\n]/u.test(part),
        )
      )
        return null;

      return generatedOutputs.has(directory) ||
        parts.at(-1) === "node_modules" ||
        parts.at(-1) === ".turbo"
        ? directory
        : null;
    });

  if (directories.some((directory) => directory === null)) return null;

  return directories.filter((directory) => directory !== null).sort();
}

async function fingerprint(
  workspace: string,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = path.join(workspace, directory);
  const workspaceInfo = await fs.stat(workspace, { bigint: true });

  if ((await fs.realpath(root)) !== root) {
    throw new Error("Setup output has a symlink in its path");
  }

  const hash = createHash("sha256");
  const pending = [""];
  let index = 0;

  while (index < pending.length) {
    signal?.throwIfAborted();
    const batch = pending.slice(index, index + 64);
    index += batch.length;

    const rows = await Promise.all(
      batch.map(async (relative) => {
        const target = path.join(root, relative);
        const info = await fs.lstat(target, { bigint: true });

        if (
          info.dev !== workspaceInfo.dev ||
          (!relative && !info.isDirectory()) ||
          path.basename(relative) === ".git" ||
          !(info.isDirectory() || info.isFile() || info.isSymbolicLink())
        )
          throw new Error("Setup output contains an unsupported entry");

        return {
          identity: [
            relative,
            String(info.ino),
            String(info.mode),
            String(info.size),
            String(info.mtimeNs),
            String(info.ctimeNs),
          ],
          children: info.isDirectory() ? await fs.readdir(target) : [],
        };
      }),
    );

    for (const [rowIndex, row] of rows.entries()) {
      hash.update(JSON.stringify(row.identity));

      for (const child of row.children.sort()) {
        pending.push(path.join(batch[rowIndex], child));
      }
    }
  }

  return hash.digest("hex");
}

export async function setupOutputCleanup(
  workspace: string,
  gitDir: string,
  status: string,
  signal: AbortSignal | undefined,
): Promise<(() => Promise<void>) | null> {
  const directories = setupOutputDirectories(status);

  if (!directories?.length) return null;

  const marker: string | null = await fs
    .readFile(path.join(gitDir, markerName), "utf8")
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;

      throw error;
    });

  if (marker === null) return null;

  const recorded = new Map<string, string>();

  for (const line of marker.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})\t(.+)$/u.exec(line);

    if (!match || recorded.has(match[2])) return null;
    recorded.set(match[2], match[1]);
  }

  if (directories.some((directory) => !recorded.has(directory))) return null;

  return async () => {
    for (const directory of directories) {
      if (
        (await fingerprint(workspace, directory, signal)) !==
        recorded.get(directory)
      ) {
        throw new Error(
          "Setup output changed. Preserve its contents before removing the worktree",
        );
      }
    }

    for (const directory of directories) {
      signal?.throwIfAborted();
      await fs.rm(path.join(workspace, directory), { recursive: true });
    }
  };
}

async function recordSetupOutputs(workspace: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, encoding: "utf8" });

  const gitDir = git("rev-parse", "--absolute-git-dir").trim();

  const common = git(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();

  if (gitDir === common) return;

  const directories = setupOutputDirectories(
    git(
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ),
  );

  if (!directories?.length) return;

  const rows = [];

  for (const directory of directories) {
    rows.push((await fingerprint(workspace, directory)) + "\t" + directory);
  }

  await fs.writeFile(path.join(gitDir, markerName), rows.join("\n") + "\n", {
    flag: "wx",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void fs
    .realpath(process.cwd())
    .then(recordSetupOutputs)
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
