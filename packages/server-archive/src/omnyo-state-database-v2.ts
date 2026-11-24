import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hasErrorCode } from "./errors.js";

export interface ReadonlyStateRootDatabaseV2 {
  readonly: boolean;
  prepare(sql: string): { get(): unknown };
  exec(sql: string): unknown;
  close(): void;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const integer = z.number().int().nonnegative().safe();

const identitySchema = z
  .object({ device: z.string(), inode: z.string(), uid: integer })
  .strict();

const fileSchema = identitySchema
  .extend({
    gid: integer,
    mode: integer,
    size: integer.max(68_719_476_736),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
    nlink: integer.positive(),
  })
  .strict();

export const databaseVerificationProofV2Schema = z
  .object({
    version: z.literal(2),
    kind: z.enum(["capacity", "staged"]),
    binding: z
      .object({
        migrationId: z.string(),
        ownerId: z.string(),
        serverHostId: z.string(),
        sourceDataDir: z.string(),
        destinationDataDir: z.string(),
        jobDir: z.string(),
        artifactDigest: sha256,
        sourceDigest: sha256.nullable(),
        digestAlgorithm: z.enum(["legacy-tree-v1", "state-tree-v2"]),
        databaseVerification: z.literal("release-producer-v1"),
      })
      .strict(),
    root: identitySchema,
    files: z
      .object({
        database: fileSchema,
        wal: fileSchema.nullable(),
        shm: fileSchema.nullable(),
      })
      .strict(),
    integrity: z.literal("ok"),
    foreignKeys: z.literal("ok"),
    durationMs: z.number().finite().nonnegative().max(300_000),
  })
  .strict();

export type DatabaseVerificationProofV2 = z.infer<
  typeof databaseVerificationProofV2Schema
>;

export async function inspectDatabaseRootIdentityV2(path: string) {
  const info = await lstat(path, { bigint: true });

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (await realpath(path)) !== path
  )
    throw new Error("Omnyo database verification root ownership differs");

  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: Number(info.uid),
  };
}

export async function inspectDatabaseFilesV2(
  root: string,
  name: "bb.db" | "app.db",
) {
  await inspectDatabaseRootIdentityV2(root);

  const inspect = async (suffix: string) => {
    const path = join(root, name + suffix);

    const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });

    if (info === null) return null;

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(process.getuid?.() ?? -1)
    )
      throw new Error(
        "Omnyo database verification refuses a nonordinary database file",
      );

    return fileSchema.parse({
      device: info.dev.toString(),
      inode: info.ino.toString(),
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode & 0o7777n),
      size: Number(info.size),
      mtimeNs: info.mtimeNs.toString(),
      ctimeNs: info.ctimeNs.toString(),
      nlink: Number(info.nlink),
    });
  };

  const [database, wal, shm] = await Promise.all([
    inspect(""),
    inspect("-wal"),
    inspect("-shm"),
  ]);

  if (database === null)
    throw new Error(
      "Omnyo database verification requires the existing database",
    );

  return { database, wal, shm };
}

export async function readDatabaseVerificationProofV2(path: string) {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });

  if (info === null) return null;

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    info.nlink !== 1n ||
    (info.mode & 0o777n) !== 0o600n ||
    info.size > 1_048_576n ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Omnyo database proof is not a private owned ordinary file",
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const opened = await file.stat({ bigint: true });

    if (opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Omnyo database proof was replaced");
    const raw = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });

    for (const key of [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "size",
      "mtimeNs",
      "ctimeNs",
      "nlink",
    ] as const)
      if (opened[key] !== after[key] || opened[key] !== named[key])
        throw new Error("Omnyo database proof changed during validation");

    return {
      proof: databaseVerificationProofV2Schema.parse(
        JSON.parse(raw.toString("utf8")),
      ),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  } finally {
    await file.close();
  }
}

export function assertDatabaseIntegrity(
  database: Pick<ReadonlyStateRootDatabaseV2, "prepare">,
) {
  const integrity = z
    .object({ integrity_check: z.literal("ok") })
    .safeParse(database.prepare("PRAGMA integrity_check").get());

  if (
    !integrity.success ||
    database.prepare("PRAGMA foreign_key_check").get() !== undefined
  )
    throw new Error("Omnyo database full integrity verification failed");
}

export function verifyDatabaseReadonlyV2(
  path: string,
  openReadonlyDatabase: (path: string) => ReadonlyStateRootDatabaseV2,
) {
  const started = performance.now();
  const database = openReadonlyDatabase(path);

  try {
    if (database.readonly !== true)
      throw new Error(
        "Omnyo release database verifier requires its readonly connection owner",
      );
    database.exec("PRAGMA query_only = ON; BEGIN");
    assertDatabaseIntegrity(database);
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }

  return performance.now() - started;
}
