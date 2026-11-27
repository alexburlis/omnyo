import { open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  commandReceiptSchema,
  commandSpecSchema,
  type CommandReceipt,
  type CommandSpec,
} from "../contracts/host.js";

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);

  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(temp, path);
}

export async function readSpec(directory: string): Promise<CommandSpec> {
  return commandSpecSchema.parse(JSON.parse(await readFile(join(directory, "spec.json"), "utf8")));
}

export async function readReceipt(directory: string): Promise<CommandReceipt | null> {
  try {
    return commandReceiptSchema.parse(
      JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readLog(directory: string, cursor: number, limit: number) {
  try {
    const path = join(directory, "output.log");
    const size = (await stat(path)).size;
    const file = await open(path, "r");

    try {
      const bytes = Buffer.alloc(Math.min(limit, Math.max(0, size - cursor)));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, cursor);

      return {
        text: bytes.subarray(0, bytesRead).toString("utf8"),
        nextCursor: cursor + bytesRead,
        truncated: cursor + bytesRead < size,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { text: "", nextCursor: cursor, truncated: false };
    throw error;
  }
}
