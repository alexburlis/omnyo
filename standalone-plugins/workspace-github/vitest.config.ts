import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
  resolve: { alias: { "@": import.meta.dirname } },
});
