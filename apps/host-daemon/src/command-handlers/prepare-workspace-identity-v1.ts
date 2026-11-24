import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "@omnyo/config/file-lock";
import { workspaceStatePathsV1 } from "@omnyo/config/skill-storage-paths";
import {
  moveWindowsStateDirectoryNoReplace,
  writeJsonFileAtomically,
} from "@omnyo/server-archive";
import type { RuntimeManager } from "../runtime-manager.js";

const identitySchema = z
  .object({ device: z.string(), inode: z.string() })
  .strict();

const journalSchema = z
  .object({
    version: z.literal(1),
    workspacePath: z.string(),
    source: identitySchema,
    phase: z.enum(["prepared", "adopted"]),
  })
  .strict();

async function directoryIdentity(target: string) {
  try {
    const info = await lstat(target, { bigint: true });

    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Workspace identity refuses a linked or non-directory root",
      );

    return { device: info.dev.toString(), inode: info.ino.toString() };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function readJournal(target: string) {
  try {
    const info = await lstat(target);

    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Workspace identity journal is not an ordinary file");

    return journalSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function sameIdentity(
  left: z.infer<typeof identitySchema> | null,
  right: z.infer<typeof identitySchema>,
): boolean {
  return left !== null && left.inode === right.inode;
}

async function syncDirectory(target: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(target, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareWorkspaceIdentityV1(args: {
  rootPath: string;
  dataDir: string;
  admission: Pick<RuntimeManager, "withWorkspaceIdentityAdmission">;
}): Promise<{ status: "current" | "adopted"; rootPath: string }> {
  const rootPath = await realpath(args.rootPath);
  const paths = workspaceStatePathsV1(rootPath);
  const key = createHash("sha256").update(rootPath).digest("hex");
  const jobsRoot = join(args.dataDir, "workspace-identity-v1");
  const journalPath = join(jobsRoot, key + ".json");

  if ((await realpath(args.dataDir)) !== args.dataDir)
    throw new Error(
      "Workspace identity requires its exact existing host data owner",
    );
  await directoryIdentity(jobsRoot);

  const [source, destination, prior] = await Promise.all([
    directoryIdentity(paths.legacyRootPath),
    directoryIdentity(paths.rootPath),
    readJournal(journalPath),
  ]);

  if (source !== null && destination !== null)
    throw new Error(
      "Workspace identity collision; preserve both populated roots",
    );

  if (source === null && prior === null)
    return { status: "current", rootPath: paths.rootPath };

  if (source === null && prior?.phase === "adopted") {
    if (prior.workspacePath !== rootPath)
      throw new Error(
        "Workspace identity journal belongs to another workspace",
      );

    return { status: "adopted", rootPath: paths.rootPath };
  }

  return args.admission.withWorkspaceIdentityAdmission(rootPath, async () => {
    await mkdir(jobsRoot, { recursive: true, mode: 0o700 });

    return withFileLock({
      path: join(jobsRoot, key + ".lock"),
      timeoutMs: 5000,
      work: async () => {
        let journal = await readJournal(journalPath);

        const [before, after] = await Promise.all([
          directoryIdentity(paths.legacyRootPath),
          directoryIdentity(paths.rootPath),
        ]);

        if (before !== null && after !== null)
          throw new Error("Workspace identity collision; preserve both roots");

        if (journal === null) {
          if (before === null || after !== null)
            throw new Error(
              "Workspace identity source changed before preparation",
            );
          journal = {
            version: 1,
            workspacePath: rootPath,
            source: before,
            phase: "prepared",
          };
          await writeJsonFileAtomically(journalPath, journal, true);
          await syncDirectory(jobsRoot);
        }

        if (journal.workspacePath !== rootPath)
          throw new Error(
            "Workspace identity journal belongs to another workspace",
          );

        if (before === null) {
          if (!sameIdentity(after, journal.source))
            throw new Error(
              "Workspace identity destination changed after preparation",
            );
        } else {
          if (
            journal.phase !== "prepared" ||
            !sameIdentity(before, journal.source) ||
            after !== null
          )
            throw new Error(
              "Workspace identity source or destination no longer matches its prepared owner",
            );

          if (process.platform === "win32")
            await moveWindowsStateDirectoryNoReplace(
              paths.legacyRootPath,
              paths.rootPath,
              { ownerKey: "workspace:" + key },
            );
          else {
            await syncDirectory(paths.legacyRootPath);
            await rename(paths.legacyRootPath, paths.rootPath);
            await syncDirectory(rootPath);
          }
        }

        if (
          (await directoryIdentity(paths.legacyRootPath)) !== null ||
          !sameIdentity(await directoryIdentity(paths.rootPath), journal.source)
        )
          throw new Error(
            "Workspace identity move lacks its exact completed directory owner",
          );
        await writeJsonFileAtomically(journalPath, {
          ...journal,
          phase: "adopted",
        });
        await syncDirectory(jobsRoot);

        return { status: "adopted", rootPath: paths.rootPath };
      },
    });
  });
}
