import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const repositoryRoot = resolve(root, "../../../../..");

const glanceRoot = resolve(
  process.env.ORCA_UI_GLANCE_SOURCE ??
    resolve(repositoryRoot, "../plugins-review/glance"),
);

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
];

export default {
  root,
  cacheDir: resolve(repositoryRoot, "../ui-vite-cache"),
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["source"],
    tsconfigPaths: true,
    alias: [
      { find: "@orca-glance", replacement: glanceRoot },
      { find: /^@\//u, replacement: `${repositoryRoot}/apps/app/src/` },
      ...fixturePackages.map((name) => ({
        find: new RegExp(`^${name.replaceAll("/", "\\/")}$`, "u"),
        replacement: appRequire.resolve(name),
      })),
    ],
  },
  server: { fs: { allow: [repositoryRoot, glanceRoot] }, strictPort: true },
};
