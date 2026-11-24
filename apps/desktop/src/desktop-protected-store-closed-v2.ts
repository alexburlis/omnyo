import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const absolute = z
  .string()
  .refine((path) => isAbsolute(path) && resolve(path) === path);

export const protectedStoreExecutableSchemaV2 = z
  .object({
    path: absolute,
    sha256: digest,
    codeDirectoryHash: z.string().regex(/^[a-f0-9]{40}$/u),
    designatedRequirement: z.string().min(1).max(8192),
  })
  .strict();

export const protectedStoreJobSchemaV2 = z
  .object({ path: absolute, selectionSha256: digest })
  .strict();

export const protectedStoreSourceApplicationSchemaV2 = z
  .object({
    appPath: absolute,
    profilePath: absolute,
    executable: protectedStoreExecutableSchemaV2,
    originalMode: z
      .number()
      .int()
      .min(0)
      .max(0o777)
      .refine((mode) => (mode & 0o111) !== 0 && (mode & 0o022) === 0),
    device: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .max(20),
    inode: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .max(20),
  })
  .strict();

export const protectedStoreSourceSelectionSchemaV2 = z
  .object({
    oldStorageName: z.string().min(1).max(100),
    newStorageName: z.string().min(1).max(100),
    sourceApplication: protectedStoreSourceApplicationSchemaV2.nullable(),
    job: protectedStoreJobSchemaV2,
  })
  .strict()
  .superRefine((input, context) => {
    const match =
      /^Omnyo Closed Transfer ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) Legacy$/u.exec(
        input.oldStorageName,
      );

    const fixtureRoot = dirname(input.job.path);

    const fixture =
      match !== null &&
      input.newStorageName === `Omnyo Closed Transfer ${match[1]} Current` &&
      /^test-[a-f0-9-]+--(?:native-protected-store|sealed-profile-v2)$/u.test(
        fixtureRoot.split("/").at(-1) ?? "",
      );

    const source = input.sourceApplication;

    if (source === null) {
      if (!fixture)
        context.addIssue({
          code: "custom",
          message:
            "Production protected-store jobs require the original source application attestation",
        });

      return;
    }

    const oldName = fixture ? "BB Private" : input.oldStorageName;

    const appPaths = fixture
      ? [join(fixtureRoot, "Source.app")]
      : oldName === "BB Private"
        ? ["/Applications/BB Private VPS.app", "/Applications/BB Private.app"]
        : oldName === "BB Private Nightly"
          ? ["/Applications/BB Private Nightly.app"]
          : [];

    const profile = fixture
      ? join(fixtureRoot, "profiles/BB Private")
      : join(dirname(source.profilePath), oldName);

    if (
      !appPaths.includes(source.appPath) ||
      source.executable.path !==
        join(source.appPath, "Contents/MacOS", oldName) ||
      source.profilePath !== profile ||
      (!fixture && input.newStorageName !== oldName.replace(/^BB /u, "Omnyo "))
    )
      context.addIssue({
        code: "custom",
        message: "Protected-store source application selection differs",
      });
  });

export const protectedStoreBindingSchemaV2 = z
  .object({
    version: z.literal(2),
    reader: protectedStoreExecutableSchemaV2,
    writer: protectedStoreExecutableSchemaV2,
    oldStorageName: z.string().min(1).max(100),
    newStorageName: z.string().min(1).max(100),
    profileBindingSha256: digest,
    admissionPath: absolute,
    sourceApplication: protectedStoreSourceApplicationSchemaV2.nullable(),
    job: protectedStoreJobSchemaV2,
  })
  .strict()
  .superRefine((input, context) => {
    const selected = protectedStoreSourceSelectionSchemaV2.safeParse({
      oldStorageName: input.oldStorageName,
      newStorageName: input.newStorageName,
      sourceApplication: input.sourceApplication,
      job: input.job,
    });

    if (!selected.success)
      for (const issue of selected.error.issues) context.addIssue({ ...issue });
  });

export type DesktopProtectedStoreBindingV2 = z.infer<
  typeof protectedStoreBindingSchemaV2
>;

