import {
  assertDesktopProfileOwnedPathV2 as ordinary,
  isInsideDesktopProfilePathV2 as inside,
  DESKTOP_PROFILE_MARKER_NAME_V1 as markerName,
  inspectDesktopProfileAdoptionTreeV1,
} from "./desktop-profile-catalog-v2.mjs";

export {
  inspectDesktopProfileAdoptionTreeV1,
  readDesktopProfileCatalogV2,
} from "./desktop-profile-catalog-v2.mjs";

import {
  protectedStoreExecutableSchemaV2,
  protectedStoreJobSchemaV2,
  protectedStoreSourceApplicationSchemaV2,
  protectedStoreSourceSelectionSchemaV2,
  transferDesktopProtectedStoreV2,
} from "./desktop-protected-store-closed-v2.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { withFileLock } from "@omnyo/config/file-lock";
import { writeJsonFileAtomically } from "@omnyo/server-archive/json-file";
import { copyMacStateAclV1 } from "@omnyo/server-archive/mac-state-acl-v1";

import {
  verifyDesktopProtectedStoreSignedJobV2,
  inspectDesktopProtectedStorePreparedJobV2,
} from "../scripts/prepare-protected-store-consumers.mjs";
import type { DesktopProtectedStoreUnsignedJobV2 } from "../scripts/prepare-protected-store-consumers.mjs";

export { runDesktopProfileContinuityV2 } from "./desktop-profile-continuity-v2.js";

export {
  sealDesktopProtectedStoreJobV2,
  prepareDesktopProtectedStoreUnsignedJobV2,
  finalizeDesktopProtectedStoreUnsignedJobV2,
  verifyDesktopProtectedStoreSignedJobV2,
  inspectDesktopProtectedStorePreparedJobV2,
} from "../scripts/prepare-protected-store-consumers.mjs";

export const DESKTOP_PROFILE_ADOPTION_PROTOCOL = 2;

const execute = promisify(execFile);

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const names = z.enum(["Omnyo Private", "Omnyo Private Nightly", "omnyo-dev"]);

const maximumJournalBytes = 1024 * 1024;

const legacy = {
  "Omnyo Private": "BB Private",
  "Omnyo Private Nightly": "BB Private Nightly",
  "omnyo-dev": "bb-dev",
};

const exact = z
  .string()
  .refine((path) => isAbsolute(path) && resolve(path) === path);

const unchangedOwnerInputSchema = z
  .object({
    version: z.literal(1),
    applicationName: names,
    appDataPath: exact,
    jobDir: exact,
    stoppedOwnerPid: z.number().int().positive(),
    nativeOwner: z
      .object({
        appId: z.string().min(1),
        storageName: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9 ._-]+$/u),
        executableSha256: digest,
        profileFenceVersion: z.literal(1),
      })
      .strict(),
  })
  .strict();

const originMappingSchema = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    fromOrigin: z.literal("https://bb.alexburlis.com"),
    toOrigin: z.literal("https://app.example.invalid"),
    serverHostId: z.string().min(1).max(200),
    runtimeId: z.string().min(1).max(200),
    selectedIds: z.array(digest).min(1).max(32),
    mappingSha256: digest,
  })
  .strict();

const originWindowSchema = z
  .object({
    mapping: originMappingSchema,
    stateKey: z.string().min(1).max(200),
    ticket: z
      .object({
        version: z.literal(1),
        adoptionId: z.string().min(1).max(200),
        id: digest,
        selectedIds: z.array(digest).min(1).max(32),
        nonce: digest,
        fromOrigin: z.literal("https://bb.alexburlis.com"),
        toOrigin: z.literal("https://app.example.invalid"),
      })
      .strict(),
    returnPath: z
      .string()
      .max(8192)
      .refine((value) => value.startsWith("/") && !value.startsWith("//")),
  })
  .strict();

const originWindowsSchema = z
  .array(originWindowSchema)
  .max(32)
  .superRefine((windows, context) => {
    const ids = windows.map((entry) => entry.ticket.id).sort();
    const first = windows[0];

    if (
      new Set(windows.map((entry) => entry.stateKey)).size !== windows.length ||
      new Set(ids).size !== ids.length ||
      windows.some(
        (entry) =>
          entry.ticket.adoptionId !== first?.ticket.adoptionId ||
          entry.mapping.adoptionId !== entry.ticket.adoptionId ||
          entry.mapping.fromOrigin !== entry.ticket.fromOrigin ||
          entry.mapping.toOrigin !== entry.ticket.toOrigin ||
          JSON.stringify(entry.mapping.selectedIds) !== JSON.stringify(ids) ||
          JSON.stringify(entry.ticket.selectedIds) !== JSON.stringify(ids),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Every staged native window must bind the exact selected adoption",
      });
    }
  });

