import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_ID_FILE_NAME } from "@omnyo/host-daemon-contract";

interface ReadPrimaryHostIdArgs {
  dataDir: string;
}

export function readPrimaryHostIdFromDataDir(
  args: ReadPrimaryHostIdArgs,
): string | null {
  try {
    const value = readFileSync(
      join(args.dataDir, HOST_ID_FILE_NAME),
      "utf8",
    ).trim();

    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
