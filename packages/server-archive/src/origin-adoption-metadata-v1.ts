import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { withFileLock } from "@omnyo/config/file-lock";
import { writeJsonFileAtomically } from "./json-file.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const originAdoptionRecordSchemaV1 = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    id: digest,
    selectedIds: z.array(digest).min(1).max(32),
    nonceSha256: digest,
    fromOrigin: z.literal("https://bb.alexburlis.com"),
    toOrigin: z.literal("https://app.omnyohq.com"),
    holdId: z.string().min(1),
    ownerId: z.string().min(1),
    runtimeId: z.string().min(1),
    serverHostId: z.string().min(1),
    expiresAt: z.number().int().positive(),
    phase: z.enum(["prepared", "verified", "accepted", "admitted"]),
    payloadSha256: digest.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.selectedIds.includes(value.id) &&
      new Set(value.selectedIds).size === value.selectedIds.length &&
      JSON.stringify([...value.selectedIds].sort()) ===
        JSON.stringify(value.selectedIds),
  );

export function createOriginAdoptionMetadataV1(dataDir: string) {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir)
    throw new Error("Origin adoption requires the exact private data root");
  const directory = join(dataDir, "origin-adoption-v1");
  const lockPath = join(directory, "owner.lock");
  const path = (id: string) => join(directory, `${digest.parse(id)}.json`);

  async function privateDirectory(root: string) {
    const info = await lstat(root);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      (await realpath(root)) !== root
    )
      throw new Error("Origin adoption private data owner differs");
  }

  async function assertRoot() {
    await privateDirectory(dataDir);
    await privateDirectory(directory);
  }

  return {
    async initialize() {
      await privateDirectory(dataDir);
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      });
      await assertRoot();
    },
    async locked<T>(work: () => Promise<T>) {
      await assertRoot();

      const lock = await open(
        lockPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );

      try {
        const info = await lock.stat();

        if (
          !info.isFile() ||
          (info.mode & 0o077) !== 0 ||
          info.nlink !== 1 ||
          (process.getuid !== undefined && info.uid !== process.getuid())
        )
          throw new Error("Origin adoption lock owner differs");
      } finally {
        await lock.close();
      }

      return withFileLock({ path: lockPath, timeoutMs: 1000, work });
    },
    async read(id: string) {
      await assertRoot();

      const file = await open(
        path(id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });

      if (file === null) return null;

      try {
        const info = await file.stat();

        if (
          !info.isFile() ||
          (info.mode & 0o077) !== 0 ||
          info.size > 8192 ||
          info.nlink !== 1 ||
          (process.getuid !== undefined && info.uid !== process.getuid())
        )
          throw new Error("Origin adoption record owner differs");

        const record = originAdoptionRecordSchemaV1.parse(
          JSON.parse(await file.readFile("utf8")),
        );

        if (record.id !== id)
          throw new Error("Origin adoption record path binding differs");

        return record;
      } finally {
        await file.close();
      }
    },
    async list() {
      try {
        await assertRoot();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }

      const entries = await readdir(directory);

      if (
        entries.some(
          (name) =>
            name !== "owner.lock" && !/^[a-f0-9]{64}\.json$/u.test(name),
        )
      )
        throw new Error("Origin adoption contains unresolved owned metadata");

      const ids = entries
        .filter((name) => name !== "owner.lock")
        .map((name) => name.slice(0, -5));

      if (ids.length > 32)
        throw new Error("Origin adoption exceeds its selected window bound");

      return ids;
    },
    async write(
      value: z.infer<typeof originAdoptionRecordSchemaV1>,
      exclusive = false,
    ) {
      await assertRoot();
      const record = originAdoptionRecordSchemaV1.parse(value);

      if (record.expiresAt > Date.now() + 30 * 60 * 1000 + 1000)
        throw new Error("Origin adoption expiry exceeds its bound");
      await writeJsonFileAtomically(path(record.id), record, exclusive);
    },
  };
}
