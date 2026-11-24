import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  parseDataDirEnvValue,
  resolveProdDataDir,
} from "@omnyo/config/runtime";

export function resolveCliDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const homeDir = homedir();
  const configured = env.OMNYO_DATA_DIR;

  return resolve(
    configured === undefined || configured.trim().length === 0
      ? resolveProdDataDir({ homeDir })
      : parseDataDirEnvValue({ homeDir, rawDataDir: configured }),
  );
}
