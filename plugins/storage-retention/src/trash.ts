import fs from "node:fs/promises";
import path from "node:path";
import { isFsErrorWithCode } from "./fs-errors.js";

const removing = new Set<string>();

async function allowOwnerRemoval(directory: string): Promise<void> {
  try {
    const stats = await fs.lstat(directory);

    if (!stats.isDirectory()) return;

    if ((stats.mode & 0o700) !== 0o700)
      await fs.chmod(directory, (stats.mode & 0o7777) | 0o700);

    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory())
        await allowOwnerRemoval(path.join(directory, entry.name));
  } catch (error) {
    if (
      !isFsErrorWithCode(error, "ENOENT") &&
      !isFsErrorWithCode(error, "EACCES") &&
      !isFsErrorWithCode(error, "EPERM")
    )
      throw error;
  }
}

async function removeTrash(trash: string) {
  try {
    await fs.rm(trash, { recursive: true, force: true });
  } catch (error) {
    if (
      process.platform === "win32" ||
      (!isFsErrorWithCode(error, "EACCES") &&
        !isFsErrorWithCode(error, "EPERM"))
    )
      throw error;

    await allowOwnerRemoval(trash);
    await fs.rm(trash, { recursive: true, force: true });
  }
}

export function removeTrashInBackground(
  trashes: string[],
  retainWorker: () => { dispose(): void },
  failureMessage: string,
) {
  const claimed = [...new Set(trashes)].filter((trash) => !removing.has(trash));

  if (claimed.length === 0) return;

  const lease = retainWorker();

  for (const trash of claimed) removing.add(trash);

  void (async () => {
    for (const trash of claimed)
      try {
        await removeTrash(trash);
      } catch (error) {
        console.error(failureMessage, error);
      } finally {
        removing.delete(trash);
      }
  })().finally(() => lease.dispose());
}
