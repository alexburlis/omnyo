import { join, resolve } from "node:path";

export const PI_BRIDGE_SESSION_DIR_ENV = "OMNYO_PI_BRIDGE_SESSION_DIR";

const PI_BRIDGE_SESSION_DIR_NAME = "pi-bridge-sessions";

interface ResolvePiBridgeSessionDirArgs {
  env: NodeJS.ProcessEnv;
  bridgeDataDir: string | null;
}

interface ResolvePiSessionFilePathArgs extends ResolvePiBridgeSessionDirArgs {
  threadId: string;
}

export function resolvePiBridgeSessionDir(
  args: ResolvePiBridgeSessionDirArgs,
): string {
  const configuredSessionDir = args.env[PI_BRIDGE_SESSION_DIR_ENV]?.trim();

  if (configuredSessionDir) {
    return resolve(configuredSessionDir);
  }

  if (args.bridgeDataDir === null) {
    throw new Error(
      `Pi bridge session directory is unavailable: the bridge has not started and ${PI_BRIDGE_SESSION_DIR_ENV} is unset`,
    );
  }

  return join(args.bridgeDataDir, PI_BRIDGE_SESSION_DIR_NAME);
}

export function resolvePiSessionFilePath(
  args: ResolvePiSessionFilePathArgs,
): string {
  return join(
    resolvePiBridgeSessionDir({
      env: args.env,
      bridgeDataDir: args.bridgeDataDir,
    }),
    `${sanitizeSessionKey(args.threadId)}.jsonl`,
  );
}

function sanitizeSessionKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}
