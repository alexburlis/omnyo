import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    testTimeout: 10000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "omnyo-plugin-omnyo--account-usage",
      include: ["**/*.{test,spec}.{ts,tsx}"],
    }),
  },
});
