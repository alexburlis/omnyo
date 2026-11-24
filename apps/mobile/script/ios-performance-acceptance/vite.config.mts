import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedViteConfig } from "../../../app/vite.config.js";

const root = new URL("./fixture/", import.meta.url);

const fixtureRoot = fileURLToPath(root);

const fixtureOutput = fileURLToPath(new URL("./FixtureDist/", import.meta.url));

const plugins = (await Promise.all(sharedViteConfig.plugins)).flat();

export default {
  ...sharedViteConfig,
  root: fixtureRoot,
  base: "./",
  plugins: plugins.filter(
    (plugin) =>
      plugin.name.startsWith("vite:react") ||
      plugin.name.startsWith("@tailwindcss/vite"),
  ),
  build: {
    ...sharedViteConfig.build,
    outDir: resolve(fixtureOutput),
    emptyOutDir: true,
    reportCompressedSize: false,
  },
  optimizeDeps: { include: [] },
  resolve: {
    ...sharedViteConfig.resolve,
    alias: {
      ...sharedViteConfig.resolve.alias,
      react: fileURLToPath(
        new URL("../../../app/node_modules/react", import.meta.url),
      ),
      "react-dom": fileURLToPath(
        new URL("../../../app/node_modules/react-dom", import.meta.url),
      ),
      jotai: fileURLToPath(
        new URL("../../../app/node_modules/jotai", import.meta.url),
      ),
    },
  },
};
