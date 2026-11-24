import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SITE_ORIGIN = "https://omnyohq.com";

export default defineConfig(({ command }) => ({
  define: { __SITE_ORIGIN__: JSON.stringify(SITE_ORIGIN) },
  resolve: {
    alias: {
      "@omnyo/plugin-sdk/app": fileURLToPath(
        new URL("./src/plugin-guide/plugin-sdk-app.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    dedupe: [
      "react",
      "react-dom",
      "@hugeicons/react",
      "@hugeicons/core-free-icons",
    ],
  },
  ssr: command === "build" ? { noExternal: true } : {},
  server: {
    allowedHosts: [".localhost", ".ts.net"],
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      server: { entry: "server-entry.ts" },
      router: {
        quoteStyle: "double",
        semicolons: true,
        routeTreeFileHeader: [
          "/* oxlint-disable */",
          "// @ts-nocheck",
          "// noinspection JSUnusedGlobalSymbols",
        ],
      },
    }),
    viteReact(),
  ],
}));
