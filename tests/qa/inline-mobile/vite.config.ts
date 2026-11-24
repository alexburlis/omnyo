import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const repositoryRoot = resolve(root, "../../..");

const appRequire = createRequire(
  resolve(repositoryRoot, "apps/app/package.json"),
);

const { default: react } = await import(
  appRequire.resolve("@vitejs/plugin-react")
);

const { default: tailwindcss } = await import(
  appRequire.resolve("@tailwindcss/vite")
);

const fixturePackages = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "react-router-dom",
  "@tanstack/react-query",
];

export default {
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["source"],
    tsconfigPaths: true,
    alias: [
      ...fixturePackages.map((name) => ({
        find: new RegExp(`^${name.replaceAll("/", "\\/")}$`),
        replacement: appRequire.resolve(name),
      })),
    ],
  },
  server: { fs: { allow: [repositoryRoot] }, strictPort: true },
};
