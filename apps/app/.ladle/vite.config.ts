import path from "path";
import { tsImport } from "tsx/esm/api";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { forkablePluginPaths } from "../vite-forkable-plugin-paths.js";
import { sharedUiEnvSeam } from "../vite-shared-ui-seam.js";

const repoRoot = path.resolve(__dirname, "../../..");

const runtime: typeof import("@omnyo/config/runtime") = await tsImport(
  "@omnyo/config/runtime",
  import.meta.url,
);

const devInstance = runtime.resolveCurrentDevInstanceConfig(repoRoot);

const trustedDevAppHeaders = {
  origin: devInstance.serverUrl,
};

export default defineConfig({
  plugins: [
    forkablePluginPaths(path.resolve(__dirname, "../src")),
    sharedUiEnvSeam(),
    tailwindcss(),
  ],
  cacheDir: "node_modules/.vite/ladle",
  build: { target: "esnext" },
  worker: {
    format: "es",
  },
  resolve: {
    conditions: ["source"],
    dedupe: ["react", "react-dom"],
    alias: {
      "@omnyo/plugin-sdk/app": path.resolve(__dirname, "./plugin-sdk-app.ts"),
      "@": path.resolve(__dirname, "../src"),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        "process.env.NODE_ENV": '"development"',
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        headers: trustedDevAppHeaders,
      },
      "/ws": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        ws: true,
        headers: trustedDevAppHeaders,
      },
    },
  },
});
