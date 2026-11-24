import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { withFileLock } from "./file-lock.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const absolutePathSchema = z
  .string()
  .refine((value) => isAbsolute(value) && resolve(value) === value);

const bindingSchema = z
  .object({
    migrationId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
    sourceDataDir: absolutePathSchema,
    destinationDataDir: absolutePathSchema,
    sourceDigest: digestSchema,
    destinationDigest: digestSchema,
    artifactDigest: digestSchema,
  })
  .strict();

const journalSchema = z
  .object({
    formatVersion: z.literal(2),
    binding: bindingSchema,
    admission: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export type OmnyoStateBinding = z.infer<typeof bindingSchema>;

type StateAdmissionJournal = z.infer<typeof journalSchema>;

function journalPrefix(binding: OmnyoStateBinding): string {
  return `${JSON.stringify({ formatVersion: 2, binding: bindingSchema.parse(binding) }).slice(0, -1)},"admission":`;
}

function serializeJournal(journal: StateAdmissionJournal): string {
  return `${journalPrefix(journal.binding)}${journal.admission}}\n`;
}

export const omnyoStateAdmissionSchema = z
  .object({
    journalPath: absolutePathSchema,
    binding: bindingSchema,
  })
  .strict();

type StateAdmissionArgs = z.infer<typeof omnyoStateAdmissionSchema>;

function isContainedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);

  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith("../") &&
      !path.startsWith("..\\") &&
      !isAbsolute(path))
  );
}

function validateArgs(args: StateAdmissionArgs): OmnyoStateBinding {
  const parsed = bindingSchema.safeParse(args.binding);

  if (
    !parsed.success ||
    !isAbsolute(args.journalPath) ||
    resolve(args.journalPath) !== args.journalPath
  ) {
    throw new Error("Invalid Omnyo state admission binding");
  }

  const binding = parsed.data;

  if (
    isContainedBy(binding.sourceDataDir, binding.destinationDataDir) ||
    isContainedBy(binding.destinationDataDir, binding.sourceDataDir) ||
    isContainedBy(binding.sourceDataDir, args.journalPath) ||
    isContainedBy(binding.destinationDataDir, args.journalPath)
  ) {
    throw new Error("Omnyo state journal and data roots must be separate");
  }

  return binding;
}

function parseJournal(
  raw: string,
  binding: OmnyoStateBinding,
): StateAdmissionJournal {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Omnyo state admission journal");
  }

  const parsed = journalSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error("Invalid Omnyo state admission journal");
  }

  if (raw !== serializeJournal(parsed.data)) {
    throw new Error("Invalid Omnyo state admission journal frame");
  }

  for (const key of Object.keys(bindingSchema.shape)) {
    if (Reflect.get(parsed.data.binding, key) !== Reflect.get(binding, key)) {
      throw new Error("Omnyo state admission binding does not match");
    }
  }

  return parsed.data;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readJournal(
  args: StateAdmissionArgs,
): Promise<StateAdmissionJournal> {
  return parseJournal(await readFile(args.journalPath, "utf8"), args.binding);
}

async function assertNoSymlink(path: string): Promise<void> {
  let current = path;

  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Omnyo state admission paths cannot traverse symlinks");
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    const parent = dirname(current);

    if (parent === current) return;
    current = parent;
  }
}

async function syncInitialDirectory(journalPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(dirname(journalPath), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function updateAdmission(
  args: StateAdmissionArgs,
  admission: 1 | 2,
): Promise<void> {
  const file = await open(args.journalPath, "r+");

  try {
    const current = parseJournal(await file.readFile("utf8"), args.binding);

    if (current.admission === 2 && admission === 1)
      throw new Error(
        "Omnyo state rollback already selected; write admission refused",
      );

    if (current.admission === 1 && admission === 2)
      throw new Error(
        "Omnyo state writes may have started; use forward repair",
      );
    await syncInitialDirectory(args.journalPath);
    const bytes = Buffer.from(String(admission), "ascii");

    const result = await file.write(
      bytes,
      0,
      1,
      Buffer.byteLength(journalPrefix(args.binding)),
    );

    if (result.bytesWritten !== 1)
      throw new Error("Omnyo state admission byte was not written");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function withAdmissionLock<T>(
  args: StateAdmissionArgs,
  work: () => Promise<T>,
): Promise<T> {
  validateArgs(args);
  await assertNoSymlink(args.journalPath);
  await assertNoSymlink(`${args.journalPath}.lock`);
  await assertNoSymlink(args.binding.sourceDataDir);
  await assertNoSymlink(args.binding.destinationDataDir);
  await mkdir(dirname(args.journalPath), { recursive: true, mode: 0o700 });

  return withFileLock({
    path: `${args.journalPath}.lock`,
    timeoutMs: 5_000,
    work,
  });
}

export async function prepareOmnyoStateAdmission(
  args: StateAdmissionArgs,
): Promise<void> {
  await withAdmissionLock(args, async () => {
    try {
      await readJournal(args);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const file = await open(args.journalPath, "wx", 0o600);

      try {
        await file.writeFile(
          serializeJournal({
            formatVersion: 2,
            binding: args.binding,
            admission: 0,
          }),
          "utf8",
        );
        await file.sync();
      } finally {
        await file.close();
      }
    }

    const file = await open(args.journalPath, "r+");

    try {
      await file.sync();
    } finally {
      await file.close();
    }

    await syncInitialDirectory(args.journalPath);
  });
}

export async function admitOmnyoStateWrites(
  args: StateAdmissionArgs,
): Promise<void> {
  await withAdmissionLock(args, async () => {
    await updateAdmission(args, 1);
  });
}

export function readOmnyoStateAdmission(
  args: StateAdmissionArgs,
): StateAdmissionJournal {
  const binding = validateArgs(args);

  return parseJournal(readFileSync(args.journalPath, "utf8"), binding);
}

export function assertOmnyoStateWriteAdmission(args: StateAdmissionArgs): void {
  const journal = readOmnyoStateAdmission(args);

  if (journal.admission !== 1) {
    throw new Error(
      "Omnyo state writes require durable admission before startup",
    );
  }
}

export function assertOmnyoStateAdmissionPrepared(
  args: StateAdmissionArgs,
): void {
  const journal = readOmnyoStateAdmission(args);

  if (journal.admission === 2) {
    throw new Error(
      "Omnyo state rollback already selected; migration admission refused",
    );
  }
}

export async function selectOmnyoPreWriteRollback(
  args: StateAdmissionArgs,
): Promise<void> {
  await withAdmissionLock(args, async () => {
    await updateAdmission(args, 2);
  });
}
