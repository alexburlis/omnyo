import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { collectSourceBindings } from "./omnyo-source-map.mjs";

export const runtimeOutputNames = new Map([
  ["bb-app.js", "omnyo-app.js"],
  ["bb.js", "omnyo.js"],
  ["bb-server.js", "omnyo-server.js"],
  ["bb-host-daemon.js", "omnyo-host-daemon.js"],
  ["prune-bb-chunks.mjs", "prune-omnyo-chunks.mjs"],
  ["bb-chunks", "omnyo-chunks"],
  ["bb.cmd", "omnyo.cmd"],
  ...[
    "file-search-worker",
    "parcel-watcher-child",
    "plugin-host-worker",
    "process-launcher-worker",
    "provider-bridge-worker",
    "workspace-observer-child",
    "workspace-read-child",
  ].map((name) => [`bb-${name}.mjs`, `omnyo-${name}.mjs`]),
]);

const binNames = new Map([
  ["bb", "omnyo"],
  ["bb-app", "omnyo-app"],
  ["bb-server", "omnyo-server"],
  ["bb-host-daemon", "omnyo-host-daemon"],
]);

const binOwners = new Set([
  "packages/bb-app/scripts/build.mjs",
  "packages/bb-app/scripts/prune-bb-chunks.mjs",
  "packages/bb-app/scripts/build-host.mjs",
  "packages/bb-app/scripts/build-host-artifact.mjs",
  "apps/host-daemon/scripts/bundle-manifest.mjs",
  "packages/bb-app/package.json",
  "apps/cli/package.json",
]);

const cliAssetOwners = new Set([
  "packages/bb-app/src/launcher.ts",
  "packages/bb-app/test/index.test.ts",
  "packages/bb-app/test/host-daemon-startup.test.mjs",
  "apps/host-daemon/src/server-move/test-fixture.ts",
  "apps/server/test/app/bb-app-artifact.test.ts",
  "apps/server/test/app/bb-app-artifact-prepared.test.ts",
]);

export const runtimeSourceMoves = new Map([
  ...["bb-app", "bb", "bb-server", "bb-host-daemon"].map((name) => [
    `packages/bb-app/src/bin/${name}.ts`,
    `packages/bb-app/src/bin/${binNames.get(name)}.ts`,
  ]),
  [
    "packages/bb-app/scripts/prune-bb-chunks.mjs",
    "packages/bb-app/scripts/prune-omnyo-chunks.mjs",
  ],
  ["apps/cli/bin/bb", "apps/cli/bin/omnyo"],
]);

function legacyContext(node) {
  for (let parent = node; parent; parent = parent.parent) {
    if (parent.name && /legacy.*v1/i.test(parent.name.text ?? "")) return true;
  }

  return false;
}

export function materializeRuntimeOutputOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  excludeFiles = [],
}) {
  const operations = [];
  const excluded = new Set(excludeFiles);

  const names = [...runtimeOutputNames.keys()].sort(
    (a, b) => b.length - a.length,
  );

  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const pattern = new RegExp(
    `(?<![\\w.-])(?:${names.map(escape).join("|")})(?![\\w.-])`,
    "g",
  );

  const append = (selector) =>
    operations.push({
      id: `runtime-path-${operations.length + 1}`,
      rule_id: "R15",
      ledger_ids: ["ROOT-002", "PKG-017", "APP-054"],
      proof_ids: ["V01-source-transform", "V09-packages"],
      migration_ids: ["S09"],
      owner,
      selector,
    });

  for (const file of bindings.files) {
    if (
      excluded.has(file) ||
      !(/\.[cm]?[jt]sx?$/.test(file) || file.endsWith("package.json")) ||
      /^(?:docs\/|scripts\/omnyo-|packages\/scripts\/test\/omnyo-)|(?:^|\/)legacy[^/]*v1\.|bb-plugin-sdk-0\.4\.8-scaffold|(?:^|\/)(?:omnyo-[^/]+|[^/]*-v1)\.test\./.test(
        file,
      )
    )
      continue;
    const text = readFileSync(resolve(root, file), "utf8");

    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".json") ? ts.ScriptKind.JSON : undefined,
    );

    const visit = (node) => {
      if (legacyContext(node)) return;

      if (
        binOwners.has(file) &&
        ts.isIdentifier(node) &&
        ts.isPropertyAssignment(node.parent) &&
        node.parent.name === node &&
        node.parent.parent.parent.name?.text === "bin" &&
        binNames.has(node.text)
      )
        append({
          kind: "span",
          file,
          start: node.getStart(parsed),
          before: node.text,
          after: binNames.get(node.text),
          serialized: true,
          context: "Declared current bundled executable key",
        });

      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const start = node.getStart(parsed) + 1;

        const end =
          node.end -
          (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1);

        const before = text.slice(start, end);

        let after = before.replace(pattern, (value) =>
          runtimeOutputNames.get(value),
        );

        after = after.replace(
          /(host-daemon\/dist\/)bb(?=$|["'\s])/g,
          "$1omnyo",
        );

        if (cliAssetOwners.has(file) && before === "bb") after = "omnyo";

        if (binOwners.has(file) && binNames.has(before)) {
          const parent = node.parent;

          const isBinKey =
            file.endsWith("package.json") &&
            ts.isPropertyAssignment(parent) &&
            parent.name === node &&
            parent.parent.parent.name?.text === "bin";

          if (!file.endsWith("package.json") || isBinKey)
            after = binNames.get(before);
        }

        if (file === "apps/cli/package.json" && before === "./bin/bb")
          after = "./bin/omnyo";

        if (file === "packages/bb-app/scripts/prune-bb-chunks.mjs")
          after = after
            .replaceAll("bundled bb CLI", "bundled Omnyo CLI")
            .replaceAll("packages/bb-app", "the runtime package")
            .replaceAll("bb-app: pruned", "omnyo-app: pruned")
            .replaceAll("stale bb CLI", "stale Omnyo CLI");

        if (before !== after)
          append({
            kind: "span",
            file,
            start,
            before,
            after,
            serialized: true,
            context:
              "Exact current runtime output filename or declared executable owner; finite V1 inputs excluded",
          });
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  const cliFile = "apps/cli/bin/bb";

  if (bindings.files.includes(cliFile)) {
    const text = readFileSync(resolve(root, cliFile), "utf8");
    const before = "Missing built bb CLI";
    const start = text.indexOf(before);

    if (start !== -1)
      append({
        kind: "span",
        file: cliFile,
        start,
        before,
        after: "Missing built Omnyo CLI",
        context: "Current source CLI launcher error copy",
      });
  }

  for (const [file, target] of runtimeSourceMoves)
    if (bindings.files.includes(file)) append({ kind: "path", file, target });

  return { schema: 1, candidate: { root, owner }, operations };
}
