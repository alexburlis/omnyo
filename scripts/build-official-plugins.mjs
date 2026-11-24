import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pluginPackageJsonSchema } from "../packages/domain/src/plugin-manifest.ts";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "../packages/plugin-build/src/index.ts";
import { OFFICIAL_PLUGINS } from "../apps/server/src/services/plugins/builtin-registry.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

const officialNames = OFFICIAL_PLUGINS.map((plugin) => plugin.name);

const requested = process.argv.slice(2);

const selected =
  requested.length === 0 || requested.includes("all")
    ? officialNames
    : requested;

const toolchain = await resolvePluginBuildToolchain(
  resolve(repositoryRoot, "node_modules/.omnyo-toolchain"),
);

for (const plugin of selected) {
  if (!officialNames.includes(plugin)) {
    throw new Error(
      `unknown official plugin ${JSON.stringify(plugin)}; expected ${officialNames.join(", ")}, or all`,
    );
  }
}

const runtimePackage = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "packages/omnyo-app/package.json"),
    "utf8",
  ),
);

if (typeof runtimePackage.version !== "string") {
  throw new Error("packages/omnyo-app/package.json is missing a version");
}

for (const plugin of selected) {
  const rootDirectory = resolve(repositoryRoot, "plugins", plugin);
  await rm(resolve(rootDirectory, "dist"), { recursive: true, force: true });

  const manifest = pluginPackageJsonSchema.parse(
    JSON.parse(await readFile(resolve(rootDirectory, "package.json"), "utf8")),
  );

  const server = await buildPluginServer(
    rootDirectory,
    runtimePackage.version,
    toolchain,
  );

  const app = manifest.omnyo.app
    ? await buildPluginApp(rootDirectory, runtimePackage.version, toolchain)
    : null;

  const host = manifest.omnyo.host
    ? await buildPluginHost(rootDirectory, runtimePackage.version, toolchain)
    : null;

  const outputs = [server.jsPath, server.metaPath];

  if (app !== null) {
    outputs.push(app.jsPath, app.cssPath, app.metaPath);
  }

  if (host !== null) outputs.push(host.jsPath, host.mapPath, host.metaPath);
  console.log(`${plugin}: built ${outputs.join(", ")}`);
}