const replacementOwnerInputSchema = unchangedOwnerInputSchema
  .extend({
    version: z.literal(2),
    applicationName: z.literal("Omnyo Private"),
    originWindows: originWindowsSchema,
    nativeOwner: unchangedOwnerInputSchema.shape.nativeOwner.extend({
      appId: z.literal("dev.omnyo.private"),
      profileFenceVersion: z.literal(2),
    }),
    protectedStoreTransfer: z
      .object({
        reader: protectedStoreExecutableSchemaV2,
        writer: protectedStoreExecutableSchemaV2,
        job: protectedStoreJobSchemaV2,
        sourceApplication: protectedStoreSourceApplicationSchemaV2.nullable(),
        oldStorageName:
          unchangedOwnerInputSchema.shape.nativeOwner.shape.storageName,
      })
      .strict(),
  })
  .strict();

const inputSchema = z
  .discriminatedUnion("version", [
    unchangedOwnerInputSchema,
    replacementOwnerInputSchema,
  ])
  .superRefine((input, context) => {
    if (input.version === 2) {
      const selected = protectedStoreSourceSelectionSchemaV2.safeParse({
        oldStorageName: input.protectedStoreTransfer.oldStorageName,
        newStorageName: input.nativeOwner.storageName,
        sourceApplication: input.protectedStoreTransfer.sourceApplication,
        job: input.protectedStoreTransfer.job,
      });

      if (
        !selected.success ||
        (input.protectedStoreTransfer.sourceApplication !== null &&
          input.protectedStoreTransfer.sourceApplication.profilePath !==
            join(input.appDataPath, "BB Private"))
      )
        context.addIssue({
          code: "custom",
          path: ["protectedStoreTransfer"],
          message:
            "Original source application attestation is required before profile preparation",
        });
    }

    if (input.version === 1 && input.nativeOwner.appId === "dev.omnyo.private")
      context.addIssue({
        code: "custom",
        message:
          "Replacement native identity requires the versioned protected-store transfer",
      });
  });

export type DesktopProfileAdoptionInputV1 = z.infer<typeof inputSchema>;

const preSealInputSchemaV2 = replacementOwnerInputSchema
  .extend({
    protectedStoreTransfer:
      replacementOwnerInputSchema.shape.protectedStoreTransfer.omit({
        job: true,
      }),
  })
  .strict()
  .superRefine((input, context) => {
    const source = input.protectedStoreTransfer.sourceApplication;

    if (
      input.nativeOwner.storageName !== "Omnyo Private" ||
      input.protectedStoreTransfer.oldStorageName !== "BB Private" ||
      source === null ||
      input.originWindows.length === 0 ||
      ![
        "/Applications/BB Private VPS.app",
        "/Applications/BB Private.app",
      ].includes(source.appPath) ||
      source.executable.path !==
        join(source.appPath, "Contents/MacOS/BB Private") ||
      source.profilePath !== join(input.appDataPath, "BB Private")
    )
      context.addIssue({
        code: "custom",
        message:
          "Production profile selection requires its exact source and staged windows",
      });
  });

type PreSealInputV2 = z.infer<typeof preSealInputSchemaV2>;

function profileBindingV2(canonical: PreSealInputV2) {
  return sha(
    JSON.stringify({
      ...canonical,
      protectedStoreTransfer: {
        reader: canonical.protectedStoreTransfer.reader,
        writer: canonical.protectedStoreTransfer.writer,
        oldStorageName: canonical.protectedStoreTransfer.oldStorageName,
        sourceApplication: canonical.protectedStoreTransfer.sourceApplication,
      },
    }),
  );
}

export function prepareDesktopProfileSelectionV2(value: PreSealInputV2) {
  const input = preSealInputSchemaV2.parse(value);

  return { input, bindingSha256: profileBindingV2(input) };
}

export function desktopProfileAdoptionBindingV1(
  input: DesktopProfileAdoptionInputV1,
): string {
  const canonical = inputSchema.parse(input);

  return canonical.version === 1
    ? sha(JSON.stringify(canonical))
    : profileBindingV2(canonical);
}

const journalSchema = z
  .object({
    version: z.literal(1),
    input: inputSchema,
    bindingSha256: digest,
    phase: z.enum([
      "prepared",
      "copied",
      "verified",
      "publishing",
      "published",
      "accepted",
      "rolled-back",
    ]),
    sourceDigest: digest,
    destinationDigest: digest.nullable(),
    stageDevice: z.string(),
    stageInode: z.string(),
    continuity: z
      .object({
        protectedStore: z.literal(true),
        cookies: z.literal(true),
        nativeOwnerSha256: digest,
      })
      .strict()
      .nullable(),
  })
  .strict();

type Journal = z.infer<typeof journalSchema>;

const markerSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("adopted"),
    applicationName: names,
    jobDir: exact,
    bindingSha256: digest,
  })
  .strict();

const fenceName = (name: string) => `.omnyo-profile-adoption-${name}.json`;

const sourcePath = (input: DesktopProfileAdoptionInputV1) =>
  join(input.appDataPath, legacy[input.applicationName]);

const targetPath = (input: DesktopProfileAdoptionInputV1) =>
  join(input.appDataPath, input.applicationName);

const journalPath = (input: DesktopProfileAdoptionInputV1) =>
  join(input.jobDir, "desktop-profile-adoption-v1.json");

async function optional(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
}

function stopped(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }

  throw new Error("The original desktop profile owner is still running");
}

