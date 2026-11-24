import { join } from "node:path";

export function createPublicBetaEnvironment(
  profilePath: string,
): NodeJS.ProcessEnv {
  return {
    OMNYO_DESKTOP_RELEASE_CHANNEL: "public-beta",
    OMNYO_DATA_DIR: join(profilePath, "local-instance"),
    OMNYO_SERVER_PORT: "47431",
    OMNYO_HOST_DAEMON_PORT: "47434",
    OMNYO_SERVER_BIND_HOST: "127.0.0.1",
    OMNYO_TELEMETRY: "false",
    OMNYO_POSTHOG_API_KEY: "",
    OMNYO_SENTRY_DSN: "",
    OMNYO_DESKTOP_APP_URL: "",
  };
}
