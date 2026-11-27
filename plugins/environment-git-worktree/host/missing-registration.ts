import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_inspectDirectoryProcesses } from "@omnyo/plugin-sdk/host";
import { getGitCommonDir, runGit } from "omnyo-environment-provider-host/git";
import { withWorktreeMetadataLock } from "omnyo-environment-provider-host/locks";
import {
  findWorktreeEntry,
  parseWorktreeListPorcelain,
} from "./worktree-list.js";

export type MissingRegistrationInput = {
  sourcePath: string;
  path: string;
  ref: string;
};

type FileIdentity = Awaited<ReturnType<typeof fileIdentity>>;

function fileIdentity(file: string) {
  return fs.lstat(file, { bigint: true });
}

function sameFile(a: FileIdentity, b: FileIdentity) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function requireMissing(file: string) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }

  throw new Error("Git registration exists. Use normal worktree cleanup.");
}

async function assertNoLinuxMounts(directory: string) {
  if (process.platform !== "linux") return;
  const table = await fs.readFile("/proc/self/mountinfo", "utf8");

  if (!table.endsWith("\n"))
    throw new Error("The Linux mount table is incomplete.");

  for (const row of table.trimEnd().split("\n")) {
    const encoded = row.split(" ")[4];

    if (!encoded || /\\(?!040|011|012|134)/u.test(encoded))
      throw new Error("Cannot verify the Linux mount table.");

    const mount = encoded.replace(/\\(040|011|012|134)/gu, (_, value: string) =>
      String.fromCharCode(Number.parseInt(value, 8)),
    );

    if (mount === directory || mount.startsWith(`${directory}/`))
      throw new Error("The worktree contains a mounted filesystem.");
  }
}

async function readRegularFile(
  file: string,
  identity: FileIdentity,
  consume: (chunk: Buffer) => void,
) {
  if (
    !identity.isFile() ||
    identity.nlink !== 1n ||
    identity.size > 128n * 1024n * 1024n
  ) {
    throw new Error(`Cannot safely verify file ${file}`);
  }

  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    if (!sameFile(identity, await handle.stat({ bigint: true })))
      throw new Error("A worktree file changed during verification.");

    const buffer = Buffer.alloc(
      Math.min(Number(identity.size) + 1, 128 * 1024),
    );

    let length = 0;

    while (length <= Number(identity.size)) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(identity.size) + 1 - length),
        length,
      );

      if (bytesRead === 0) break;
      length += bytesRead;
      consume(buffer.subarray(0, bytesRead));
    }

    if (
      BigInt(length) !== identity.size ||
      !sameFile(identity, await fileIdentity(file))
    ) {
      throw new Error("A worktree file changed during verification.");
    }
  } finally {
    await handle.close();
  }
}

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

