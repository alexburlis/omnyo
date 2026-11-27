import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { z } from "zod";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function outputJson<Schema extends z.ZodType>(
  schema: Schema,
  output: string,
): z.output<Schema> {
  const starts = [0];

  for (let index = 0; index < output.length; index++)
    if (output[index] === "\n" && ["{", "["].includes(output[index + 1] ?? ""))
      starts.push(index + 1);

  for (const start of starts.reverse()) {
    try {
      return schema.parse(JSON.parse(output.slice(start)));
    } catch {}
  }

  throw new Error("The operation returned no complete JSON receipt");
}

export async function optionalJson<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
): Promise<z.output<Schema> | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function ownedFile(root: string, name: string): Promise<string> {
  if (isAbsolute(name) || name.split(/[\\/]/u).includes(".."))
    throw new Error("Expected an owned repository-relative evidence path");
  const path = await realpath(join(root, name));
  const within = relative(await realpath(root), path);

  if (within.startsWith("..") || isAbsolute(within))
    throw new Error("Evidence escaped its repository");

  return path;
}
