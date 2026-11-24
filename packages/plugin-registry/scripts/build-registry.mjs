import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const packageRoot = path.join(scriptDir, "..");

const repoRoot = path.join(packageRoot, "..", "..");

const srcRoot = path.join(repoRoot, "packages", "shared-ui", "src");

const outDir = path.join(packageRoot, "r");

const config = JSON.parse(
  await readFile(path.join(packageRoot, "registry.json"), "utf8"),
);

const pluginFlavors = config.pluginFlavors ?? {};

function resolveLocal(specifier, importerRel) {
  let base;

  if (specifier.startsWith("@/")) {
    base = specifier.slice(2);
  } else if (specifier.startsWith(".")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerRel), specifier),
    );
  } else {
    return null;
  }

  base = base.replace(/\.js$/, "");

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    base,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(path.join(srcRoot, candidate))) {
      return candidate;
    }
  }

  throw new Error(
    `cannot resolve import "${specifier}" from ${importerRel} — registry items must stay within packages/shared-ui/src`,
  );
}

function importSpecifiersOf(content) {
  const specs = [];

  const re =
    /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

  let match;

  while ((match = re.exec(content)) !== null) {
    specs.push(match[1] ?? match[2] ?? match[3]);
  }

  return specs;
}

function npmPackageOf(specifier) {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const RUNTIME_PROVIDED = new Set(["react", "react-dom", "@omnyo/plugin-sdk"]);

function itemNameFor(relPath) {
  const base = path.basename(relPath).replace(/\.(tsx?|jsx?)$/, "");
  const componentGroup = componentGroupOf(relPath);

  return [...componentGroup, base]
    .join("-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function componentGroupOf(relPath) {
  if (!relPath.startsWith("components/ui/")) return [];
  const segments = path.posix.dirname(relPath).split("/").slice(2);

  return segments[0] === "hooks" ? [] : segments;
}

function classify(relPath) {
  const base = path.basename(relPath);

  if (relPath.startsWith("components/ui/hooks/")) {
    return { type: "registry:hook", target: `components/ui/hooks/${base}` };
  }

  if (relPath.startsWith("components/ui/")) {
    return { type: "registry:ui", target: relPath };
  }

  if (relPath.startsWith("lib/")) {
    return { type: "registry:lib", target: `lib/${base}` };
  }

  if (relPath.startsWith("hooks/")) {
    return { type: "registry:hook", target: `hooks/${base}` };
  }

  throw new Error(`no registry mapping for ${relPath}`);
}

const fileByItem = new Map();

const queue = [];

for (const name of config.uiItems) {
  const relPath = [".tsx", ".ts"]
    .map((extension) => `components/ui/${name}${extension}`)
    .find((candidate) => existsSync(path.join(srcRoot, candidate)));

  if (relPath === undefined) {
    throw new Error(
      `uiItem "${name}" has no source at packages/shared-ui/src/components/ui/${name}.tsx or .ts`,
    );
  }

  queue.push(relPath);
}

const seen = new Set();

const itemMeta = new Map();

while (queue.length > 0) {
  const relPath = queue.pop();

  if (seen.has(relPath)) continue;
  seen.add(relPath);
  const itemName = itemNameFor(relPath);
  const existing = fileByItem.get(itemName);

  if (existing && existing !== relPath) {
    throw new Error(
      `item name collision: "${itemName}" from both ${existing} and ${relPath}`,
    );
  }

  fileByItem.set(itemName, relPath);

  const flavor = pluginFlavors[relPath];

  const content = await readFile(
    flavor === undefined
      ? path.join(srcRoot, relPath)
      : path.join(packageRoot, flavor),
    "utf8",
  );

  const dependencies = new Set();
  const registryDependencies = new Set();

  for (const spec of importSpecifiersOf(content)) {
    const local = resolveLocal(spec, relPath);

    if (local === null) {
      const pkg = npmPackageOf(spec);

      if (!RUNTIME_PROVIDED.has(pkg)) dependencies.add(pkg);
      continue;
    }

    if (local !== relPath) {
      registryDependencies.add(itemNameFor(local));
      queue.push(local);
    }
  }

  itemMeta.set(relPath, { content, dependencies, registryDependencies });
}

const generatedFiles = new Map();

const indexEntries = [];

for (const [itemName, relPath] of [...fileByItem.entries()].sort()) {
  const { content, dependencies, registryDependencies } = itemMeta.get(relPath);
  const { type, target } = classify(relPath);

  const item = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: itemName,
    type,
    title: itemName,
    description:
      pluginFlavors[relPath] === undefined
        ? `Omnyo ${type.replace("registry:", "")} "${itemName}" — vendored from the Omnyo app's own source (version-matched to this Omnyo release).`
        : `Omnyo ${type.replace("registry:", "")} "${itemName}" — the plugin version of the Omnyo app's ${itemName}, drawing on the host app at runtime (version-matched to this Omnyo release).`,
    ...(dependencies.size > 0
      ? { dependencies: [...dependencies].sort() }
      : {}),
    ...(registryDependencies.size > 0
      ? {
          registryDependencies: [...registryDependencies]
            .sort()
            .map((name) => `@omnyo/${name}`),
        }
      : {}),
    files: [
      {
        path: `registry/${target}`,
        content,
        type,
        target,
      },
    ],
  };

  generatedFiles.set(`${itemName}.json`, JSON.stringify(item, null, 2) + "\n");
  indexEntries.push({ name: itemName, type });
}

generatedFiles.set(
  "index.json",
  JSON.stringify(
    {
      $comment:
        "Omnyo plugin component registry index. Install via: npx shadcn add ./vendor/omnyo-ui/<name>.json (see the omnyo-plugin-authoring skill).",
      items: indexEntries.sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  ) + "\n",
);

const check = process.argv.includes("--check");

const existingNames = existsSync(outDir) ? await readdir(outDir) : [];

let stale = false;

const staleReasons = [];

for (const name of existingNames) {
  if (!generatedFiles.has(name)) {
    stale = true;
    staleReasons.push(`extra file r/${name}`);
  }
}

for (const [name, content] of generatedFiles) {
  const existingPath = path.join(outDir, name);

  const existing = existsSync(existingPath)
    ? await readFile(existingPath, "utf8")
    : null;

  if (existing !== content) {
    stale = true;
    staleReasons.push(
      existing === null ? `missing r/${name}` : `changed r/${name}`,
    );
  }
}

if (check) {
  if (stale) {
    console.error(
      `plugin registry is stale (${staleReasons.slice(0, 5).join(", ")}${staleReasons.length > 5 ? ", …" : ""}). Run: pnpm exec turbo run generate --filter=@omnyo/plugin-registry`,
    );
    process.exit(1);
  }

  console.log(`plugin registry up to date (${fileByItem.size} items)`);
} else if (stale) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const [name, content] of generatedFiles) {
    await writeFile(path.join(outDir, name), content);
  }

  console.log(
    `wrote ${generatedFiles.size} files to r/ (${fileByItem.size} items)`,
  );
} else {
  console.log(`plugin registry up to date (${fileByItem.size} items)`);
}
