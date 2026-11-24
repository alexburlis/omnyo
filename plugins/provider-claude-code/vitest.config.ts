import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "omnyo-plugin-provider-claude-code",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
