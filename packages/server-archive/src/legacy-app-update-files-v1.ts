import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  APP_UPDATE_STATE_FILE_NAME,
  APP_UPDATE_SHIM_LOCK_FILE_NAME,
  appUpdateStateSchema,
  appUpdateShimLockFileSchema,
  LEGACY_APP_UPDATE_STATE_FILE_V1,
  LEGACY_APP_UPDATE_SHIM_FILE_V1,
} from "@omnyo/config/app-update";
import { withFileLock } from "@omnyo/config/file-lock";
import { isProcessRunning } from "@omnyo/config/verified-process-stop";
import { hasErrorCode } from "./errors.js";
import {
  readPrivateJsonFileText,
  writeJsonFileAtomically,
} from "./json-file.js";
import { runWindowsStateOwnerProcess } from "./windows-state-process.js";

const pairs = [
  {
    legacy: LEGACY_APP_UPDATE_STATE_FILE_V1,
    current: APP_UPDATE_STATE_FILE_NAME,
    kind: "state",
  },
  {
    legacy: LEGACY_APP_UPDATE_SHIM_FILE_V1,
    current: APP_UPDATE_SHIM_LOCK_FILE_NAME,
    kind: "shim",
  },
  {
    legacy: `.${LEGACY_APP_UPDATE_STATE_FILE_V1}.lock`,
    current: `.${APP_UPDATE_STATE_FILE_NAME}.lock`,
    kind: "lock",
  },
  {
    legacy: `.${LEGACY_APP_UPDATE_STATE_FILE_V1}.tmp`,
    current: `.${APP_UPDATE_STATE_FILE_NAME}.tmp`,
    kind: "temporary",
  },
] as const;

const absolutePathSchema = z
  .string()
  .refine((value) => isAbsolute(value) && resolve(value) === value);

