import type { HostDaemonEntrypointConfig } from "@omnyo/config/host-daemon-entrypoint";

export interface HostDaemonRuntimeEnvironment extends HostDaemonEntrypointConfig {
  OMNYO_DATA_DIR: string;
  OMNYO_HOST_DAEMON_PORT: string;
  OMNYO_SERVER_URL: string;
  NODE_ENV: "development" | "production";
}

export function toHostDaemonProcessEnv(
  environment: HostDaemonRuntimeEnvironment,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      continue;
    }

    env[key] = typeof value === "boolean" ? (value ? "1" : "0") : value;
  }

  return env;
}
