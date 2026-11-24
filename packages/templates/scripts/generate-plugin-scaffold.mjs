import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedFile } from "./write-generated.mjs";
import {
  RUNTIME_SLOT_BY_SPECIFIER,
  SHIMMED_TYPE_PACKAGES,
} from "../../plugin-build/src/runtime-shims.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const STARTER_ITEMS = ["button", "card", "input", "checkbox", "dialog"];

const SHIMMED_SPECIFIERS = new Set(Object.keys(RUNTIME_SLOT_BY_SPECIFIER));

const registryDir = path.join(packageRoot, "..", "plugin-registry", "r");

const appPackageJson = JSON.parse(
  await readFile(
    path.join(packageRoot, "..", "..", "apps", "app", "package.json"),
    "utf8",
  ),
);

const starterFiles = [];

const starterBundledDeps = new Set();

const shimmedTypeDeps = new Set(SHIMMED_TYPE_PACKAGES);

{
  const seenItems = new Set();
  const itemQueue = [...STARTER_ITEMS];

  while (itemQueue.length > 0) {
    const itemName = itemQueue.pop();

    if (seenItems.has(itemName)) continue;
    seenItems.add(itemName);

    const item = JSON.parse(
      await readFile(path.join(registryDir, `${itemName}.json`), "utf8"),
    );

    for (const file of item.files ?? []) {
      starterFiles.push({ target: file.target, content: file.content });
    }

    for (const dep of item.dependencies ?? []) {
      if (SHIMMED_SPECIFIERS.has(dep)) {
        if (!shimmedTypeDeps.has(dep)) {
          throw new Error(
            `starter dep "${dep}" is shimmed but missing from SHIMMED_TYPE_PACKAGES`,
          );
        }

        continue;
      }

      starterBundledDeps.add(dep);
    }

    itemQueue.push(
      ...(item.registryDependencies ?? []).map((name) =>
        name.replace(/^@omnyo\//, ""),
      ),
    );
  }
}

starterFiles.sort((a, b) => {
  if (a.target < b.target) return -1;

  if (a.target > b.target) return 1;

  return 0;
});

function versionedDeps(names) {
  return Object.fromEntries(
    [...names].sort().map((name) => {
      const version = appPackageJson.dependencies?.[name];

      if (!version) {
        throw new Error(
          `starter dep "${name}" missing from apps/app dependencies`,
        );
      }

      return [name, version];
    }),
  );
}

const registryFiles = await Promise.all(
  (await readdir(registryDir))
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort()
    .map(async (name) => {
      const item = JSON.parse(
        await readFile(path.join(registryDir, name), "utf8"),
      );

      item.registryDependencies = (item.registryDependencies ?? []).map(
        (dependency) => {
          if (!/^@omnyo\/[a-z0-9-]+$/.test(dependency))
            throw new Error("Unexpected registry dependency in " + name);

          return (
            "./vendor/omnyo-ui/" + dependency.slice("@omnyo/".length) + ".json"
          );
        },
      );

      return {
        target: "vendor/omnyo-ui/" + name,
        content: JSON.stringify(item) + "\n",
      };
    }),
);

const starterOutputPath = path.join(
  packageRoot,
  "src",
  "generated",
  "plugin-starter-files.generated.ts",
);

const starterOutput = `/* oxlint-disable */
export interface PluginStarterFile {
  target: string;
  content: string;
}

export const PLUGIN_REGISTRY_FILES: readonly PluginStarterFile[] = ${JSON.stringify(registryFiles)};
export const PLUGIN_STARTER_FILES: readonly PluginStarterFile[] = ${JSON.stringify(starterFiles, null, 2)};
export const PLUGIN_STARTER_DEPENDENCIES: Readonly<Record<string, string>> = ${JSON.stringify(versionedDeps(starterBundledDeps), null, 2)};
export const PLUGIN_SHIMMED_TYPE_DEPENDENCIES: Readonly<Record<string, string>> = ${JSON.stringify(versionedDeps(shimmedTypeDeps), null, 2)};
`;

await writeGeneratedFile(starterOutputPath, starterOutput);