const bindingSchema = z
  .object({
    migrationId: z.string().min(1),
    sourceDataDir: absolutePathSchema,
    destinationDataDir: absolutePathSchema,
    dataDir: absolutePathSchema,
    jobDir: absolutePathSchema,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const identitySchema = z
  .object({
    device: z.string(),
    inode: z.string(),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const journalSchema = z
  .object({
    version: z.literal(1),
    binding: bindingSchema,
    directory: z.object({ device: z.string(), inode: z.string() }).strict(),
    files: z
      .array(
        z
          .object({
            legacy: z.string(),
            current: z.string(),
            identity: identitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(pairs.length),
    phase: z.enum(["prepared", "complete"]),
  })
  .strict();

type Identity = z.infer<typeof identitySchema>;

export type LegacyAppUpdateAdoptionV1 = z.infer<typeof bindingSchema>;

async function capture(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });

  if (file === null) return null;

  try {
    const info = await file.stat({ bigint: true });
    const pathInfo = await lstat(path, { bigint: true });

    if (
      !info.isFile() ||
      pathInfo.isSymbolicLink() ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino ||
      info.size > 8n * 1024n * 1024n ||
      (process.getuid !== undefined && info.uid !== BigInt(process.getuid()))
    )
      throw new Error(
        "Updater migration requires a bounded ordinary owned file",
      );
    const raw = await file.readFile();
    const current = await file.stat({ bigint: true });

    if (current.mtimeNs !== info.mtimeNs || current.size !== info.size)
      throw new Error("Updater migration input changed while being read");

    return {
      raw,
      identity: {
        device: info.dev.toString(),
        inode: info.ino.toString(),
        size: Number(info.size),
        mode: Number(info.mode & 0o777n),
        digest: createHash("sha256").update(raw).digest("hex"),
      },
    };
  } finally {
    await file.close();
  }
}

function same(
  actual: Awaited<ReturnType<typeof capture>>,
  expected: Identity,
): boolean {
  return (
    actual !== null &&
    JSON.stringify(actual.identity) === JSON.stringify(expected)
  );
}

async function readPairs(dataDir: string) {
  return Promise.all(
    pairs.map(async (pair) => {
      const [legacy, current] = await Promise.all([
        capture(join(dataDir, pair.legacy)),
        capture(join(dataDir, pair.current)),
      ]);

      return { ...pair, legacyFile: legacy, currentFile: current };
    }),
  );
}

function validatePairValues(
  records: Awaited<ReturnType<typeof readPairs>>,
): void {
  for (const record of records) {
    const file = record.legacyFile ?? record.currentFile;

    if (file === null) continue;

    if (
      (record.kind === "state" || record.kind === "shim") &&
      !Buffer.from(file.raw.toString("utf8"), "utf8").equals(file.raw)
    )
      throw new Error(
        "Saved updater JSON is not UTF-8; preserve it before migration",
      );

    if (record.kind === "state") {
      let value: unknown;

      try {
        value = JSON.parse(file.raw.toString("utf8"));
      } catch {
        throw new Error(
          "Saved updater state is invalid; preserve it before migration",
        );
      }

      if (!appUpdateStateSchema.safeParse(value).success)
        throw new Error(
          "Saved updater state is incompatible; preserve it before migration",
        );
    } else if (record.kind === "shim") {
      let value: unknown;

      try {
        value = JSON.parse(file.raw.toString("utf8"));
      } catch {
        throw new Error(
          "Saved updater shim owner is invalid; preserve it before migration",
        );
      }

      const parsed = appUpdateShimLockFileSchema.safeParse(value);

      if (!parsed.success || isProcessRunning(parsed.data.pid))
        throw new Error(
          "Updater migration requires its original shim owner to be stopped",
        );
    }
  }

  const state = records.find((record) => record.kind === "state");
  const temporary = records.find((record) => record.kind === "temporary");
  const committed = state?.legacyFile ?? state?.currentFile;
  const pending = temporary?.legacyFile ?? temporary?.currentFile;

  if (pending && (!committed || !pending.raw.equals(committed.raw)))
    throw new Error(
      "Uncommitted updater state differs; preserve both files and reconcile through the original updater owner before migration",
    );
}

export async function assertLegacyAppUpdateOwnerStoppedV1(
  dataDir: string,
): Promise<void> {
  const records = await readPairs(dataDir);

  if (
    records.some((record) => record.legacyFile !== null) &&
    records.some((record) => record.currentFile !== null)
  )
    throw new Error(
      "Updater namespace collision; preserve both files before migration",
    );
  validatePairValues(records);
  const lock = records.find((record) => record.kind === "lock");
  const file = lock?.legacyFile ?? lock?.currentFile;

  if (lock !== undefined && file !== undefined && file !== null) {
    const name = lock.legacyFile !== null ? lock.legacy : lock.current;
    await withFileLock({
      path: join(dataDir, name),
      existingOnly: true,
      identity: { device: file.identity.device, inode: file.identity.inode },
      timeoutMs: 1,
      work: async () => undefined,
    });
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(path, "r");

  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function moveExclusive(
  source: string,
  destination: string,
): Promise<void> {
  if (process.platform === "win32") {
    await runWindowsStateOwnerProcess({
      ownerKey: `updater:${source}`,
      inputName: "OMNYO_UPDATER_MOVE_V1",
      input: { source, destination },
      timeoutMs: 15_000,
      script: String.raw`
$a=$env:OMNYO_UPDATER_MOVE_V1|ConvertFrom-Json
$s=Get-Item -LiteralPath $a.source -Force
if($s.PSIsContainer -or ($s.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Updater source is not an ordinary file'}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmnyoUpdaterMoveV1 {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool MoveFileEx(string source,string destination,uint flags);}'
if(![OmnyoUpdaterMoveV1]::MoveFileEx($a.source,$a.destination,8)){throw ('Exclusive updater move refused: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
`,
    });

    return;
  }

  await link(source, destination);
  await syncDirectory(dirname(source));
  await unlink(source);
  await syncDirectory(dirname(source));
}

export async function adoptLegacyAppUpdateFilesV1(
  value: LegacyAppUpdateAdoptionV1,
): Promise<void> {
  const args = bindingSchema.parse(value);

  const [stage, job, stagePath, jobPath] = await Promise.all([
    lstat(args.dataDir, { bigint: true }),
    lstat(args.jobDir),
    realpath(args.dataDir),
    realpath(args.jobDir),
  ]);

  const suffix = relative(args.jobDir, args.dataDir);

  if (
    !stage.isDirectory() ||
    stage.isSymbolicLink() ||
    !job.isDirectory() ||
    job.isSymbolicLink() ||
    (process.getuid !== undefined &&
      (job.uid !== process.getuid() || (job.mode & 0o077) !== 0)) ||
    !suffix ||
    suffix === ".." ||
    suffix.startsWith("../") ||
    suffix.startsWith("..\\") ||
    isAbsolute(suffix) ||
    stagePath !== args.dataDir ||
    jobPath !== args.jobDir ||
    args.sourceDataDir === args.dataDir ||
    args.destinationDataDir === args.dataDir
  )
    throw new Error(
      "Updater conversion requires its exact protected staging owner",
    );

  const directory = {
    device: stage.dev.toString(),
    inode: stage.ino.toString(),
  };

  const journalPath = join(args.jobDir, "legacy-app-update-files-v1.json");

  await withFileLock({
    path: join(args.jobDir, "updater-identity-v1.lock"),
    timeoutMs: 5000,
    work: async () => {
      const journalInfo = await lstat(journalPath).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      });

      if (journalInfo !== null && journalInfo.size > 65536)
        throw new Error(
          "Updater identity journal exceeds its finite record bound",
        );
      const raw = await readPrivateJsonFileText(journalPath);
      let journal: z.infer<typeof journalSchema>;

      if (raw === null) {
        const records = await readPairs(args.dataDir);

        if (
          records.some((record) => record.legacyFile !== null) &&
          records.some((record) => record.currentFile !== null)
        )
          throw new Error(
            "Updater namespace collision; preserve both files before migration",
          );
        validatePairValues(records);

        const files = records.flatMap((record) =>
          record.legacyFile === null
            ? []
            : [
                {
                  legacy: record.legacy,
                  current: record.current,
                  identity: record.legacyFile.identity,
                },
              ],
        );

        if (files.length === 0) return;
        journal = {
          version: 1,
          binding: args,
          directory,
          files,
          phase: "prepared",
        };
        await writeJsonFileAtomically(journalPath, journal, true);
      } else {
        let parsed: unknown;

        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("Updater identity journal is malformed");
        }

        const checked = journalSchema.safeParse(parsed);

        if (!checked.success)
          throw new Error("Updater identity journal is malformed");
        journal = checked.data;

        if (
          JSON.stringify(journal.binding) !== JSON.stringify(args) ||
          JSON.stringify(journal.directory) !== JSON.stringify(directory) ||
          new Set(journal.files.map((file) => file.legacy)).size !==
            journal.files.length ||
          journal.files.some(
            (file) =>
              !pairs.some(
                (pair) =>
                  pair.legacy === file.legacy && pair.current === file.current,
              ),
          )
        )
          throw new Error(
            "Updater identity journal belongs to another prepared owner",
          );
      }

      const observed = await readPairs(args.dataDir);

      if (
        observed.some(
          (record) =>
            (record.legacyFile !== null || record.currentFile !== null) &&
            !journal.files.some(
              (file) =>
                file.legacy === record.legacy &&
                file.current === record.current,
            ),
        )
      )
        throw new Error(
          "Unexpected updater namespace file appeared after preparation",
        );

      for (const record of journal.files) {
        const from = join(args.dataDir, record.legacy),
          to = join(args.dataDir, record.current);

        const [before, after] = await Promise.all([capture(from), capture(to)]);

        if (before === null) {
          if (!same(after, record.identity))
            throw new Error("Updater destination changed after preparation");
          continue;
        }

        if (journal.phase !== "prepared" || !same(before, record.identity))
          throw new Error("Updater source changed after preparation");

        if (after !== null) {
          if (!same(after, record.identity))
            throw new Error("Updater destination collision after preparation");
          await unlink(from);
          await syncDirectory(args.dataDir);
        } else await moveExclusive(from, to);

        if (
          (await capture(from)) !== null ||
          !same(await capture(to), record.identity)
        )
          throw new Error(
            "Updater filename move lacks its exact completed owner",
          );
      }

      if (journal.phase === "prepared")
        await writeJsonFileAtomically(journalPath, {
          ...journal,
          phase: "complete",
        });
    },
  });
}

export function projectLegacyAppUpdateInventoryPathV1(path: string): string {
  const pair = pairs.find((value) => value.legacy === path.toLowerCase());

  return pair?.current ?? path;
}
