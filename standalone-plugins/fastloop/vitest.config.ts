import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 1000,
    hookTimeout: 1000,
    maxWorkers: 1,
  },
});
