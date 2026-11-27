import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "omnyo-plugin-quiet-notifications",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
