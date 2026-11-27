import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { decodeSkillPack, type PackArtifact } from "./pack-encoding.ts";
import { packDigestSchema, type SkillPack } from "./pack.ts";

const claimSchema = z.object({ id: z.string(), directory: z.string() }).strict();

const journalSchema = z
  .object({
    digest: packDigestSchema,
    receipt: z.uuid(),
    status: z.enum(["pending", "installed"]),
    claims: z.array(claimSchema).max(40),
  })
  .strict();

type Journal = z.infer<typeof journalSchema>;

type Skill = SkillPack["skills"][number];

type Destination =
  | { destination: "available"; receipt: null }
  | { destination: "recoverable" | "installed"; receipt: string };

export type PackDestination = Destination & { workspaceIdentity: string };

interface Location {
  workspaceIdentity: string;
  skillsRoot: string;
  journalRoot: string;
  journalFile: string;
}

const installing = new Set<string>();

const fsError = z.object({ code: z.string() });

async function stat(file: string): Promise<Stats | null> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (fsError.safeParse(error).data?.code === "ENOENT") return null;
    throw error;
  }
}

function identity(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

async function safeDirectory(directory: string, create: boolean): Promise<Stats | null> {
  let info = await stat(directory);

  if (info === null && create) {
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if (fsError.safeParse(error).data?.code !== "EEXIST") throw error;
    }

    info = await stat(directory);
  }

  if (info !== null && !info.isDirectory()) {
    throw new Error(`Skill pack destination must be a regular directory: ${directory}`);
  }

  return info;
}

async function locate(workspacePath: string, pack: SkillPack, create: boolean): Promise<Location> {
  if (!path.isAbsolute(workspacePath)) throw new Error("Select an absolute workspace directory.");

  if ((await safeDirectory(workspacePath, false)) === null) {
    throw new Error("The selected workspace is unavailable.");
  }

  const workspace = await fs.realpath(workspacePath);
  const workspaceStat = await safeDirectory(workspace, false);

  if (!workspaceStat) throw new Error("The selected workspace is unavailable.");

  const root = path.join(workspace, ".omnyo");
  const skillsRoot = path.join(root, "skills");
  const journalRoot = path.join(root, "skill-packs");

  if (await safeDirectory(root, create)) {
    await Promise.all([safeDirectory(skillsRoot, create), safeDirectory(journalRoot, create)]);
  }

  const key = createHash("sha256").update(`${pack.publisher}/${pack.slug}`).digest("hex");

  const workspaceIdentity = createHash("sha256")
    .update(JSON.stringify([workspace, identity(workspaceStat)]))
    .digest("hex");

  return {
    workspaceIdentity,
    skillsRoot,
    journalRoot,
    journalFile: path.join(journalRoot, `${key}.json`),
  };
}

