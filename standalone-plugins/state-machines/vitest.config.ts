import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "runtime",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 20000,
        },
      },
      {
        test: {
          name: "ui",
          include: ["tests/**/*.test.tsx"],
          environment: "jsdom",
          testTimeout: 20000,
        },
      },
    ],
  },
});
