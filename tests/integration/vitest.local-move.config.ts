import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    silent: "passed-only",
    projects: [
      {
        extends: true,
        test: {
          name: "@omnyo/integration-tests:local-server-move",
          fileParallelism: false,
          isolate: true,
          globalSetup: [],
          include: ["fake/server-move/local-preparation*.test.ts"],
        },
      },
    ],
  },
});