async function stoppedProfile(input: DesktopProfileAdoptionInputV1) {
  stopped(input.stoppedOwnerPid);

  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
    if (await optional(join(sourcePath(input), name)))
      throw new Error(
        "The original Chromium profile has an active or uncertain singleton owner",
      );
}

async function save(journal: Journal) {
  if (
    Buffer.byteLength(JSON.stringify(journal, null, 2) + "\n") >
    maximumJournalBytes
  )
    throw new Error(
      "Desktop profile selected-window journal exceeds its bound",
    );

  await writeJsonFileAtomically(journalPath(journal.input), journal);
}

async function readJournal(jobDir: string): Promise<Journal> {
  await ordinary(jobDir, true);
  const path = join(jobDir, "desktop-profile-adoption-v1.json");
  const info = await ordinary(path, false);

  if ((info.mode & 0o077) !== 0 || info.size > maximumJournalBytes)
    throw new Error("Desktop profile journal must remain private and bounded");
  const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));

  if (
    journal.input.jobDir !== jobDir ||
    journal.bindingSha256 !== desktopProfileAdoptionBindingV1(journal.input)
  )
    throw new Error("Desktop profile journal belongs to different inputs");

  return journal;
}

async function immutable(path: string, value: object) {
  try {
    await writeJsonFileAtomically(path, value, true);
  } catch (error) {
    if (
      JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !==
      JSON.stringify(value)
    )
      throw error;
  }
}

async function assertStage(journal: Journal, path: string) {
  const info = await ordinary(path, true);

  if (
    String(info.dev) !== journal.stageDevice ||
    String(info.ino) !== journal.stageInode
  )
    throw new Error("Desktop profile staging owner changed");
}

async function transferProtectedStore(
  journal: Journal,
  operation: "write" | "rollback" | "admit" | "status",
) {
  const input = journal.input;

  if (input.version !== 2) return;

  return transferDesktopProtectedStoreV2(
    {
      version: 2,
      ...input.protectedStoreTransfer,
      newStorageName: input.nativeOwner.storageName,
      profileBindingSha256: journal.bindingSha256,
      admissionPath: join(input.jobDir, "desktop-profile-admission"),
    },
    operation,
  );
}

async function ensureDesktopProfileAdmissionV2(
  jobDir: string,
  admitted: boolean,
) {
  const path = join(jobDir, "desktop-profile-admission");

  if (!(await optional(path))) {
    const admission = await open(path, "wx", 0o600);

    try {
      await admission.writeFile("0");
      await admission.sync();
    } finally {
      await admission.close();
    }
  }

  const info = await ordinary(path, false);
  const value = await readFile(path, "utf8");

  if (
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0 ||
    info.size !== 1 ||
    (value !== "0" && !(admitted && value === "1"))
  )
    throw new Error(
      "Desktop profile admission owner must retain its exact closed byte",
    );

  return { path, device: String(info.dev), inode: String(info.ino) };
}

