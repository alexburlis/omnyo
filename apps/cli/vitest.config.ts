import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    env: {
      OMNYO_SERVER_URL: "http://127.0.0.1:49161",
      OMNYO_HOST_DAEMON_PORT: "49162",
      OMNYO_CLI_ERROR_LOG: "0",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@omnyo/cli",
      include: ["src/**/*.test.ts"],
    }),
  },
});
