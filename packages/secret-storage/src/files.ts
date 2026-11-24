import { randomBytes } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function writePrivateTemp(
  targetPath: string,
  content: string,
): Promise<string> {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  const handle = await open(tempPath, "wx", 0o600);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }

  await handle.close();

  return tempPath;
}

export async function createFileExclusive(
  path: string,
  content: string,
): Promise<boolean> {
  const tempPath = await writePrivateTemp(path, content);

  try {
    await link(tempPath, path);

    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function replaceFileAtomic(
  path: string,
  content: string,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const tempPath = await writePrivateTemp(path, content);

  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
