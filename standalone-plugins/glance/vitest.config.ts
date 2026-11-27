import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    projects: [
      {
        test: {
          name: "server",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 15000,
        },
      },
      {
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
