import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@omnyo/plugin-sdk",
      include: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "scripts/**/*.test.mjs",
      ],
    }),
  },
});
