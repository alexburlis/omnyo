import { fileURLToPath } from "node:url";
import { buildPluginApp } from "../../packages/plugin-build/src/build-plugin-app.ts";
import { resolvePluginBuildToolchain } from "../../packages/plugin-build/src/toolchain.ts";

const plugin = fileURLToPath(
  new URL("../../plugins/thread-list/", import.meta.url),
);

const cache = fileURLToPath(
  new URL(
    "../../packages/plugin-build/node_modules/.omnyo-toolchain/",
    import.meta.url,
  ),
);

await buildPluginApp(
  plugin,
  "bundled",
  await resolvePluginBuildToolchain(cache),
);
