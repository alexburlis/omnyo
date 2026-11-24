import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: "/origin-adoption-v1/",
  publicDir: false,
  build: {
    target: "es2020",
    manifest: true,
    sourcemap: false,
    reportCompressedSize: false,
    rolldownOptions: { input: resolve(root, "origin-adoption-v1.html") },
  },
});