async function verifyMissingRegistration(
  input: MissingRegistrationInput,
  signal: AbortSignal,
) {
  const root = await fileIdentity(input.path);

  if (
    !root.isDirectory() ||
    root.dev !== (await fileIdentity(path.dirname(input.path))).dev ||
    (await fs.realpath(input.path)) !== input.path
  ) {
    throw new Error(
      "The worktree path is not a physical directory at its recorded location.",
    );
  }

  await assertNoLinuxMounts(input.path);

  const source = await fs.realpath(input.sourcePath);

  const git = async (...args: string[]) =>
    (
      await runGit(["--no-optional-locks", "--no-replace-objects", ...args], {
        cwd: source,
        signal,
        timeoutMs: 15_000,
        env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout;

  const commonDir = await fs.realpath(
    (
      await git("rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim(),
  );

  if (
    [source, commonDir].some(
      (directory) =>
        directory === input.path ||
        directory.startsWith(`${input.path}${path.sep}`),
    )
  ) {
    throw new Error(
      "The project repository or Git store is inside the worktree.",
    );
  }

  const pointerPath = path.join(input.path, ".git");
  const pointerIdentity = await fileIdentity(pointerPath);

  if (pointerIdentity.size > 4096n)
    throw new Error("Invalid Git pointer size.");

  const chunks: Buffer[] = [];
  await readRegularFile(pointerPath, pointerIdentity, (chunk) =>
    chunks.push(Buffer.from(chunk)),
  );
  const pointer = Buffer.concat(chunks).toString("utf8");

  const match = /^gitdir: ([^\u0000\r\n]+)\r?\n?$/u.exec(pointer);

  if (!match || match[1].includes("\uFFFD"))
    throw new Error("The folder has no supported linked Git pointer.");
  const registration = path.resolve(input.path, match[1]);

  if (path.dirname(registration) !== path.join(commonDir, "worktrees")) {
    throw new Error(
      "The Git pointer does not belong to the selected project repository.",
    );
  }

  await requireMissing(registration);

  if (
    findWorktreeEntry(
      parseWorktreeListPorcelain(await git("worktree", "list", "--porcelain")),
      input.path,
    )
  ) {
    throw new Error(
      "Git still registers this path. Use normal worktree cleanup.",
    );
  }

  if (!/^refs\/(heads|remotes|tags)\//u.test(input.ref))
    throw new Error("Provide a full retained branch or tag ref.");
  await git("check-ref-format", input.ref);
  await git("show-ref", "--verify", input.ref);

  const retainedHead = async () =>
    (
      await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.ref}^{commit}`,
      )
    ).trim();

  const head = await retainedHead();

  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head))
    throw new Error("Invalid retained commit.");

  const expected = new Map<string, { mode: string; blob: string }>();
  const directories = new Set<string>();

  for (const record of (await git("ls-tree", "-r", "-z", head))
    .split("\0")
    .filter(Boolean)) {
    const entry = /^(10064[4]|100755) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(
      record,
    );

    if (
      !entry ||
      entry[2].length !== head.length ||
      entry[3].includes("\uFFFD") ||
      entry[3]
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git",
        )
    ) {
      throw new Error(
        "The retained commit contains an unsupported tree entry.",
      );
    }

    expected.set(entry[3], { mode: entry[1], blob: entry[2] });

    for (
      let dir = path.posix.dirname(entry[3]);
      dir !== ".";
      dir = path.posix.dirname(dir)
    )
      directories.add(dir);
  }

  if (!expected.size)
    throw new Error("The retained commit has no files to verify.");
  const fileCount = expected.size;
  let bytes = 0;
  const observedDirectories = new Map<string, FileIdentity>();
  const observedFiles = new Map<string, FileIdentity>();
  const files: { file: string; mode: string; blob: string }[] = [];

  async function compare(dir: string, prefix: string) {
    const before = await fileIdentity(dir);

    if (!before.isDirectory() || before.dev !== root.dev)
      throw new Error("The worktree contains a non-local directory.");

    for (const name of await fs.readdir(dir)) {
      signal.throwIfAborted();
      const relative = prefix + name;

      if (relative === ".git") continue;
      const file = path.join(dir, name);

      if (directories.delete(relative)) {
        await compare(file, `${relative}/`);
        continue;
      }

      const entry = expected.get(relative);

      if (!entry) throw new Error(`Extra worktree entry: ${relative}`);
      files.push({ file, ...entry });
      expected.delete(relative);
    }

    if (!sameFile(before, await fileIdentity(dir)))
      throw new Error("A worktree directory changed during verification.");

    observedDirectories.set(dir, before);
  }

  await compare(input.path, "");

  if (expected.size || directories.size)
    throw new Error("The worktree is missing files from the retained commit.");

  await verifyInParallel(files, async ({ file, mode, blob }) => {
    signal.throwIfAborted();
    const identity = await fileIdentity(file);
    const actualMode = (identity.mode & 0o100n) === 0n ? "100644" : "100755";

    const hash = createHash(head.length === 40 ? "sha1" : "sha256").update(
      `blob ${identity.size}\0`,
    );

    await readRegularFile(file, identity, (chunk) => hash.update(chunk));

    if (
      identity.dev !== root.dev ||
      actualMode !== mode ||
      hash.digest("hex") !== blob
    ) {
      throw new Error(
        `Worktree file differs from the retained commit: ${path.relative(input.path, file)}`,
      );
    }

    observedFiles.set(file, identity);
    bytes += Number(identity.size);
  });

  const consumers = await experimental_inspectDirectoryProcesses(
    input.path,
    signal,
    { timeoutMs: 30_000 },
  );

  if (consumers.kind !== "idle") throw new Error(consumers.message);
  await requireMissing(registration);

  const observed = [...observedFiles, ...observedDirectories];
  await verifyInParallel(observed, async ([file, identity]) => {
    signal.throwIfAborted();

    if (!sameFile(identity, await fileIdentity(file)))
      throw new Error("The worktree changed during verification.");
  });

  if (
    head !== (await retainedHead()) ||
    !sameFile(root, await fileIdentity(input.path)) ||
    !sameFile(pointerIdentity, await fileIdentity(pointerPath))
  ) {
    throw new Error(
      "The worktree, Git pointer or retained ref changed during verification.",
    );
  }

  const proof = {
    head,
    fileCount,
    bytes,
    identity: `${root.dev}:${root.ino}`,
    registration,
  };

  return { proof, commonDir, observed, pointerPath, pointerIdentity };
}

export async function inspectMissingRegistration(
  input: MissingRegistrationInput,
  signal: AbortSignal,
) {
  return (await verifyMissingRegistration(input, signal)).proof;
}

export type MissingRegistrationProof = Pick<
  Awaited<ReturnType<typeof inspectMissingRegistration>>,
  "head" | "identity" | "registration"
>;

export async function removeMissingRegistration(
  input: MissingRegistrationInput,
  expected: MissingRegistrationProof,
  signal: AbortSignal,
) {
  const commonDir = await fs.realpath(
    await getGitCommonDir(input.sourcePath, { signal }),
  );

  await withWorktreeMetadataLock(
    commonDir,
    async () => {
      const {
        proof,
        commonDir: actualCommonDir,
        observed,
        pointerPath,
        pointerIdentity,
      } = await verifyMissingRegistration(input, signal);

      if (
        proof.head !== expected.head ||
        proof.identity !== expected.identity ||
        proof.registration !== expected.registration ||
        actualCommonDir !== commonDir
      ) {
        throw new Error(
          "The worktree or retained ref changed. Review it again.",
        );
      }

      await assertNoLinuxMounts(input.path);
      signal.throwIfAborted();

      for (const [file, identity] of observed) {
        if (file === input.path) continue;
        const current = await fileIdentity(file);
        const parent = path.dirname(file);

        if (
          (await fs.realpath(parent)) !== parent ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.mode !== identity.mode
        )
          throw new Error("The worktree changed during removal.");

        if (identity.isDirectory()) await fs.rmdir(file);
        else {
          if (!sameFile(identity, current))
            throw new Error("A reviewed worktree file changed during removal.");
          await fs.unlink(file);
        }
      }

      const remaining = await fs.readdir(input.path);

      if (
        (await fs.realpath(input.path)) !== input.path ||
        remaining.length !== 1 ||
        remaining[0] !== ".git" ||
        !sameFile(pointerIdentity, await fileIdentity(pointerPath))
      )
        throw new Error(
          "The worktree contains new files or its Git pointer changed during removal.",
        );

      await fs.unlink(pointerPath);
      await fs.rmdir(input.path);
    },
    signal,
  );
}
