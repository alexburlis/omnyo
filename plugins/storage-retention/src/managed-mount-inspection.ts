import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const MAX_MOUNT_BYTES = 1024 * 1024;

const MAX_MOUNT_ROWS = 20000;

const MOUNT_TIMEOUT_MS = 2000;

export type ManagedMountSnapshot =
  | { kind: "known"; mountPoints: string[] }
  | { kind: "unsupported" };

export type ManagedMountInspection = {
  recheck: "per-unlink" | "transition";
  inspect: (signal?: AbortSignal) => Promise<ManagedMountSnapshot>;
};

function mountLines(input: string) {
  if (
    input.length === 0 ||
    Buffer.byteLength(input) > MAX_MOUNT_BYTES ||
    !input.endsWith("\n") ||
    input.includes("\0")
  )
    throw new Error(
      "The native mount table is empty, oversized or incomplete.",
    );

  const lines = input.slice(0, -1).split("\n");

  if (lines.length > MAX_MOUNT_ROWS)
    throw new Error("The native mount table exceeded its row bound.");

  return lines;
}

function decodeLinuxMountPath(input: string) {
  if (/\\(?!040|011|012|134)/.test(input))
    throw new Error("The native mount path contains an unknown escape.");

  const decoded = input.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

  if (!decoded.startsWith("/") || path.posix.normalize(decoded) !== decoded)
    throw new Error("The native mount path is not an exact absolute path.");

  return decoded;
}

export function parseManagedMountInfo(input: string): string[] {
  const ids = new Set<string>();
  const points: string[] = [];

  for (const line of mountLines(input)) {
    const sections = line.split(" - ");

    if (sections.length !== 2)
      throw new Error("The Linux mount record separator is malformed.");

    const fields = sections[0]?.split(" ");
    const filesystem = sections[1]?.split(" ");

    if (
      !fields ||
      !filesystem ||
      fields.length < 6 ||
      filesystem.length !== 3 ||
      fields.some((field) => field.length === 0) ||
      filesystem.some((field) => field.length === 0) ||
      !/^\d+$/.test(fields[0] ?? "") ||
      !/^\d+$/.test(fields[1] ?? "") ||
      !/^\d+:\d+$/.test(fields[2] ?? "") ||
      ids.has(fields[0] ?? "")
    )
      throw new Error("The Linux mount record is malformed.");

    const id = fields[0];
    const root = fields[3];
    const mountPoint = fields[4];

    if (id === undefined || root === undefined || mountPoint === undefined)
      throw new Error("The Linux mount record is incomplete.");

    ids.add(id);
    decodeLinuxMountPath(root);
    points.push(decodeLinuxMountPath(mountPoint));
  }

  return points;
}

export function parseManagedDarwinMountTable(input: string): string[] {
  const points: string[] = [];

  for (const line of mountLines(input)) {
    const parts = line.split(" on ");

    if (parts.length !== 2 || !parts[0])
      throw new Error("The Darwin mount path separator is ambiguous.");

    const mounted = parts[1];
    const suffix = mounted?.indexOf(" (");

    if (
      mounted === undefined ||
      suffix === undefined ||
      suffix < 1 ||
      mounted.indexOf(" (", suffix + 2) !== -1 ||
      !mounted.endsWith(")") ||
      !/^\([^\n()]+\)$/.test(mounted.slice(suffix + 1))
    )
      throw new Error("The Darwin mount record is ambiguous or incomplete.");

    const point = mounted.slice(0, suffix);

    if (
      !point.startsWith("/") ||
      point.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(point) ||
      path.posix.normalize(point) !== point
    )
      throw new Error("The Darwin mount path encoding cannot be verified.");

    points.push(point);
  }

  return points;
}

async function readLinuxMountInfo(signal?: AbortSignal) {
  const handle = await fs.open("/proc/self/mountinfo", "r");
  const chunks: Buffer[] = [];
  const started = Date.now();
  let size = 0;

  try {
    for (;;) {
      signal?.throwIfAborted();

      if (Date.now() - started > MOUNT_TIMEOUT_MS)
        throw new Error("Native mount inspection exceeded its time bound.");

      const buffer = Buffer.allocUnsafe(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) break;

      size += bytesRead;

      if (size > MAX_MOUNT_BYTES)
        throw new Error("Native mount inspection exceeded its output bound.");

      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function inspectDarwinMounts(
  signal?: AbortSignal,
): Promise<ManagedMountSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn("/sbin/mount", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let warnings = false;
    let failure: Error | null = null;

    const stop = (message: string) => {
      failure = new Error(message);
      child.kill();
    };

    const timeout = setTimeout(
      () => stop("Native mount inspection timed out."),
      MOUNT_TIMEOUT_MS,
    );

    const abort = () => stop("Native mount inspection was cancelled.");

    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_MOUNT_BYTES)
        stop("Native mount inspection exceeded its output bound.");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) warnings = true;
    });
    child.on("error", () => {
      failure = new Error("Native mount inspection could not start.");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);

      if (failure || warnings || code !== 0) {
        reject(
          failure ??
            new Error("Native mount inspection returned warnings or failed."),
        );

        return;
      }

      try {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );

        resolve({
          kind: "known",
          mountPoints: parseManagedDarwinMountTable(output),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export const managedMountInspection: ManagedMountInspection =
  process.platform === "linux"
    ? {
        recheck: "per-unlink",
        inspect: async (signal) => ({
          kind: "known",
          mountPoints: parseManagedMountInfo(await readLinuxMountInfo(signal)),
        }),
      }
    : process.platform === "darwin"
      ? { recheck: "transition", inspect: inspectDarwinMounts }
      : {
          recheck: "transition",
          inspect: async () => ({ kind: "unsupported" }),
        };
