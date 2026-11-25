import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import {
  declarationId,
  sharedDeclarationEmit,
} from "./shared-declaration-emit.mjs";

import { normalizeBundledDts } from "./normalize-bundled-dts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const pkgRoot = path.resolve(here, "..");

const pkgsDir = path.resolve(pkgRoot, "..");

process.chdir(path.resolve(pkgsDir, ".."));

const STUBBED_MODULES = new Map([
  [
    path.join(pkgsDir, "server-contract/src/public-api.ts"),
    path.join(here, "public-api-stub.d.ts"),
  ],
  [
    path.join(pkgsDir, "server-contract/src/api-client.ts"),
    path.join(here, "api-client-stub.d.ts"),
  ],
]);

const outDir = path.join(pkgRoot, "bundled-types");

const { name: packageName, exports: packageExports } = JSON.parse(
  readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
);

const outputs = Object.fromEntries(
  Object.values(packageExports).map((entry) => [
    path.basename(entry.types),
    path.join(pkgRoot, entry.source),
  ]),
);

const groups = ["backend", "providers", "app", "internal", "testing"];

const args = process.argv.slice(2);

if (args.length === 0) {
  const children = groups.map((group) =>
    spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--group", group],
      { stdio: "inherit" },
    ),
  );

  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) =>
              code === 0
                ? resolve()
                : reject(
                    new Error(`Declaration group failed: ${code ?? signal}`),
                  ),
            );
          }),
      ),
    );
  } catch (error) {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }

  process.exit(0);
}

if (args.length !== 2 || args[0] !== "--group" || !groups.includes(args[1]))
  throw new Error("Expected --group backend|providers|app|internal|testing");

function groupOf(name) {
  if (name.includes("testing")) return "testing";

  if (name.includes("provider-bridge")) return "providers";

  if (name.includes("-internal-")) return "internal";

  if (name === "omnyo-plugin-sdk-app.d.ts") return "app";

  return "backend";
}

for (const name of Object.keys(outputs))
  if (groupOf(name) !== args[1]) delete outputs[name];

const EXTERNAL = [
  /^@tanstack\/react-query($|\/)/,
  /^node:/,
  /^@testing-library\/react($|\/)/,
  /^better-sqlite3/,
  /^hono($|\/)/,
  /^react($|\/|-)/,
  /^react-dom($|\/)/,
  /^zod($|\/)/,
];

const workspacePackages = new Map(
  readdirSync(pkgsDir).flatMap((directory) => {
    const root = path.join(pkgsDir, directory);
    const manifestPath = path.join(root, "package.json");

    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    return typeof manifest.name === "string"
      ? [[manifest.name, { root, exports: manifest.exports }]]
      : [];
  }),
);

function resolveWorkspaceSource(id) {
  const start = id.startsWith("@") ? id.indexOf("/") + 1 : 0;
  const boundary = id.indexOf("/", start);
  const name = boundary === -1 ? id : id.slice(0, boundary);
  const owner = workspacePackages.get(name);

  if (!owner) return null;
  const key = boundary === -1 ? "." : `.${id.slice(boundary)}`;
  const entry = owner.exports?.[key];
  const source = typeof entry === "string" ? entry : entry?.source;

  return source ? path.join(owner.root, source) : null;
}

const inlineWorkspace = {
  name: "inline-workspace",
  resolveId(id, importer) {
    if (importer) {
      const asTs = path.resolve(
        path.dirname(importer),
        id.replace(/\.js$/, ".ts"),
      );

      const stub = STUBBED_MODULES.get(asTs);

      if (stub) return stub;
    }

    const stub = STUBBED_MODULES.get(id);

    if (stub) return stub;

    return resolveWorkspaceSource(id);
  },
};

const emitDeclarations = sharedDeclarationEmit(
  Object.values(outputs),
  inlineWorkspace.resolveId,
);

async function bundle(input) {
  const build = await rollup({
    input: declarationId(input),
    external: (id) =>
      id === packageName || EXTERNAL.some((pattern) => pattern.test(id)),
    plugins: [emitDeclarations, dts({ respectExternal: false })],
    onwarn(warning) {
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      console.warn(`[build-bundled-dts] ${warning.code}: ${warning.message}`);
    },
  });

  try {
    const { output } = await build.generate({ format: "es" });

    return output[0].code;
  } finally {
    await build.close();
  }
}

const HEADER = [
  "// Portable type declarations for `@omnyo/plugin-sdk`. Private",
  "// workspace contracts are flattened; public subpaths may reuse the",
  "// package root without requiring another private workspace package.",
  "//",
  "// The upstream source is preserved for selected merge integration:",
  "// and read the real source: https://github.com/get-bb/bb",
].join("\n");

function generateBundle(entry) {
  return bundle(entry).then((code) =>
    normalizeBundledDts(`${HEADER}\n\n${code}`),
  );
}

const generated = {};

for (const [name, entry] of Object.entries(outputs)) {
  generated[name] = await generateBundle(entry);
}

writeOutputs(generated);

function writeOutputs(generated) {
  mkdirSync(outDir, { recursive: true });

  for (const [fileName, content] of Object.entries(generated)) {
    const target = path.join(outDir, fileName);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;

    if (current === content) {
      console.log(`Unchanged ${path.relative(pkgRoot, target)}`);
    } else {
      writeAtomically(target, content);
      console.log(`Wrote ${path.relative(pkgRoot, target)}`);
    }
  }
}

function writeAtomically(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;

  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
