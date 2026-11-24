import path from "node:path";
import { parseCLI } from "vitest/node";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
import { omnyoTestOptIn } from "./package.json";

const filters = /^vitest(?:\.[cm]?js)?$/.test(
  path.basename(process.argv[1] ?? ""),
)
  ? parseCLI(["vitest", ...process.argv.slice(2)]).filter
  : [];

const include =
  filters.length > 0 &&
  filters.every(
    (file) =>
      /^(?:src|test)\/.+\.test\.ts$/.test(file) &&
      !/[*?{}[\]()]/.test(file) &&
      path.posix.normalize(file) === file &&
      file.split("/").every((segment) => !segment.startsWith(".")),
  )
    ? filters
    : ["src/**/*.test.ts", "test/**/*.test.ts"];

export default defineWorkspaceTestConfig({
  test: {
    experimental: { fsModuleCache: true },
    silent: "passed-only",
    testTimeout: 15_000,
    setupFiles: [
      "test/setup/stored-event-decode-freeze.ts",
      "test/setup/warm-test-harness.ts",
    ],
    env: {
      OMNYO_DATA_DIR: "/tmp/omnyo-server-test",
      OMNYO_SERVER_PORT: "49161",
      OMNYO_HOST_DAEMON_PORT: "49162",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@omnyo/server",
      include,
      exclude: [
        "dist/**",
        "node_modules/**",
        ...omnyoTestOptIn.flatMap((path) =>
          process.argv.some(
            (argument) =>
              argument === path ||
              argument === path.slice(path.lastIndexOf("/") + 1) ||
              argument.startsWith(path + "/") ||
              argument.endsWith("/" + path),
          )
            ? []
            : [path, path + "/**"],
        ),
      ],
    }),
  },
});
