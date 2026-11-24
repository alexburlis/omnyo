import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { hasErrorCode } from "./errors.js";
import { replaceWindowsStateFile } from "@omnyo/config/windows-state-file";

export async function readPrivateJsonFileText(
  path: string,
): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });

  if (file === null) return null;

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      (process.getuid !== undefined &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw new Error("JSON receipt is not an ordinary private owned file");

    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function readJsonFileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

export function parseJsonText(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON at ${path}`, { cause: error });
  }
}

export async function readJsonFile<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  const text = await readJsonFileText(path);

  if (text === null) {
    return null;
  }

  const parsed = schema.safeParse(parseJsonText(path, text));

  if (!parsed.success) {
    throw new Error(`Invalid ${path}: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }

  return parsed.data;
}

export async function writeJsonFileAtomically(
  path: string,
  value: unknown,
  exclusive = false,
  mode = 0o600,
): Promise<void> {
  await writeTextFileAtomically(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    exclusive,
    mode,
  );
}

export async function writeTextFileAtomically(
  path: string,
  value: string,
  exclusive = false,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    const file = await open(tempPath, "wx", mode);

    try {
      if (process.platform === "win32")
        await replaceWindowsStateFile(tempPath, path, exclusive, "prepare");
      await file.writeFile(value, "utf8");
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }

    if (process.platform === "win32") {
      await replaceWindowsStateFile(tempPath, path, exclusive);

      return;
    }

    if (exclusive) {
      await link(tempPath, path);
      await rm(tempPath);
    } else await rename(tempPath, path);
    const parent = await open(dirname(path), "r");

    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
