import path from "path";
import { parseCLI } from "vitest/node";
import {
  defineWorkspaceTestConfig,
  partitionTestFiles,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { forkablePluginPaths } from "./vite-forkable-plugin-paths.js";
import { cachedReactCompiler } from "./vite-react-compiler.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";

const cli = /^vitest(?:\.[cm]?js)?$/.test(path.basename(process.argv[1] ?? ""))
  ? parseCLI(["vitest", ...process.argv.slice(2)])
  : null;

const filters = cli?.filter ?? [];

const include =
  filters.length > 0 &&
  filters.every(
    (file) =>
      /^(?:src\/.+|vite-web-release)\.test\.tsx?$/.test(file) &&
      !/[*?{}[\]()]/.test(file) &&
      path.posix.normalize(file) === file &&
      file.split("/").every((segment) => !segment.startsWith(".")),
  )
    ? filters
    : ["src/**/*.test.ts", "src/**/*.test.tsx", "vite-web-release.test.ts"];

const aliases = { "@": path.resolve(__dirname, "./src") };

const name = "@omnyo/app";

const workerConfig =
  !cli?.options.project &&
  include === filters &&
  partitionTestFiles(__dirname, include, { aliases }).shared.every(
    (group) => group.files.length === 1,
  )
    ? { name, include, isolate: true }
    : {
        projects: sharedWorkerProjects({
          pkgDir: __dirname,
          aliases,
          name,
          include,
        }),
      };

export default defineWorkspaceTestConfig({
  plugins: [
    forkablePluginPaths(path.resolve(__dirname, "./src")),
    sharedUiEnvSeam(),
    react(),
    cachedReactCompiler(),
    tailwindcss(),
  ],
  resolve: {
    alias: aliases,
  },
  test: {
    experimental: { fsModuleCache: true },
    silent: "passed-only",
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 15_000,
    ...workerConfig,
  },
});
