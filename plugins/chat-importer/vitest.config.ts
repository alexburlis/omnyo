import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "omnyo-plugin-omnyo--chat-importer",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx", "app.test.tsx"],
    }),
  },
});