export async function inspectDesktopProfileAdoptionCheckpointV2(
  jobDir: string,
) {
  let journal: Journal;

  try {
    journal = await readJournal(jobDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }

  if (journal.input.version !== 2)
    throw new Error("Native profile checkpoint has a different protocol owner");

  return {
    version: 2 as const,
    phase: journal.phase,
    bindingSha256: journal.bindingSha256,
    continuityVerified: journal.continuity !== null,
    sourceDigest: journal.sourceDigest,
    destinationDigest: journal.destinationDigest,
    stageDevice: journal.stageDevice,
    stageInode: journal.stageInode,
    targetPath: targetPath(journal.input),
  };
}

export async function prepareDesktopProfileAdmissionV2(jobDir: string) {
  const info = await ordinary(jobDir, true);

  if ((info.mode & 0o077) !== 0)
    throw new Error("Desktop profile admission job must remain private");

  return withFileLock({
    path: join(jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: () => ensureDesktopProfileAdmissionV2(jobDir, false),
  });
}

export async function installDesktopProtectedStoreSignedJobV2(
  jobDir: string,
  prepared: DesktopProtectedStoreUnsignedJobV2,
  value: unknown,
) {
  const returned = z
    .object({ envelopePath: exact, receiptPath: exact, receiptSha256: digest })
    .strict()
    .parse(value);

  const original = join(jobDir, "ProtectedStoreTransfer.app");

  if (
    prepared.binding.job.path !== original ||
    returned.envelopePath !==
      join(jobDir, "signed-code-" + returned.receiptSha256) ||
    returned.receiptPath !== returned.envelopePath + ".json"
  )
    throw new Error("Desktop returned code belongs to another profile job");
  await ordinary(jobDir, true);

  return withFileLock({
    path: join(jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: async () => {
      await ensureDesktopProfileAdmissionV2(jobDir, false);
      const receipt = await ordinary(returned.receiptPath, false);

      if (
        receipt.nlink !== 1 ||
        receipt.size > 32768 ||
        (receipt.mode & 0o077) !== 0
      )
        throw new Error("Desktop returned code receipt owner differs");
      const raw = await readFile(returned.receiptPath);

      if (sha(raw) !== returned.receiptSha256)
        throw new Error("Desktop returned code receipt changed");
      const signed = JSON.parse(raw.toString("utf8"));

      const backup = join(
        jobDir,
        "unsigned-code-" + prepared.selectionSha256 + ".app",
      );

      if (await optional(original)) {
        try {
          return await verifyDesktopProtectedStoreSignedJobV2({
            envelopePath: original,
            prepared,
            signed,
          });
        } catch (error) {
          if (await optional(backup)) throw error;
        }

        const actual = await inspectDesktopProtectedStorePreparedJobV2({
          envelopePath: original,
          expected: prepared.binding,
        });

        if (
          actual.phase !== "target-attested-unsigned" ||
          JSON.stringify(actual.prepared) !== JSON.stringify(prepared)
        )
          throw new Error("Desktop unsigned code changed before replacement");
      }

      await verifyDesktopProtectedStoreSignedJobV2({
        envelopePath: returned.envelopePath,
        prepared,
        signed,
      });

      if (await optional(original)) await rename(original, backup);
      else {
        const actual = await inspectDesktopProtectedStorePreparedJobV2({
          envelopePath: backup,
          jobPath: original,
          expected: prepared.binding,
        });

        if (
          actual.phase !== "target-attested-unsigned" ||
          JSON.stringify(actual.prepared) !== JSON.stringify(prepared)
        )
          throw new Error(
            "Desktop returned code lost its attested unsigned owner",
          );
      }

      await rename(returned.envelopePath, original);

      return verifyDesktopProtectedStoreSignedJobV2({
        envelopePath: original,
        prepared,
        signed,
      });
    },
  });
}

export class DesktopProfileContinuityConsumersActiveError extends Error {}

function continuityJob(journal: Journal, jobDir: string) {
  const { input } = journal;

  if (
    input.jobDir !== jobDir ||
    journal.bindingSha256 !== desktopProfileAdoptionBindingV1(input) ||
    input.version !== 2 ||
    input.nativeOwner.storageName !== "Omnyo Private" ||
    input.protectedStoreTransfer.oldStorageName !== "BB Private" ||
    input.protectedStoreTransfer.sourceApplication === null ||
    journal.phase !== "copied" ||
    journal.continuity !== null ||
    journal.destinationDigest === null ||
    journal.sourceDigest !== journal.destinationDigest
  )
    throw new Error(
      "Desktop continuity requires the exact closed production copied job",
    );

  return {
    input,
    bindingSha256: journal.bindingSha256,
    sourceDigest: journal.sourceDigest,
    sourceProbe: join(jobDir, "profile-source-probe"),
    probe: join(jobDir, "profile-probe"),
    nativeOwnerSha256: sha(JSON.stringify(input.nativeOwner)),
    protectedStoreBinding: {
      version: 2 as const,
      ...input.protectedStoreTransfer,
      newStorageName: input.nativeOwner.storageName,
      profileBindingSha256: journal.bindingSha256,
      admissionPath: join(jobDir, "desktop-profile-admission"),
    },
  };
}

export function readDesktopProfileContinuityJobV2Sync(jobDir: string) {
  for (const path of [
    jobDir,
    join(jobDir, "profile-source-probe"),
    join(jobDir, "profile-probe"),
  ]) {
    const info = lstatSync(path);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      realpathSync(path) !== path ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new Error("Desktop continuity probe ownership differs");
  }

  const bytes = privateTextSync(
    join(jobDir, "desktop-profile-adoption-v1.json"),
    maximumJournalBytes,
  );

  const context = continuityJob(journalSchema.parse(JSON.parse(bytes)), jobDir);

  if (privateTextSync(join(jobDir, "desktop-profile-admission"), 1) !== "0")
    throw new Error("Desktop continuity first-write admission changed");

  return { ...context, journalSha256: sha(bytes) };
}

export async function inspectDesktopProfileContinuityJobV2(jobDir: string) {
  const journal = await readJournal(jobDir);
  const context = continuityJob(journal, jobDir);
  const { input } = context;
  await stoppedProfile(input);
  const stage = join(jobDir, "profile-staging");
  await assertStage(journal, stage);

  const actual = await Promise.all([
    inspectDesktopProfileAdoptionTreeV1(sourcePath(input)),
    inspectDesktopProfileAdoptionTreeV1(context.sourceProbe),
    inspectDesktopProfileAdoptionTreeV1(stage, true),
    inspectDesktopProfileAdoptionTreeV1(context.probe, true),
  ]);

  if (
    actual.some((value) => value !== journal.sourceDigest) ||
    (await optional(targetPath(input)))
  )
    throw new Error("Desktop continuity source, copies or publication changed");

  const admission = await ordinary(
    context.protectedStoreBinding.admissionPath,
    false,
  );

  const original = input.protectedStoreTransfer.sourceApplication;

  if (original === null)
    throw new Error("Desktop continuity source attestation is missing");
  const executable = await ordinary(original.executable.path, false);

  if (
    (admission.mode & 0o077) !== 0 ||
    admission.size !== 1 ||
    (await readFile(context.protectedStoreBinding.admissionPath, "utf8")) !==
      "0" ||
    String(executable.dev) !== original.device ||
    String(executable.ino) !== original.inode ||
    (executable.mode & 0o777) !== (original.originalMode & ~0o111) ||
    sha(await readFile(original.executable.path)) !== original.executable.sha256
  )
    throw new Error(
      "Desktop continuity requires its original native fence and closed latch",
    );

  return { ...context, journalSha256: sha(await readFile(journalPath(input))) };
}

export async function prepareDesktopProfileAdoptionV1(
  value: DesktopProfileAdoptionInputV1,
  owners: {
    verifyNativeOwner(): Promise<DesktopProfileAdoptionInputV1["nativeOwner"]>;
    verifyContinuity(
      probeProfile: string,
    ): Promise<NonNullable<Journal["continuity"]>>;
  },
): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error(
      "Desktop profile cloning requires the existing Mac filesystem owner",
    );
  const input = inputSchema.parse(value);
  await ordinary(input.appDataPath, true);
  const source = sourcePath(input);
  const target = targetPath(input);

  if (
    inside(source, input.jobDir) ||
    inside(target, input.jobDir) ||
    inside(input.jobDir, source) ||
    inside(input.jobDir, target)
  )
    throw new Error("Desktop profile job must be separate from both profiles");
  await stoppedProfile(input);

  if (
    JSON.stringify(await owners.verifyNativeOwner()) !==
    JSON.stringify(input.nativeOwner)
  )
    throw new Error(
      "Desktop profile requires its attested native OS owner and fence capability",
    );
  await mkdir(input.jobDir, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  const job = await ordinary(input.jobDir, true);

  if (
    (job.mode & 0o077) !== 0 ||
    job.dev !== (await ordinary(source, true)).dev ||
    job.dev !== (await lstat(input.appDataPath)).dev
  )
    throw new Error(
      "Desktop profile job must be private on the same filesystem",
    );
  await withFileLock({
    path: join(input.jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: async () => {
      const stage = join(input.jobDir, "profile-staging");
      const probe = join(input.jobDir, "profile-probe");
      const sourceProbe = join(input.jobDir, "profile-source-probe");

      let journal = (await optional(journalPath(input)))
        ? await readJournal(input.jobDir)
        : null;

      const bindingSha256 = desktopProfileAdoptionBindingV1(input);

      if (journal === null) {
        if (
          (await optional(target)) ||
          (await optional(stage)) ||
          (await optional(probe)) ||
          (await optional(sourceProbe))
        )
          throw new Error(
            "Desktop profile destination or staging collides with existing work",
          );
        const sourceDigest = await inspectDesktopProfileAdoptionTreeV1(source);
        await mkdir(stage, { mode: 0o700 });
        const info = await lstat(stage);
        journal = {
          version: 1,
          input,
          bindingSha256,
          phase: "prepared",
          sourceDigest,
          destinationDigest: null,
          stageDevice: String(info.dev),
          stageInode: String(info.ino),
          continuity: null,
        };
        await save(journal);
      }

      if (
        JSON.stringify(journal.input) !== JSON.stringify(input) ||
        journal.phase === "rolled-back"
      )
        throw new Error("Desktop profile journal binding or lifecycle differs");

      if (journal.phase === "accepted") return;
      await immutable(
        join(input.appDataPath, fenceName(input.applicationName)),
        { version: 1, jobDir: input.jobDir, bindingSha256 },
      );

      await ensureDesktopProfileAdmissionV2(
        input.jobDir,
        journal.phase === "published",
      );

      await stoppedProfile(input);

      if (
        (await inspectDesktopProfileAdoptionTreeV1(source)) !==
        journal.sourceDigest
      )
        throw new Error(
          "Original desktop profile changed after its stopped checkpoint",
        );

      if (journal.phase === "prepared") {
        await assertStage(journal, stage);
        const children = await readdir(stage);

        if (children.length === 0) {
          await execute("/bin/cp", ["-ac", `${source}/.`, stage], {
            timeout: 15000,
          });
          await copyMacStateAclV1(source, stage);
        } else if (
          (await inspectDesktopProfileAdoptionTreeV1(stage, true)) !==
          journal.sourceDigest
        ) {
          throw new Error(
            "Interrupted desktop clone requires explicit reconciliation; staged work was preserved",
          );
        }

        const info = await lstat(stage);
        journal.stageDevice = String(info.dev);
        journal.stageInode = String(info.ino);

        if (
          (await inspectDesktopProfileAdoptionTreeV1(stage, true)) !==
          journal.sourceDigest
        )
          throw new Error("Desktop profile clone changed bytes or ownership");
        const oldPartition = join(stage, "Partitions/bb-browser");
        const newPartition = join(stage, "Partitions/omnyo-browser");

        if (await optional(oldPartition)) {
          if (await optional(newPartition))
            throw new Error("Old and current browser partitions collide");
          await rename(oldPartition, newPartition);
        }

        await immutable(join(stage, markerName), {
          version: 1,
          kind: "adopted",
          applicationName: input.applicationName,
          jobDir: input.jobDir,
          bindingSha256,
        });
        journal.destinationDigest = await inspectDesktopProfileAdoptionTreeV1(
          stage,
          true,
        );

        if (journal.destinationDigest !== journal.sourceDigest)
          throw new Error("Desktop partition adoption changed profile content");
        journal.phase = "copied";
        await save(journal);
      }

      if (journal.phase === "copied") {
        await assertStage(journal, stage);

        if (
          (await inspectDesktopProfileAdoptionTreeV1(stage, true)) !==
          journal.destinationDigest
        )
          throw new Error(
            "Prepared desktop profile changed before continuity verification",
          );

        await transferProtectedStore(journal, "write");

        if ((await optional(probe)) || (await optional(sourceProbe)))
          throw new Error(
            "A prior desktop continuity probe requires owned-child reconciliation",
          );

        await execute("/bin/cp", ["-ac", source, sourceProbe], {
          timeout: 15000,
        });

        let consumersMayBeActive = false;

        try {
          await copyMacStateAclV1(source, sourceProbe);
          await execute("/bin/cp", ["-ac", stage, probe], { timeout: 15000 });
          await copyMacStateAclV1(stage, probe);

          if (
            (await inspectDesktopProfileAdoptionTreeV1(sourceProbe)) !==
              journal.sourceDigest ||
            (await inspectDesktopProfileAdoptionTreeV1(probe, true)) !==
              journal.destinationDigest
          )
            throw new Error(
              "Desktop continuity copies differ from their authoritative catalogs",
            );

          const continuity = journalSchema.shape.continuity
            .unwrap()
            .parse(await owners.verifyContinuity(probe));

          if (
            continuity.nativeOwnerSha256 !==
            sha(JSON.stringify(input.nativeOwner))
          )
            throw new Error(
              "Desktop continuity used a different native OS owner",
            );
          journal.continuity = continuity;
        } catch (error) {
          consumersMayBeActive =
            error instanceof DesktopProfileContinuityConsumersActiveError;
          throw error;
        } finally {
          if (!consumersMayBeActive)
            await Promise.all([
              rm(probe, { recursive: true, force: true }),
              rm(sourceProbe, { recursive: true }),
            ]);
        }

        if (
          (await inspectDesktopProfileAdoptionTreeV1(stage, true)) !==
            journal.destinationDigest ||
          (await inspectDesktopProfileAdoptionTreeV1(source)) !==
            journal.sourceDigest
        )
          throw new Error(
            "Desktop verification altered an authoritative profile",
          );
        journal.phase = "verified";
        await save(journal);
      }

      if (journal.phase === "verified") {
        journal.phase = "publishing";
        await save(journal);
      }

      if (journal.phase === "publishing") {
        if (await optional(target)) {
          if (await optional(stage))
            throw new Error(
              "Desktop profile publication collides with independent work",
            );
          await assertStage(journal, target);
        } else {
          await assertStage(journal, stage);
          await rename(stage, target);
        }

        if (
          (await inspectDesktopProfileAdoptionTreeV1(target, true)) !==
          journal.destinationDigest
        )
          throw new Error(
            "Published desktop profile differs from its verified clone",
          );
        journal.phase = "published";
        await save(journal);
      }
    },
  });
}

export async function acceptDesktopProfileAdoptionV1(
  jobDir: string,
): Promise<void> {
  await ordinary(jobDir, true);
  await withFileLock({
    path: join(jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: async () => {
      const journal = await readJournal(jobDir);

      if (
        journal.input.version === 2 &&
        journal.input.originWindows.length === 0
      )
        throw new Error(
          "Replacement profile admission requires every selected preserved browser window",
        );

      if (journal.phase === "accepted") return;

      if (journal.phase !== "published" || journal.continuity === null)
        throw new Error(
          "Desktop profile requires verified publication before its first write",
        );
      await stoppedProfile(journal.input);
      await assertStage(journal, targetPath(journal.input));

      if (
        (await inspectDesktopProfileAdoptionTreeV1(
          sourcePath(journal.input),
        )) !== journal.sourceDigest ||
        (await inspectDesktopProfileAdoptionTreeV1(
          targetPath(journal.input),
          true,
        )) !== journal.destinationDigest
      )
        throw new Error("Desktop profile changed before first-write admission");

      if (journal.input.version === 2) {
        const result = await transferProtectedStore(journal, "admit");

        if (result?.admitted !== true)
          throw new Error("Native protected-store admission did not complete");
      } else {
        const admission = await open(
          join(jobDir, "desktop-profile-admission"),
          "r+",
        );

        try {
          await admission.write(Buffer.from("1"), 0, 1, 0);
          await admission.sync();
        } finally {
          await admission.close();
        }
      }

      journal.phase = "accepted";
      await save(journal);
    },
  });
}

function privateTextSync(path: string, limit: number): string {
  const info = lstatSync(path);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (process.getuid !== undefined && (info.mode & 0o077) !== 0) ||
    info.size > limit ||
    realpathSync(path) !== path
  )
    throw new Error(
      "Desktop profile admission record is not a private bounded file",
    );

  return readFileSync(path, "utf8");
}

export function readAdoptedDesktopProfileV1Sync(
  path: string,
  applicationName: z.infer<typeof names>,
): boolean {
  let marker: z.infer<typeof markerSchema>;

  try {
    const raw = JSON.parse(privateTextSync(join(path, markerName), 4096));

    if (raw.kind !== "adopted") return false;
    marker = markerSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }

  for (const file of [marker.jobDir, path]) {
    const info = lstatSync(file);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      realpathSync(file) !== file
    )
      throw new Error("Adopted desktop profile filesystem owner changed");
  }

  const journal = journalSchema.parse(
    JSON.parse(
      privateTextSync(
        join(marker.jobDir, "desktop-profile-adoption-v1.json"),
        maximumJournalBytes,
      ),
    ),
  );

  if (
    marker.applicationName !== applicationName ||
    journal.phase !== "accepted" ||
    journal.continuity === null ||
    (journal.input.version === 2 && journal.input.originWindows.length === 0) ||
    marker.bindingSha256 !== journal.bindingSha256 ||
    desktopProfileAdoptionBindingV1(journal.input) !== marker.bindingSha256 ||
    targetPath(journal.input) !== path ||
    journal.input.jobDir !== marker.jobDir ||
    privateTextSync(join(marker.jobDir, "desktop-profile-admission"), 1) !== "1"
  )
    throw new Error(
      "Desktop profile first writes are held until native continuity is accepted",
    );

  return true;
}

function originWindowOwner(args: {
  profilePath: string;
  applicationName: z.infer<typeof names>;
}) {
  if (!readAdoptedDesktopProfileV1Sync(args.profilePath, args.applicationName))
    return null;

  const marker = markerSchema.parse(
    JSON.parse(privateTextSync(join(args.profilePath, markerName), 4096)),
  );

  const journal = journalSchema.parse(
    JSON.parse(
      privateTextSync(
        join(marker.jobDir, "desktop-profile-adoption-v1.json"),
        maximumJournalBytes,
      ),
    ),
  );

  if (journal.input.version === 1) return null;
  const input = journal.input;

  const path = join(marker.jobDir, "desktop-origin-windows-admitted-v1.json");
  let admitted: string[] = [];

  try {
    const completion = z
      .object({
        version: z.literal(1),
        bindingSha256: digest,
        stateKeys: z.array(z.string()).max(32),
      })
      .strict()
      .parse(JSON.parse(privateTextSync(path, 16384)));

    if (
      completion.bindingSha256 !== journal.bindingSha256 ||
      new Set(completion.stateKeys).size !== completion.stateKeys.length ||
      completion.stateKeys.some(
        (key) => !input.originWindows.some((entry) => entry.stateKey === key),
      )
    )
      throw new Error("Native window admission belongs to another profile");
    admitted = completion.stateKeys;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  return { journal, input, path, admitted };
}

export function desktopProfileOriginWindowV1Sync(args: {
  profilePath: string;
  applicationName: z.infer<typeof names>;
  stateKey: string;
}) {
  const owner = originWindowOwner(args);

  if (owner === null) return null;

  const selected = owner.input.originWindows.find(
    (entry) => entry.stateKey === args.stateKey,
  );

  if (selected === undefined) {
    if (owner.admitted.length !== owner.input.originWindows.length)
      throw new Error(
        "Native window has no attested preserved browser context",
      );

    return null;
  }

  return { ...selected, admitted: owner.admitted.includes(args.stateKey) };
}

export function desktopProfileAdmittedOriginMappingV1Sync(args: {
  profilePath: string;
  applicationName: z.infer<typeof names>;
}) {
  const owner = originWindowOwner(args);

  if (
    owner === null ||
    owner.input.originWindows.length === 0 ||
    owner.admitted.length !== owner.input.originWindows.length
  )
    return null;
  const selected = owner.input.originWindows[0];

  if (selected === undefined)
    throw new Error("Native origin admission has no selected mapping");

  return { ...selected.mapping, adoptionAccepted: true as const };
}

export function desktopProfileOriginWindowUrlV1Sync(args: {
  profilePath: string;
  applicationName: z.infer<typeof names>;
  stateKey: string;
  initialUrl: string | null;
}): string | null {
  const selected = desktopProfileOriginWindowV1Sync(args);

  if (selected === null) {
    const mapping = desktopProfileAdmittedOriginMappingV1Sync(args);

    if (mapping === null || args.initialUrl === null) return args.initialUrl;
    const url = new URL(args.initialUrl);

    return url.origin === mapping.fromOrigin
      ? mapping.toOrigin + url.pathname + url.search + url.hash
      : args.initialUrl;
  }

  if (selected.admitted) {
    if (args.initialUrl === null) return null;
    const url = new URL(args.initialUrl);

    return url.origin === selected.ticket.fromOrigin
      ? selected.ticket.toOrigin + url.pathname + url.search + url.hash
      : args.initialUrl;
  }

  const bootstrap = {
    version: 1,
    ticket: selected.ticket,
    mapping: selected.mapping,
    returnPath: selected.returnPath,
    windowState: { action: "restore", windowKey: selected.stateKey },
  };

  return (
    selected.ticket.fromOrigin +
    "/origin-adoption-v1.html#" +
    encodeURIComponent(JSON.stringify(bootstrap))
  );
}

export async function acceptDesktopProfileOriginWindowV1(args: {
  profilePath: string;
  applicationName: z.infer<typeof names>;
  stateKey: string;
  controllerReceipt: unknown;
  serverReceipt: unknown;
}) {
  const first = originWindowOwner(args);

  if (first === null)
    throw new Error("Native window admission has no adopted profile owner");

  await withFileLock({
    path: join(first.input.jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: async () => {
      const owner = originWindowOwner(args);

      if (owner === null)
        throw new Error("Native window admission owner changed");

      const selected = owner.input.originWindows.find(
        (entry) => entry.stateKey === args.stateKey,
      );

      if (selected === undefined)
        throw new Error("Native window admission is outside the selected set");

      const controller = z
        .object({
          version: z.literal(1),
          adoptionId: z.string(),
          id: digest,
          windowKey: z.string(),
          admitted: z.literal(true),
        })
        .strict()
        .parse(args.controllerReceipt);

      const server = z
        .object({
          authorized: z.literal(true),
          mapping: originMappingSchema,
          phase: z.literal("admitted"),
          adoptionAccepted: z.literal(true),
        })
        .strict()
        .parse(args.serverReceipt);

      if (
        controller.adoptionId !== selected.ticket.adoptionId ||
        controller.id !== selected.ticket.id ||
        controller.windowKey !== selected.stateKey ||
        JSON.stringify(server.mapping) !== JSON.stringify(selected.mapping)
      )
        throw new Error(
          "Native window admission differs from the verified origin owner",
        );

      if (!owner.admitted.includes(args.stateKey))
        await writeJsonFileAtomically(owner.path, {
          version: 1,
          bindingSha256: owner.journal.bindingSha256,
          stateKeys: [...owner.admitted, args.stateKey].sort(),
        });
    },
  });
}

export async function rollbackDesktopProfileAdoptionV1(
  jobDir: string,
): Promise<void> {
  await ordinary(jobDir, true);
  await withFileLock({
    path: join(jobDir, "desktop-profile.lock"),
    timeoutMs: 1000,
    work: async () => {
      const journal = await readJournal(jobDir);

      if (journal.phase === "rolled-back") return;

      if (
        journal.phase === "accepted" ||
        (await readFile(join(jobDir, "desktop-profile-admission"), "utf8")) !==
          "0"
      )
        throw new Error(
          "Desktop rollback is forbidden after first-write admission",
        );
      const protectedState = await transferProtectedStore(journal, "status");

      if (protectedState?.admitted === true)
        throw new Error(
          "Desktop rollback is forbidden after native protected-store admission",
        );
      await stoppedProfile(journal.input);

      if (
        (await inspectDesktopProfileAdoptionTreeV1(
          sourcePath(journal.input),
        )) !== journal.sourceDigest
      )
        throw new Error("Desktop rollback refuses a changed original profile");
      const target = targetPath(journal.input);
      const stage = join(jobDir, "profile-staging");

      if (await optional(target)) {
        if (journal.phase !== "published" || (await optional(stage)))
          throw new Error("Desktop rollback refuses an ambiguous destination");
        await assertStage(journal, target);

        if (
          (await inspectDesktopProfileAdoptionTreeV1(target, true)) !==
          journal.destinationDigest
        )
          throw new Error(
            "Desktop rollback preserves changed destination work",
          );
        await rename(target, stage);
      }

      const fence = join(
        journal.input.appDataPath,
        fenceName(journal.input.applicationName),
      );

      const value = JSON.parse(await readFile(fence, "utf8"));

      if (
        value.jobDir !== jobDir ||
        value.bindingSha256 !== journal.bindingSha256
      )
        throw new Error(
          "Desktop rollback source fence belongs to another owner",
        );
      await transferProtectedStore(journal, "rollback");
      await rm(fence);
      journal.phase = "rolled-back";
      await save(journal);
    },
  });
}

export function assertDesktopProfileSourceNotFencedV1(
  appDataPath: string,
  applicationName: z.infer<typeof names>,
  profilePath: string,
): void {
  const fence = join(appDataPath, fenceName(applicationName));
  let raw: string;

  try {
    raw = privateTextSync(fence, 4096);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }

  const value = z
    .object({ version: z.literal(1), jobDir: exact, bindingSha256: digest })
    .strict()
    .parse(JSON.parse(raw));

  const journal = journalSchema.parse(
    JSON.parse(
      privateTextSync(
        join(value.jobDir, "desktop-profile-adoption-v1.json"),
        maximumJournalBytes,
      ),
    ),
  );

  if (
    value.bindingSha256 !== journal.bindingSha256 ||
    journal.input.appDataPath !== appDataPath ||
    journal.input.applicationName !== applicationName
  )
    throw new Error("Desktop source fence ownership differs");

  if (profilePath === sourcePath(journal.input))
    throw new Error(
      "The original desktop profile is fenced for identity adoption",
    );
}

export function desktopProfileStorageNameV1(
  path: string,
  applicationName: z.infer<typeof names>,
): string {
  if (!readAdoptedDesktopProfileV1Sync(path, applicationName))
    return applicationName;

  const marker = markerSchema.parse(
    JSON.parse(privateTextSync(join(path, markerName), 4096)),
  );

  return journalSchema.parse(
    JSON.parse(
      privateTextSync(
        join(marker.jobDir, "desktop-profile-adoption-v1.json"),
        maximumJournalBytes,
      ),
    ),
  ).input.nativeOwner.storageName;
}
