import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { bundleStats } from "./vite-bundle-stats.js";
import { splitPrefetch } from "./vite-split-prefetch.js";
import { routeModulePreload } from "./vite-route-modulepreload.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";
import { cachedReactCompiler } from "./vite-react-compiler.js";
import { cssDependencyChunkHash } from "./vite-css-dependency-hash.js";
import { startupChunks } from "./vite-startup-chunks.js";
import { webReleaseIdentity } from "./vite-web-release.js";

const appDir = dirname(fileURLToPath(import.meta.url));

export const sharedViteConfig = {
  plugins: [
    sharedUiEnvSeam(),
    react(),
    cachedReactCompiler(),
    tailwindcss(),
    cssDependencyChunkHash(),
    startupChunks(),
    bundleStats(),
    routeModulePreload("src/views/SplitWorkspaceRoute.tsx", [
      "src/lib/plugin-frontend.ts",
    ]),
    splitPrefetch(),
    webReleaseIdentity(appDir),
  ],
  cacheDir: "node_modules/.vite/app",
  build: {
    chunkImportMap: true,
    reportCompressedSize: false,
    assetsInlineLimit: (filePath) =>
      filePath.includes("/workspace-open-target-icons/") ? false : undefined,
    rolldownOptions: {
      input: {
        app: resolve(appDir, "index.html"),
        originAdoption: resolve(appDir, "origin-adoption-v1.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/xterm"],
  },
  resolve: {
    conditions: ["source"],
    alias: {
      "@": resolve(appDir, "./src"),
    },
  },
} satisfies UserConfig;

export default defineConfig(sharedViteConfig);
