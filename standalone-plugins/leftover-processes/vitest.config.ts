import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

export default defineConfig({
  resolve: { alias, dedupe: ["react", "react-dom"] },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "server",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
      {
        resolve: { alias, dedupe: ["react", "react-dom"] },
        test: {
          name: "ui",
          include: ["tests/**/*.test.tsx"],
          environment: "jsdom",
          testTimeout: 15000,
        },
      },
    ],
  },
});
