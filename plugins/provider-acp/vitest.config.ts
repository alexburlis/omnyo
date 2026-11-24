import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "omnyo-plugin-provider-acp",
    include: ["*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