async function readFile(file: string, maximum: number): Promise<Buffer> {
  const info = await stat(file);

  if (info !== null && !info.isFile())
    throw new Error("Unexpected file in skill pack destination.");

  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.size > maximum)
      throw new Error("Unexpected file in skill pack destination.");

    const result = Buffer.alloc(maximum + 1);
    let length = 0;

    while (length < result.length) {
      const read = await handle.read(result, length, result.length - length, null);

      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }

    if (length > maximum) throw new Error("Unexpected file in skill pack destination.");

    return result.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function loadJournal(location: Location): Promise<Journal | null> {
  try {
    const buffer = await readFile(location.journalFile, 8192);

    return journalSchema.parse(JSON.parse(buffer.toString("utf8")));
  } catch (error) {
    if (fsError.safeParse(error).data?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJournal(
  location: Location,
  journal: Journal,
  mode: "create" | "advance",
): Promise<void> {
  const temporary = path.join(location.journalRoot, `.journal-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);

  try {
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (mode === "create") {
      await fs.link(temporary, location.journalFile);

      return;
    }

    const current = await loadJournal(location);

    if (current?.receipt !== journal.receipt || current.status !== "pending") {
      throw new Error("The skill pack receipt changed. Review the workspace again.");
    }

    await fs.rename(temporary, location.journalFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function concurrentChange(skillId: string): Error {
  return new Error(
    `Skill "${skillId}" already exists or was edited in this workspace. Omnyo left it unchanged.`,
  );
}

async function checkedFiles(root: string, skill: Skill): Promise<Set<string>> {
  const files = new Map(skill.files.map((file) => [file.path, file.content]));
  const directories = new Set<string>();

  for (const file of files.keys()) {
    const segments = file.split("/");

    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const present = new Set<string>();

  async function walk(directory: string, prefix: string): Promise<void> {
    if (!(await safeDirectory(directory, false))) throw concurrentChange(skill.id);

    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const file = path.join(directory, entry.name);

      if (entry.isDirectory() && directories.has(name)) {
        await walk(file, name + "/");
        continue;
      }

      const expected = files.get(name);

      if (!entry.isFile() || expected === undefined) throw concurrentChange(skill.id);

      const bytes = Buffer.from(expected, "utf8");

      const actual = await readFile(file, bytes.byteLength).catch(() => {
        throw concurrentChange(skill.id);
      });

      if (!actual.equals(bytes)) throw concurrentChange(skill.id);

      present.add(name);
    }
  }

  await walk(root, "");

  if (present.has("SKILL.md") && present.size !== files.size) throw concurrentChange(skill.id);

  return present;
}

async function inspect(
  location: Location,
  pack: SkillPack,
  digest: string,
  verifyComplete = false,
): Promise<PackDestination & { journal: Journal | null }> {
  const journal = await loadJournal(location);

  if (journal !== null && journal.digest !== digest) {
    throw new Error(
      "A different revision of this skill pack is installed or pending. Its files were left unchanged.",
    );
  }

  const contents = (await safeDirectory(location.skillsRoot, false))
    ? await fs.readdir(location.skillsRoot)
    : [];

  const existing = new Set(contents.map((entry) => entry.toLowerCase()));

  for (const skill of pack.skills) {
    const claim = journal?.claims.find((entry) => entry.id === skill.id);

    if (!claim) {
      if (existing.has(skill.id) || journal?.status === "installed" || verifyComplete) {
        throw concurrentChange(skill.id);
      }

      continue;
    }

    const directory = path.join(location.skillsRoot, skill.id);
    const current = await safeDirectory(directory, false);

    if (!current || identity(current) !== claim.directory) throw concurrentChange(skill.id);

    const files = await checkedFiles(directory, skill);

    if ((journal?.status === "installed" || verifyComplete) && files.size !== skill.files.length) {
      throw concurrentChange(skill.id);
    }
  }

  if (!journal)
    return {
      destination: "available",
      receipt: null,
      workspaceIdentity: location.workspaceIdentity,
      journal,
    };

  return {
    destination: journal.status === "installed" ? "installed" : "recoverable",
    receipt: journal.receipt,
    workspaceIdentity: location.workspaceIdentity,
    journal,
  };
}

export async function inspectPackDestination(args: {
  workspacePath: string;
  artifact: PackArtifact;
}): Promise<PackDestination> {
  const pack = decodeSkillPack(args.artifact);
  const location = await locate(args.workspacePath, pack, false);

  const { destination, receipt, workspaceIdentity } = await inspect(
    location,
    pack,
    args.artifact.digest,
  );

  return destination === "available"
    ? { destination, receipt: null, workspaceIdentity }
    : { destination, receipt, workspaceIdentity };
}

async function writeNewFile(args: {
  directory: string;
  journalRoot: string;
  file: Skill["files"][number];
}): Promise<void> {
  const segments = args.file.path.split("/");
  const name = segments.pop();
  let directory = args.directory;

  for (const segment of segments) {
    directory = path.join(directory, segment);
    await safeDirectory(directory, true);
  }

  const temporary = path.join(args.journalRoot, `.file-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o644);

  try {
    try {
      await handle.writeFile(args.file.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (name === undefined) throw new Error("Missing skill file name");

    await fs.link(temporary, path.join(directory, name));
  } finally {
    await fs.unlink(temporary);
  }
}

export async function installPackFiles(args: {
  workspacePath: string;
  workspaceIdentity: string;
  artifact: PackArtifact;
  signal?: AbortSignal;
}): Promise<{ receipt: string }> {
  const pack = decodeSkillPack(args.artifact);
  const location = await locate(args.workspacePath, pack, false);

  if (args.workspaceIdentity !== location.workspaceIdentity) {
    throw new Error("The selected workspace changed. Review the pack again.");
  }

  if (installing.has(location.workspaceIdentity)) {
    throw new Error("Another skill pack installation is in progress. Try again once it finishes.");
  }

  installing.add(location.workspaceIdentity);

  try {
    const current = await inspect(location, pack, args.artifact.digest);

    if (current.destination === "installed") return { receipt: current.receipt };

    args.signal?.throwIfAborted();

    const prepared = await locate(args.workspacePath, pack, true);

    if (prepared.workspaceIdentity !== location.workspaceIdentity) {
      throw new Error("The selected workspace changed. Review the pack again.");
    }

    const journal: Journal = current.journal ?? {
      digest: args.artifact.digest,
      receipt: randomUUID(),
      status: "pending",
      claims: [],
    };

    if (current.journal === null) await writeJournal(location, journal, "create");

    for (const skill of pack.skills) {
      const directory = path.join(location.skillsRoot, skill.id);

      if (!journal.claims.some((claim) => claim.id === skill.id)) {
        try {
          await fs.mkdir(directory);
        } catch (error) {
          if (fsError.safeParse(error).data?.code === "EEXIST") throw concurrentChange(skill.id);
          throw error;
        }

        const info = await safeDirectory(directory, false);

        if (!info) throw concurrentChange(skill.id);

        journal.claims.push({ id: skill.id, directory: identity(info) });
        await writeJournal(location, journal, "advance");
      }

      const present = await checkedFiles(directory, skill);

      const ordered = [...skill.files].sort(
        (a, b) => Number(a.path === "SKILL.md") - Number(b.path === "SKILL.md"),
      );

      for (const file of ordered) {
        args.signal?.throwIfAborted();

        if (!present.has(file.path)) {
          await writeNewFile({ directory, journalRoot: location.journalRoot, file });
        }
      }
    }

    await inspect(location, pack, args.artifact.digest, true);
    await writeJournal(location, { ...journal, status: "installed" }, "advance");

    return { receipt: journal.receipt };
  } finally {
    installing.delete(location.workspaceIdentity);
  }
}
