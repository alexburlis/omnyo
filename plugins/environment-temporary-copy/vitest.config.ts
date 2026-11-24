import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "omnyo-plugin-environment-temporary-copy",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 60_000,
  },
});
