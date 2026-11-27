import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { withProcessLocalQueuedLocks } from "omnyo-environment-provider-host/process-local-lock";
import payload from "./share-helper-payload.json";

const exec = promisify(execFile);

const counts = z
  .object({
    sharedFiles: z.number().int().nonnegative().safe(),
    privateBytesReleased: z.number().int().nonnegative().safe(),
    skippedFiles: z.number().int().nonnegative().safe(),
  })
  .strict();

export type ShareCounts = z.infer<typeof counts>;

export type FilePair = readonly [string, string];

export type Helper = { executable: string; staging: string };

async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const st = await lstat(dir);

  if (
    !st.isDirectory() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Worktree sharing requires an owner-private helper directory.",
    );
  }
}

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export async function loadHelper(dataDir: string): Promise<Helper> {
  await mkdir(dataDir, { recursive: true });
  const dir = path.join(await realpath(dataDir), "apfs-sharing");
  await privateDirectory(dir);
  const staging = path.join(dir, "staging");
  await privateDirectory(staging);
  const executable = path.join(dir, "worktree-share-" + payload.sha256);

  const existing = await lstat(executable).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;

      return null;
    },
  );

  if (!existing) {
    const bytes = gunzipSync(Buffer.from(payload.gzipBase64, "base64"));

    if (digest(bytes) !== payload.sha256)
      throw new Error("The bundled worktree helper failed verification.");
    const temp = path.join(dir, randomUUID());
    const fd = await open(temp, "wx", 0o700);

    try {
      await fd.writeFile(bytes);
      await fd.chmod(0o500);
      await fd.close();
      await link(temp, executable).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await fd.close();
      await unlink(temp);
    }
  }

  const fd = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const st = await fd.stat();

    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o500 ||
      digest(await readFile(fd)) !== payload.sha256
    ) {
      throw new Error("The installed worktree helper failed verification.");
    }
  } finally {
    await fd.close();
  }

  return { executable, staging };
}

export async function supportsSharing(
  helper: Helper,
  dir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await exec(helper.executable, ["--probe", dir], {
      signal,
      maxBuffer: 4096,
    });

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 2)
      return false;
    throw error;
  }
}

export class UnsupportedSharing extends Error {}

export function sharePairs(
  helper: Helper,
  pairs: AsyncIterable<FilePair>,
  signal?: AbortSignal,
): Promise<ShareCounts> {
  return withProcessLocalQueuedLocks({
    locks: [{ key: helper.staging }],
    signal,
    work: () => applyPairs(helper, pairs, signal),
  });
}

async function applyPairs(
  helper: Helper,
  pairs: AsyncIterable<FilePair>,
  signal?: AbortSignal,
): Promise<ShareCounts> {
  signal?.throwIfAborted();

  const child = spawn(helper.executable, [helper.staging], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stop = () => {
    child.kill("SIGTERM");
  };

  signal?.addEventListener("abort", stop, { once: true });
  let output = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output = (output + chunk).slice(-8192);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-4096);
  });

  async function* encode() {
    for await (const [donor, target] of pairs) {
      if (signal?.aborted) return;
      yield Buffer.from(donor + "\0" + target + "\0");
    }
  }

  try {
    const closed = once(child, "close");

    const sent = pipeline(Readable.from(encode()), child.stdin).catch(
      (error: NodeJS.ErrnoException) => {
        stop();

        if (
          error.code !== "EPIPE" &&
          error.code !== "ERR_STREAM_PREMATURE_CLOSE" &&
          !signal?.aborted
        )
          throw error;
      },
    );

    const [exit, input] = await Promise.allSettled([closed, sent]);

    if (exit.status === "rejected") throw exit.reason;

    if (input.status === "rejected") throw input.reason;

    if (exit.value[0] === 2)
      throw new UnsupportedSharing(
        "This volume lacks the APFS busy-file protection required for sharing.",
      );

    if (exit.value[0] !== 0)
      throw new Error(
        diagnostic.trim() ||
          "The APFS sharing operation stopped before settling.",
      );

    return counts.parse(JSON.parse(output));
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
