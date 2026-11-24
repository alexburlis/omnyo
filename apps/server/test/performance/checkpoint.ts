import { rename, writeFile } from "node:fs/promises";

export async function writeCheckpoint(
  path: string,
  value: string,
): Promise<void> {
  const pending = path + ".pending";
  await writeFile(pending, value);
  await rename(pending, path);
}
