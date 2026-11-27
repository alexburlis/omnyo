import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "omnyo-plugin-inline-ui",
    include: ["*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
