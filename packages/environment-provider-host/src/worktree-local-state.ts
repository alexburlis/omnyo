import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const WORKTREE_PRIVATE_REF_NAMESPACES = [
  "refs/worktree/",
  "refs/bisect/",
  "refs/rewritten/",
] as const;

export const WORKTREE_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "AUTO_MERGE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_START",
  "BISECT_LOG",
  "BISECT_HEAD",
  "BISECT_EXPECTED_REV",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

export const WORKTREE_INDEX_LISTING_MAX_BYTES = 256 * 1024 * 1024;

const HASH_OBJECT_ARGUMENT_CHARS = 8_000;

export async function verifyInParallel<T>(
  entries: readonly T[],
  verify: (entry: T) => Promise<void>,
) {
  let next = 0;
  let failure: { error: unknown } | undefined;

  async function worker() {
    while (!failure && next < entries.length) {
      try {
        await verify(entries[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, worker),
  );

  if (failure) throw failure.error;
}

function gitBlobHash(blob: string, content: Buffer): string {
  return createHash(blob.length === 40 ? "sha1" : "sha256")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

async function rawFileBlobHash(
  file: string,
  size: number,
  blob: string,
): Promise<string | null> {
  const hash = createHash(blob.length === 40 ? "sha1" : "sha256").update(
    `blob ${size}\0`,
  );

  let length = 0;

  for await (const chunk of createReadStream(file)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    length += bytes.length;
  }

  return length === size ? hash.digest("hex") : null;
}

function lstatIfPresent(file: string): Promise<Stats | null> {
  return fs.lstat(file).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  });
}

export async function findUnreportedChanges(
  workspacePath: string,
  git: (args: string[]) => Promise<string>,
  throwIfAborted: () => void = () => {},
): Promise<{ hidden: string[]; submodules: string[] }> {
  const listing = await git(["ls-files", "-s", "-v", "-z"]);

  const entries = listing.split("\0").flatMap((entry) => {
    const tab = entry.indexOf("\t");

    if (tab < 0) return [];
    const [tag = "", mode = "", blob = ""] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    const submodule = mode === "160000";

    return submodule || /^[a-zS]$/u.test(tag)
      ? [{ file, mode, blob, submodule }]
      : [];
  });

  const hidden = new Set<string>();
  const submodules = new Set<string>();

  const regular: { file: string; blob: string }[] = [];

  await verifyInParallel(entries, async ({ file, mode, blob, submodule }) => {
    throwIfAborted();

    if (file.includes("�")) {
      (submodule ? submodules : hidden).add(file);

      return;
    }

    const absolute = path.join(workspacePath, file);
    const stat = await lstatIfPresent(absolute);

    if (stat === null) return;

    if (submodule) {
      const names = stat.isDirectory() ? await fs.readdir(absolute) : null;

      if (names === null || (names.length > 0 && !names.includes(".git")))
        submodules.add(file);
    } else if (mode === "120000" && (stat.isSymbolicLink() || stat.isFile())) {
      const target = stat.isSymbolicLink()
        ? await fs.readlink(absolute, { encoding: "buffer" })
        : await fs.readFile(absolute);

      const portable =
        stat.isSymbolicLink() && process.platform === "win32"
          ? Buffer.from(target.toString("utf8").replaceAll("\\", "/"))
          : target;

      if (gitBlobHash(blob, portable) !== blob) hidden.add(file);
    } else if ((mode === "100644" || mode === "100755") && stat.isFile()) {
      if ((await rawFileBlobHash(absolute, stat.size, blob)) !== blob)
        regular.push({ file, blob });
    } else {
      hidden.add(file);
    }
  });

  const batches: (typeof regular)[] = [];
  let chars = 0;
  regular.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  for (const entry of regular) {
    const batch = batches.at(-1);

    if (batch && chars + entry.file.length <= HASH_OBJECT_ARGUMENT_CHARS) {
      batch.push(entry);
      chars += entry.file.length + 1;
    } else {
      batches.push([entry]);
      chars = entry.file.length + 1;
    }
  }

  for (const batch of batches) {
    const hashes = (
      await git(["hash-object", "--", ...batch.map(({ file }) => file)])
    ).split("\n");

    batch.forEach(({ file, blob }, index) => {
      if (hashes[index] !== blob) hidden.add(file);
    });
  }

  return { hidden: [...hidden].sort(), submodules: [...submodules].sort() };
}
