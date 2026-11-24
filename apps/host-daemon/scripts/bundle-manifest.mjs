import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const packageRoot = resolve(scriptsDir, "..");

const workspaceRoot = resolve(packageRoot, "..", "..");

const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("");

export const bundleTargets = [
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "workspace-observer-child.ts"),
    label: "workspace observer child",
    outfile: resolve(packageRoot, "dist", "omnyo-workspace-observer-child.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "workspace-read-child.ts"),
    label: "workspace read child",
    outfile: resolve(packageRoot, "dist", "omnyo-workspace-read-child.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "index.ts"),
    label: "daemon",
    outfile: resolve(packageRoot, "dist", "daemon-bundle.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "provider-bridge-protocol",
      "src",
      "bridge-worker-entry.ts",
    ),
    label: "provider bridge worker",
    outfile: resolve(packageRoot, "dist", "omnyo-provider-bridge-worker.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "plugin-host-worker.ts"),
    label: "plugin host worker",
    outfile: resolve(packageRoot, "dist", "omnyo-plugin-host-worker.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      packageRoot,
      "src",
      "command-handlers",
      "file-search-worker.ts",
    ),
    label: "file search worker",
    outfile: resolve(packageRoot, "dist", "omnyo-file-search-worker.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "process-utils",
      "src",
      "process-launcher-worker.ts",
    ),
    label: "process launcher worker",
    outfile: resolve(packageRoot, "dist", "omnyo-process-launcher-worker.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(workspaceRoot, "apps", "cli", "src", "index.ts"),
    executable: true,
    label: "omnyo cli",
    outfile: resolve(packageRoot, "dist", "omnyo"),

    splitting: true,
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "host-watcher",
      "src",
      "parcel-subprocess",
      "parcel-child-entry.ts",
    ),
    label: "parcel watcher child",
    outfile: resolve(packageRoot, "dist", "omnyo-parcel-watcher-child.mjs"),
  },
];
