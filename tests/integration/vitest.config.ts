import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

const parsedTimeoutScale = Number(process.env.OMNYO_TEST_TIMEOUT_SCALE ?? 1);

const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

export default defineWorkspaceTestConfig({
  test: {
    hookTimeout: Math.ceil(60_000 * timeoutScale),
    env: {
      OMNYO_DATA_DIR: "/tmp/omnyo-integration-test",
      OMNYO_SERVER_PORT: "49161",
      OMNYO_SERVER_URL: "http://127.0.0.1:49161",
      OMNYO_HOST_DAEMON_PORT: "49162",
      SCRIPTED_ECHO_OPTIONS: JSON.stringify({ uniqueProviderThreadIds: true }),
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "tag.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
    },
    globalSetup: ["./global-setup.ts"],
    silent: "passed-only",
    testTimeout: Math.ceil(60_000 * timeoutScale),
    projects: [
      ...sharedWorkerProjects({
        pkgDir: __dirname,
        name: "@omnyo/integration-tests",
        include: ["fake/**/*.test.ts"],
      }),
      {
        extends: true,
        test: {
          name: "@omnyo/integration-tests:native-roots-golden",
          include: ["native-roots-golden/**/*.test.ts"],
        },
      },
    ],
  },
});