const reportSchema = z
  .object({
    version: z.literal(2),
    operation: z.enum(["write", "rollback", "admit", "status"]),
    bindingSha256: digest,
    outcome: z.enum([
      "copied",
      "removed",
      "absent",
      "closed",
      "admitted",
      "admitted-recovery-required",
    ]),
    created: z.boolean(),
    admitted: z.boolean(),
    protectedStore: z.literal(true),
    authenticationUIFail: z.literal(true),
    interactionNotAllowed: z.literal(true),
  })
  .strict();

async function ordinary(path: string, directory: boolean) {
  const info = await lstat(path);

  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw new Error("Protected-store sealed owner binding changed");

  return info;
}

export async function transferDesktopProtectedStoreV2(
  value: DesktopProtectedStoreBindingV2,
  operation: "write" | "rollback" | "admit" | "status" = "write",
) {
  if (process.platform !== "darwin")
    throw new Error("Protected-store transfer requires its Mac native owner");
  const input = protectedStoreBindingSchemaV2.parse(value);
  await ordinary(input.job.path, true);

  const selectionPath = join(
    input.job.path,
    "Contents/Resources/selection.json",
  );

  const info = await ordinary(selectionPath, false);

  if (info.size > 16384)
    throw new Error("Protected-store selection exceeds its bound");
  const raw = await readFile(selectionPath);

  if (
    createHash("sha256").update(raw).digest("hex") !== input.job.selectionSha256
  )
    throw new Error("Protected-store sealed selection binding changed");

  const selection = z
    .object({
      version: z.literal(2),
      keychainBackend: z.literal("default-SecItem-macOS"),
      oldStorageName: z.string(),
      newStorageName: z.string(),
      profileBindingSha256: digest,
      admissionPath: absolute,
      sourceApplication: protectedStoreSourceApplicationSchemaV2.nullable(),
      reader: protectedStoreExecutableSchemaV2.omit({ path: true }),
      writer: protectedStoreExecutableSchemaV2.omit({ path: true }),
      bindingSha256: digest,
    })
    .strict()
    .parse(JSON.parse(raw.toString("utf8")));

  const selectedFields = { ...selection };

  const expected = {
    version: input.version,
    keychainBackend: "default-SecItem-macOS",
    oldStorageName: input.oldStorageName,
    newStorageName: input.newStorageName,
    profileBindingSha256: input.profileBindingSha256,
    admissionPath: input.admissionPath,
    sourceApplication: input.sourceApplication,
    reader: {
      sha256: input.reader.sha256,
      codeDirectoryHash: input.reader.codeDirectoryHash,
      designatedRequirement: input.reader.designatedRequirement,
    },
    writer: {
      sha256: input.writer.sha256,
      codeDirectoryHash: input.writer.codeDirectoryHash,
      designatedRequirement: input.writer.designatedRequirement,
    },
  };

  if (
    input.reader.path !==
      join(input.job.path, "Contents/Resources/old-reader") ||
    input.writer.path !==
      join(input.job.path, "Contents/Resources/new-writer") ||
    JSON.stringify({ ...expected, bindingSha256: selection.bindingSha256 }) !==
      JSON.stringify(selectedFields) ||
    createHash("sha256").update(JSON.stringify(expected)).digest("hex") !==
      selection.bindingSha256
  )
    throw new Error("Protected-store selected profile binding changed");
  await ordinary(input.writer.path, false);

  if (
    createHash("sha256")
      .update(await readFile(input.writer.path))
      .digest("hex") !== input.writer.sha256
  )
    throw new Error("Protected-store closed writer binding changed");

  const result = await execute(input.writer.path, [operation, input.job.path], {
    timeout: 5000,
    maxBuffer: 4096,
    env: {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR,
    },
  }).catch((error: unknown) => {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown";

    throw new Error(
      `Protected-store native effect refused (${code}); original item preserved`,
    );
  });

  const report = reportSchema.parse(JSON.parse(result.stdout));

  if (
    report.operation !== operation ||
    report.bindingSha256 !== selection.bindingSha256
  )
    throw new Error("Protected-store native receipt selection differs");

  return report;
}
