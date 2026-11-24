import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSymbolResolver, isScript } from "./omnyo-rename/selectors.mjs";
import ts from "typescript";

const targets = new Map([
  ["RESERVED_BB_CLI_COMMANDS", "RESERVED_CORE_CLI_COMMANDS"],
  ["DEFAULT_BB_REQUEST_TIMEOUT_MS", "DEFAULT_CORE_REQUEST_TIMEOUT_MS"],
  ["BbPluginApi", "PluginApi"],
  ["PluginBbSdk", "PluginSdk"],
  ["BBSdk", "OmnyoSdk"],
  ["createBBSdk", "createOmnyoSdk"],
  ["bbContext", "appContext"],
  ["ExpectedBbPluginApiKey", "ExpectedPluginApiKey"],
  ["useBbContext", "experimental_useAppContext"],
  ["useBbNavigate", "experimental_useAppNavigate"],
  ["BbNavigate", "experimental_AppNavigate"],
  ["BbContext", "experimental_AppContext"],
  ["BbSdkContext", "OmnyoSdkContext"],
  ["PluginBrowserBbSdk", "experimental_PluginBrowserSdk"],
  ["BbIconName", "IconName"],
  ["createBbSdk", "createOmnyoSdk"],
  ["createNodeBbSdk", "createNodeOmnyoSdk"],
  ["createBrowserBbSdk", "createBrowserOmnyoSdk"],
  ["createCliBbSdk", "createCliOmnyoSdk"],
  ["bbThreadId", "appThreadId"],
  ["bbTurnId", "appTurnId"],
  ["bbItemId", "appItemId"],
  ["getBbTurnId", "getAppTurnId"],
  ["bbVersion", "coreVersion"],
  ["rollbackBbVersion", "rollbackCoreVersion"],
  ["linkedBbProjectId", "linkedAppProjectId"],
  ["BbRuntimeMode", "AppRuntimeMode"],
  ["resolveBbDesktopPlatform", "resolveDesktopPlatform"],
  ["BB_THREAD_NAME_PREFIX", "APP_THREAD_NAME_PREFIX"],
  ["pluginBbManifestSchema", "pluginOmnyoManifestSchema"],
  ["bbEngineRange", "coreEngineRange"],
  ["bbPluginSdkRange", "pluginSdkRange"],
]);

export function packageTarget(name) {
  if (name === "bb") return "omnyo";

  if (name === "@get-bb/plugin-sdk" || name === "@bb/plugin-sdk")
    return "@omnyo/plugin-sdk";

  if (name.startsWith("@bb/")) return `@omnyo/${name.slice(4)}`;

  if (name === "bb-app") return "omnyo-app";

  if (name === "bb-environment-provider-host")
    return "omnyo-environment-provider-host";

  if (
    ["bb-plugin-bb-account", "bb-plugin-bb-ai", "bb-plugin-bb-guide"].includes(
      name,
    )
  )
    return `omnyo-plugin-omnyo-${name.slice("bb-plugin-bb-".length)}`;

  if (name.startsWith("bb-plugin-")) {
    const suffix = name.slice("bb-plugin-".length);

    return `omnyo-plugin-${suffix.startsWith("bb--") ? `omnyo--${suffix.slice(4)}` : suffix}`;
  }

  return undefined;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

const scriptPattern = /\.[cm]?[jt]sx?$/;

const thirdPartySymbols = new Set(["bbedit", "bbeditIcon"]);

const versionedLegacyFixtureRoots = [
  "apps/server/test/fixtures/plugins/bb-plugin-sdk-0.4.8-scaffold/",
];

const legacyFixture = (file) =>
  versionedLegacyFixtureRoots.some((root) => file.startsWith(root));

const propertyKinds = new Set([
  "PropertyAssignment",
  "PropertySignature",
  "PropertyDeclaration",
  "MethodSignature",
  "MethodDeclaration",
]);

const sourcePathTargets = new Map([
  [".bb-env-setup.sh", ".omnyo-env-setup.sh"],
  ["apps/cli/bin/bb", "apps/cli/bin/omnyo"],
]);

const basenameTargets = new Map([
  ["bb", "omnyo"],
  ["bb.ts", "omnyo.ts"],
  ["bb.js", "omnyo.js"],
  ["bb-server.ts", "omnyo-server.ts"],
  ["bb-server.js", "omnyo-server.js"],
  ["bb-host-daemon.ts", "omnyo-host-daemon.ts"],
  ["bb-host-daemon.js", "omnyo-host-daemon.js"],
  ["bb-app-managed-config", "managed-app-config"],
  ["bb-process.ts", "app-process.ts"],
  ["bb-process.test.ts", "app-process.test.ts"],
  ["bb-app-managed-config.ts", "managed-app-config.ts"],
  ["bb-app-managed-config.test.ts", "managed-app-config.test.ts"],
  ["bb-cli-reexec.ts", "cli-reexec.ts"],
  ["bb-cli-reexec.test.ts", "cli-reexec.test.ts"],
]);

function sourcePaths(root) {
  return [
    ...new Set(
      execFileSync(
        "git",
        ["-C", root, "ls-files", "-c", "-o", "--exclude-standard", "-z"],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5_000 },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ]
    .sort()
    .filter(
      (file) =>
        existsSync(resolve(root, file)) &&
        lstatSync(resolve(root, file)).isFile(),
    );
}

function parse(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".json") ? ts.ScriptKind.JSON : undefined,
  );
}

const moduleCallCheckers = new WeakMap();

const testModuleMethods = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
  "requireActual",
  "requireMock",
]);

function importedTestModuleLiteral(node) {
  const call = node.parent;

  if (
    !ts.isCallExpression(call) ||
    call.arguments[0] !== node ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !testModuleMethods.has(call.expression.name.text)
  )
    return false;
  const members = [];
  let expression = call.expression;

  while (ts.isPropertyAccessExpression(expression)) {
    members.unshift(expression.name.text);
    expression = expression.expression;
  }

  if (!ts.isIdentifier(expression)) return false;
  const source = node.getSourceFile();
  let checker = moduleCallCheckers.get(source);

  if (!checker) {
    const options = {
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    };

    const host = ts.createCompilerHost(options);
    host.getSourceFile = (file) =>
      resolve(file) === resolve(source.fileName) ? source : undefined;
    const program = ts.createProgram([source.fileName], options, host);
    checker = program.getTypeChecker();
    moduleCallCheckers.set(source, checker);
  }

  const declarations =
    checker.getSymbolAtLocation(expression)?.declarations ?? [];

  if (declarations.length !== 1) return false;
  const binding = declarations[0];

  if (!ts.isImportSpecifier(binding) && !ts.isNamespaceImport(binding))
    return false;
  let declaration = binding;

  while (declaration && !ts.isImportDeclaration(declaration))
    declaration = declaration.parent;

  if (!declaration || !ts.isStringLiteralLike(declaration.moduleSpecifier))
    return false;
  const module = declaration.moduleSpecifier.text;

  if (ts.isNamespaceImport(binding))
    return (
      module === "vitest" &&
      members.length === 2 &&
      ["vi", "vitest"].includes(members[0])
    );
  const imported = binding.propertyName?.text ?? binding.name.text;

  return (
    members.length === 1 &&
    ((module === "vitest" && ["vi", "vitest"].includes(imported)) ||
      (module === "@jest/globals" && imported === "jest"))
  );
}

function moduleLiteral(node) {
  const parent = node.parent;

  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(parent) && parent.expression === node) ||
    (parent.parent &&
      ts.isImportTypeNode(parent.parent) &&
      ts.isLiteralTypeNode(parent)) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(parent.expression) &&
          parent.expression.text === "require"))) ||
    importedTestModuleLiteral(node)
  );
}

export function moduleTarget(value, packages, renameSubpaths = true) {
  const start = value.startsWith("@") ? value.indexOf("/") + 1 : 0;
  const boundary = value.indexOf("/", start);
  const name = boundary === -1 ? value : value.slice(0, boundary);
  const after = packages.get(name);

  return after
    ? after +
        (renameSubpaths
          ? metadataPath(value.slice(name.length))
          : value.slice(name.length))
    : undefined;
}

function proposedSymbol(name) {
  if (thirdPartySymbols.has(name)) return null;

  if (targets.has(name)) return targets.get(name);

  if (name === "bb") return "api";

  if (name === "_bb") return "_api";

  if (name.startsWith("BB_")) return `OMNYO_${name.slice(3)}`;

  if (name.includes("BBSdk")) return name.replace("BBSdk", "OmnyoSdk");

  if (name.startsWith("bb") && /^[A-Z]/.test(name.slice(2)))
    return `omnyo${name.slice(2)}`;
  const token = name.indexOf("Bb");

  if (
    token !== -1 &&
    (token + 2 === name.length || /^[A-Z0-9]/.test(name.slice(token + 2)))
  )
    return `${name.slice(0, token)}Omnyo${name.slice(token + 2)}`;

  return null;
}

export function pathTarget(file) {
  if (sourcePathTargets.has(file)) return sourcePathTargets.get(file);

  if (file === "packages/bb-app") return "packages/omnyo-app";

  if (
    /^(?:docs\/(?:evidence|execplans|plans)\/|packages\/db\/drizzle\/|.*\/(?:recordings|__fixtures__)\/)/.test(
      file,
    )
  )
    return undefined;
  let target = file;

  if (target.startsWith(".bb/")) target = `.omnyo/${target.slice(4)}`;

  if (target.startsWith("packages/bb-app/"))
    target = `packages/omnyo-app/${target.slice("packages/bb-app/".length)}`;
  target = target.replace("/verify-bb/", "/verify-omnyo/");

  if (target.startsWith("plugins/bb-account/"))
    target = `plugins/omnyo-account/${target.slice("plugins/bb-account/".length)}`;
  const name = basename(target);

  if (basenameTargets.has(name))
    target = target.slice(0, -name.length) + basenameTargets.get(name);
  else if (
    name.startsWith("bb-logo") ||
    name.startsWith("bb-icon") ||
    name.startsWith("bb-desktop") ||
    name.startsWith("bb-app") ||
    name.startsWith("bb-guide-") ||
    name.startsWith("bb-official") ||
    name.startsWith("bb-plugin-")
  )
    target = target.slice(0, -name.length) + `omnyo${name.slice(2)}`;
  else if (/^(?:Bb(?:Diff|SourceCode)|UpdateBbNowDialog)/.test(name))
    target = target.slice(0, -name.length) + name.replace("Bb", "Omnyo");
  else if (
    /^(?:start-bb|reset-bb-data|archive-codex-tmp-bb-sessions|generate-bb-official|open-bb-link|prune-bb-chunks|bb-project-link|bb-cloud-dev|publish-bb-app|stub-getbb|bb-pi-extension)/.test(
      name,
    )
  )
    target = target.slice(0, -name.length) + name.replace("bb", "omnyo");

  return target === file ? undefined : target;
}

export function collectSourceBindings(root, { files: selectedFiles } = {}) {
  const universe = sourcePaths(root);

  const selected =
    selectedFiles === undefined ? undefined : new Set(selectedFiles);

  if (selected && [...selected].some((file) => !universe.includes(file)))
    throw new Error("Selected source file is outside the current universe");

  const paths = selected
    ? universe.filter((file) => selected.has(file))
    : universe;

  const packages = [];
  const manifests = [];
  const declarations = [];
  const modules = [];
  const pathMap = [];
  const files = paths;

  for (const path of paths) {
    const target = pathTarget(path);

    if (target) pathMap.push({ before: path, after: target });

    if (basename(path) === "package.json") {
      const value = JSON.parse(readFileSync(resolve(root, path), "utf8"));

      if (typeof value.name === "string") {
        manifests.push({
          file: path,
          before: value.name,
          after: value.name,
          private: value.private === true,
        });
        const after = packageTarget(value.name);

        if (after)
          packages.push({
            file: path,
            before: value.name,
            after,
            private: value.private === true,
          });
      }
    }

    if (
      !scriptPattern.test(path) ||
      /(^|\/)(?:recordings|drizzle)\//.test(path)
    )
      continue;
    const text = readFileSync(resolve(root, path), "utf8");
    const source = parse(path, text);

    if (source.parseDiagnostics.length) continue;

    const visit = (node) => {
      if (ts.isStringLiteralLike(node) && moduleLiteral(node))
        modules.push({
          file: path,
          before: node.text,
          raw: text.slice(node.getStart(source) + 1, node.end - 1),
          position: node.getStart(source) + 1,
        });

      if (
        ts.isIdentifier(node) &&
        node.parent.name === node &&
        !ts.isShorthandPropertyAssignment(node.parent) &&
        !ts.isPropertyAccessExpression(node.parent) &&
        /^(?:_?bb|Bb|BB(?:_|[A-Z]|$))|Bb(?:[A-Z0-9]|$)|BBSdk|(?:^|_)BB(?:_|$)/.test(
          node.text,
        )
      ) {
        const declarationKind = ts.SyntaxKind[node.parent.kind];
        const serialized = propertyKinds.has(declarationKind);
        declarations.push({
          file: path,
          position: node.getStart(source),
          before: node.text,
          proposed: proposedSymbol(node.text),
          declarationKind,
          serialized,
          migration_ids: serialized ? ["S07"] : [],
          treatment: thirdPartySymbols.has(node.text)
            ? "third-party-identity"
            : serialized
              ? "await-existing-state-owner"
              : "semantic-declaration",
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  const collisions = [];
  const owners = new Map();

  for (const pkg of packages) {
    const previous = owners.get(pkg.after);

    if (previous)
      collisions.push({ target: pkg.after, files: [previous, pkg.file] });
    else owners.set(pkg.after, pkg.file);
  }

  const pluginIds = packages
    .filter((pkg) => pkg.before.startsWith("bb-plugin-"))
    .map((pkg) => ({
      package: pkg.before,
      targetPackage: pkg.after,
      before: pkg.before.slice(10),
      after: pkg.after.slice(13),
    }));

  return {
    schema: 1,
    root,
    scope: {
      complete: selectedFiles === undefined,
      universeFiles: universe.length,
      selectedFiles: paths.length,
    },
    treatment:
      "exact declaration proposals; no edit without owning migration and collision proof",
    packages,
    manifests,
    modules,
    declarations,
    pathMap,
    files,
    pluginIds,
    collisions,
  };
}

function commandTarget(value, packages) {
  return value.replace(
    /(^|[\s="'])(@(?:get-)?bb\/[a-z0-9-]+|bb-app|bb-plugin-[a-z0-9-]+)(?=$|[\s"'./])/g,
    (all, boundary, name) =>
      packages.has(name) ? boundary + packages.get(name) : all,
  );
}

const executables = new Map([
  ["bb", "omnyo"],
  ["bb-app", "omnyo-app"],
  ["bb-server", "omnyo-server"],
  ["bb-host-daemon", "omnyo-host-daemon"],
  ["bb-plugin-build", "omnyo-plugin-build"],
  [
    "bb-script-archive-codex-tmp-bb-sessions",
    "omnyo-script-archive-codex-tmp-omnyo-sessions",
  ],
  ["bb-script-reset-bb-data", "omnyo-script-reset-omnyo-data"],
  ["bb-environment-provider-host", "omnyo-environment-provider-host"],
]);

function metadataPath(value) {
  const bang = value.startsWith("!") ? "!" : "";
  const plain = bang ? value.slice(1) : value;
  const dot = plain.startsWith("./") ? "./" : "";
  const target = pathTarget(dot ? plain.slice(2) : plain);

  return target ? `${bang}${dot}${target}` : value;
}

function relativeModuleTarget(module, bindings, graph) {
  if (!module.before.startsWith(".")) return undefined;
  const marker = module.before.search(/[?#]/);
  const value = marker === -1 ? module.before : module.before.slice(0, marker);
  const query = marker === -1 ? "" : module.before.slice(marker);
  const absolute = resolve(bindings.root, dirname(module.file), value);
  const local = relative(bindings.root, absolute).replaceAll("\\", "/");

  if (local === ".." || local.startsWith("../")) return undefined;

  const choices = [
    local,
    local.replace(/\.js$/, ".ts"),
    local.replace(/\.js$/, ".tsx"),
    local.replace(/\.mjs$/, ".mts"),
    local.replace(/\.cjs$/, ".cts"),
    ...[
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      "/index.ts",
      "/index.tsx",
      "/index.js",
    ].map((extension) => local + extension),
  ];

  const source = choices.find((choice) => graph.files.has(choice));

  if (!source) return undefined;
  const importer = graph.paths.get(module.file) ?? module.file;
  const destination = graph.paths.get(source) ?? source;
  let path = relative(dirname(importer), destination).replaceAll("\\", "/");
  const extension = extname(value);

  if (extension === "") path = path.replace(/(?:\/index)?\.[cm]?[jt]sx?$/, "");
  else if (extname(source) !== extension)
    path = path.slice(0, -extname(path).length) + extension;
  const result = `${path.startsWith(".") ? "" : "./"}${path}${query}`;

  return result === module.before ? undefined : result;
}

function packageIdentityRegistry(root, bindings, allPackages) {
  const path = resolve(
    root,
    "docs/omnyo-migration/execution-package-identities.json",
  );

  const registry = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).packages
    : [];

  if (!Array.isArray(registry))
    throw new Error("Missing immutable package identity pairs");
  const identities = new Map();

  for (const item of [...registry, ...allPackages, ...bindings.packages]) {
    if (packageTarget(item.before) !== item.after)
      throw new Error(`Unapproved package identity target for ${item.before}`);
    const previous = identities.get(item.before);

    if (previous !== undefined && previous !== item.after)
      throw new Error(`Package target conflict for ${item.before}`);
    identities.set(item.before, item.after);
  }

  return identities;
}

export function materializePackageModuleOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  allPackages = [],
  selectedPackages,
  sdkTarball,
  includePaths = true,
}) {
  const identities = packageIdentityRegistry(root, bindings, allPackages);

  const packages = new Map(
    [...identities].filter(
      ([before]) =>
        selectedPackages === undefined || selectedPackages.includes(before),
    ),
  );

  if (
    selectedPackages === undefined ||
    selectedPackages.includes("@get-bb/plugin-sdk") ||
    selectedPackages.includes("@bb/plugin-sdk")
  ) {
    packages.set("@bb/plugin-sdk", "@omnyo/plugin-sdk");
    packages.set("@get-bb/plugin-sdk", "@omnyo/plugin-sdk");
  }

  const operations = [];

  const append = (selector, rule_id = "R01", migration_ids = []) =>
    operations.push({
      id: `source-${String(operations.length + 1).padStart(6, "0")}`,
      rule_id,
      ledger_ids: ["PKG-001", "PKG-017", "PLG-003"],
      proof_ids: ["V01-source-transform", "V09-packages"],
      migration_ids,
      owner,
      selector,
    });

  const selectedTargets = new Set(packages.values());

  const packageOwners = (bindings.manifests ?? bindings.packages).map(
    (pkg) => ({ ...pkg, after: identities.get(pkg.before) ?? pkg.before }),
  );

  for (const pkg of packageOwners) {
    if (legacyFixture(pkg.file)) continue;

    if (packages.has(pkg.before) && pkg.before !== pkg.after)
      append({
        kind: "packageName",
        file: pkg.file,
        before: pkg.before,
        after: pkg.after,
      });
    const text = readFileSync(resolve(root, pkg.file), "utf8");
    const value = JSON.parse(text);

    if (
      (packages.has(pkg.before) || selectedTargets.has(pkg.before)) &&
      !pkg.private
    ) {
      if (value.private === false)
        append(
          {
            kind: "jsonPath",
            file: pkg.file,
            path: ["private"],
            field: "value",
            before: false,
            after: true,
          },
          "R01",
          ["S07"],
        );
      else {
        const parsed = parse(pkg.file, text);

        const property = parsed.statements[0].expression.properties.find(
          (item) => item.name.text === "name",
        );

        const start = text.indexOf(",", property.end) + 1;

        if (start === 0)
          throw new Error(
            `Package name insertion boundary missing: ${pkg.file}`,
          );
        append(
          {
            kind: "span",
            file: pkg.file,
            start,
            before: "",
            after: '\n  "private": true,',
            context: "Disable publication of renamed private workspace package",
            serialized: true,
          },
          "R01",
          ["S07"],
        );
      }
    }

    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "peerDependenciesMeta",
    ]) {
      for (const name of Object.keys(value[field] ?? {})) {
        const target = packages.get(name);

        if (target) {
          const sdk =
            target === "@omnyo/plugin-sdk" &&
            typeof value[field][name] === "string" &&
            !value[field][name].startsWith("workspace:");

          append(
            {
              kind: "jsonPath",
              file: pkg.file,
              path: [field, name],
              field: "key",
              before: name,
              after: target,
            },
            "R01",
            ["S07"],
          );

          if (sdk) {
            if (sdkTarball) {
              const after = `file:${relative(dirname(resolve(root, pkg.file)), resolve(root, sdkTarball)).replaceAll("\\", "/")}`;
              append(
                {
                  kind: "jsonPath",
                  file: pkg.file,
                  path: [field, name],
                  field: "value",
                  before: value[field][name],
                  after,
                },
                "R01",
                ["S07"],
              );

              if (!existsSync(resolve(root, sdkTarball)))
                Object.assign(operations.at(-1), {
                  disposition: "blocked",
                  blocked_reason:
                    "Existing SDK pack owner must produce and verify the selected private tarball before apply",
                });
            } else
              Object.assign(operations.at(-1), {
                disposition: "blocked",
                blocked_reason:
                  "Private SDK source required; the renamed package cannot use an unowned registry namespace",
              });
          }
        }
      }
    }

    const metadata = parse(pkg.file, text);

    if (
      (packages.has(pkg.before) || selectedTargets.has(pkg.before)) &&
      value.publishConfig?.access === "public"
    ) {
      const property = metadata.statements[0].expression.properties.find(
        (item) => item.name.text === "publishConfig",
      );

      const start = property.getStart(metadata);
      const end = text[property.end] === "," ? property.end + 1 : property.end;

      if (end === property.end)
        throw new Error(
          `Public publication field requires reviewed trailing-comma removal: ${pkg.file}`,
        );
      append(
        {
          kind: "span",
          file: pkg.file,
          start,
          before: text.slice(start, end),
          after: "",
          context:
            "Disable public publication configuration for renamed private package",
          serialized: true,
        },
        "R01",
        ["S07"],
      );
    }

    const visitMetadata = (node, path = []) => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = property.name.text;
          const next = [...path, key];

          if (path.length === 1 && path[0] === "bin") {
            const after =
              executables.get(key) ??
              (key.startsWith("bb-script-")
                ? `omnyo-script-${key.slice(10)}`
                : undefined);

            if (after)
              append(
                {
                  kind: "jsonPath",
                  file: pkg.file,
                  path: next,
                  field: "key",
                  before: key,
                  after,
                },
                "R03",
                ["S09"],
              );
          }

          if (path.length === 1 && path[0] === "exports") {
            const after = metadataPath(key);

            if (after !== key)
              append(
                {
                  kind: "jsonPath",
                  file: pkg.file,
                  path: next,
                  field: "key",
                  before: key,
                  after,
                },
                "R15",
                ["S07"],
              );
          }

          visitMetadata(property.initializer, next);
        }
      } else if (ts.isArrayLiteralExpression(node)) {
        for (const [index, child] of node.elements.entries())
          visitMetadata(child, [...path, index]);
      } else if (
        ts.isStringLiteralLike(node) &&
        (["bin", "files", "exports", "main", "types", "module"].includes(
          path[0],
        ) ||
          path.join("/") === "repository/directory")
      ) {
        const after = metadataPath(node.text);

        if (after !== node.text)
          append(
            {
              kind: "span",
              file: pkg.file,
              start: node.getStart(metadata) + 1,
              before: text.slice(node.getStart(metadata) + 1, node.end - 1),
              after,
              context: `Package-owned ${path.join("/")} path from exact source/output mapping`,
              serialized: true,
            },
            "R15",
            ["S09"],
          );
      }
    };

    if (includePaths) visitMetadata(metadata.statements[0].expression);

    for (const [name, command] of Object.entries(value.scripts ?? {})) {
      if (typeof command !== "string") continue;
      const after = commandTarget(command, packages);

      if (after !== command)
        append(
          {
            kind: "jsonPath",
            file: pkg.file,
            path: ["scripts", name],
            field: "value",
            before: command,
            after,
          },
          "R01",
          ["S07"],
        );
    }
  }

  const seen = new Set();

  const pathGraph = {
    files: new Set(bindings.files),
    paths: new Map(bindings.pathMap.map((path) => [path.before, path.after])),
  };

  for (const module of bindings.modules) {
    if (legacyFixture(module.file)) continue;

    const after =
      moduleTarget(module.before, packages, includePaths) ??
      (includePaths
        ? relativeModuleTarget(module, bindings, pathGraph)
        : undefined);

    const key = `${module.file}:${module.position}`;

    if (after && !seen.has(key)) {
      seen.add(key);
      append({
        kind: "span",
        file: module.file,
        start: module.position,
        before: module.raw ?? module.before,
        after,
        context:
          "Exact AST module specifier bound to immutable package identity map",
      });
    }
  }

  return { schema: 1, candidate: { root, owner }, operations };
}

export function materializePackageConsumerOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  allPackages = [],
  selectedPackages,
}) {
  const identities = packageIdentityRegistry(root, bindings, allPackages);

  const packages = new Map(
    [...identities].filter(
      ([before]) =>
        selectedPackages === undefined || selectedPackages.includes(before),
    ),
  );

  if (
    selectedPackages === undefined ||
    selectedPackages.includes("@get-bb/plugin-sdk") ||
    selectedPackages.includes("@bb/plugin-sdk")
  ) {
    packages.set("@bb/plugin-sdk", "@omnyo/plugin-sdk");
    packages.set("@get-bb/plugin-sdk", "@omnyo/plugin-sdk");
  }

  const operations = [];

  const mapped = (value) => {
    if (value === "bb") return undefined;

    if (
      selectedPackages === undefined &&
      (value === "@bb/" || value === "@bb/*")
    )
      return value.replace("@bb/", "@omnyo/");
    const task = value.indexOf("#");

    if (task > 0 && packages.has(value.slice(0, task)))
      return packages.get(value.slice(0, task)) + value.slice(task);

    if (value.startsWith("--filter=")) {
      const filter = value.slice(9);
      const suffix = filter.endsWith("...") ? "..." : "";
      const name = suffix ? filter.slice(0, -3) : filter;

      return packages.has(name)
        ? `--filter=${packages.get(name)}${suffix}`
        : undefined;
    }

    return moduleTarget(value, packages, false);
  };

  for (const file of bindings.files) {
    if (
      /(?:\.test\.[cm]?[jt]sx?$|\/(?:__fixtures__|recordings|drizzle)\/|(?:legacy.*v1|omnyo-environment)|(?:^|\/)omnyo-(?:rename|source-map)|(?:^|\/)verify-omnyo|packages\/templates\/src\/templates\/plugin-scaffold\/)/.test(
        file,
      )
    )
      continue;

    const config =
      file === "turbo.json" ||
      /(?:^|\/)(?:tsconfig[^/]*|\.oxlintrc[^/]*)\.json$/.test(file);

    if (!isScript(file) && !config) continue;
    const text = readFileSync(resolve(root, file), "utf8");
    const parsed = parse(file, text);

    if (parsed.parseDiagnostics.length) continue;
    const seen = new Set();

    const toolingOwner =
      /^(?:scripts\/|packages\/(?:scripts|plugin-build)\/|packages\/bb-app\/scripts\/|packages\/templates\/scripts\/)|(?:^|\/)(?:vite|vitest|playwright|electron-builder)\.config\./.test(
        file,
      );

    const ownedModuleContext = (node) => {
      if (config || toolingOwner) return true;
      const parent = node.parent;

      if (
        ts.isVariableDeclaration(parent) &&
        /(?:SDK|Sdk|PACKAGE|Package|SPECIFIER|Specifier|EXTERNAL|External)/.test(
          parent.name.getText(parsed),
        )
      )
        return true;

      return (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === node &&
        /^(?:require(?:\.resolve)?|import\.meta\.resolve)$/.test(
          parent.expression.getText(parsed),
        )
      );
    };

    const visit = (node) => {
      if (
        ts.isStringLiteralLike(node) &&
        (config || !moduleLiteral(node)) &&
        ownedModuleContext(node)
      ) {
        const after = mapped(node.text);

        const property =
          ts.isPropertyAssignment(node.parent) && node.parent.name === node;

        if (after && after !== node.text && (config || !property)) {
          const key = String(node.getStart(parsed));

          if (!seen.has(key)) {
            seen.add(key);
            operations.push({
              id: `package-consumer-${String(operations.length + 1).padStart(7, "0")}`,
              rule_id: "R01",
              ledger_ids: ["ROOT-014", "PKG-001", "PKG-017"],
              proof_ids: ["V01-source-transform", "V09-packages"],
              migration_ids: config ? ["S07"] : [],
              owner,
              selector: config
                ? {
                    kind: "span",
                    file,
                    start: node.getStart(parsed) + 1,
                    before: text.slice(node.getStart(parsed) + 1, node.end - 1),
                    after,
                    context:
                      "Exact owned workspace package/task reference in parsed build configuration",
                    serialized: true,
                  }
                : {
                    kind: "span",
                    file,
                    start: node.getStart(parsed) + 1,
                    before: text.slice(node.getStart(parsed) + 1, node.end - 1),
                    after,
                    context:
                      "Exact AST package/task reference in its owning build-tool expression",
                  },
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return { schema: 1, candidate: { root, owner }, operations };
}

export function collectPackageReferenceResiduals({
  root,
  selectedPackages,
  allPackages = [],
  bindings = collectSourceBindings(root),
}) {
  const identities = packageIdentityRegistry(root, bindings, allPackages);

  const selected = new Map(
    [...identities].filter(
      ([before]) =>
        selectedPackages === undefined || selectedPackages.includes(before),
    ),
  );

  const hits = [];

  for (const entry of bindings.manifests ?? bindings.packages) {
    if (legacyFixture(entry.file)) continue;
    const pkg = JSON.parse(readFileSync(resolve(root, entry.file), "utf8"));

    if (selected.has(pkg.name))
      hits.push({ file: entry.file, kind: "package-name", before: pkg.name });

    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "peerDependenciesMeta",
    ]) {
      for (const key of Object.keys(pkg[field] ?? {}))
        if (selected.has(key))
          hits.push({
            file: entry.file,
            kind: "dependency-key",
            field,
            before: key,
          });
    }

    for (const [key, value] of Object.entries(pkg.scripts ?? {}))
      if (typeof value === "string" && commandTarget(value, selected) !== value)
        hits.push({ file: entry.file, kind: "package-script", field: key });
  }

  for (const module of bindings.modules)
    if (
      !legacyFixture(module.file) &&
      moduleTarget(module.before, selected, false)
    )
      hits.push({
        file: module.file,
        kind: "module-specifier",
        before: module.before,
      });

  for (const file of bindings.files) {
    if (
      file !== "turbo.json" &&
      !/(?:^|\/)(?:tsconfig[^/]*|\.oxlintrc[^/]*)\.json$/.test(file)
    )
      continue;
    const parsed = parse(file, readFileSync(resolve(root, file), "utf8"));

    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) {
        const value = node.text;
        const boundary = value.indexOf("#");
        const task = boundary === -1 ? undefined : value.slice(0, boundary);

        const filter = value.startsWith("--filter=")
          ? value.slice(9).replace(/\.\.\.$/, "")
          : undefined;

        if (
          moduleTarget(value, selected, false) ||
          selected.has(task) ||
          selected.has(filter)
        )
          hits.push({ file, kind: "build-config", before: value });
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return hits;
}

export function materializePathOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
}) {
  return {
    schema: 1,
    candidate: { root, owner },
    operations: bindings.pathMap.map((path, index) => ({
      id: `path-${String(index + 1).padStart(6, "0")}`,
      rule_id: "R15",
      ledger_ids: ["ROOT-001", "ROOT-002", "APP-054"],
      proof_ids: ["V01-source-transform", "V09-packages"],
      migration_ids: [],
      owner,
      selector: { kind: "path", file: path.before, target: path.after },
    })),
  };
}

export function materializeSymbolOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  names,
  includeSerialized = false,
  canonicalModules = [],
  aliasedModuleMembers = {},
}) {
  const canonicalModuleNames = new Set(canonicalModules);
  const files = bindings.files ?? sourcePaths(root);

  const contents = new Map(
    files
      .filter((file) => isScript(file) || basename(file) === "package.json")
      .map((file) => [file, readFileSync(resolve(root, file), "utf8")]),
  );

  const selectedNames = names === undefined ? null : new Set(names);

  const entryNames =
    selectedNames === null
      ? null
      : new Set([
          ...selectedNames,
          ...Object.values(aliasedModuleMembers).flatMap((members) =>
            Object.keys(members),
          ),
        ]);

  const entryFiles =
    entryNames === null
      ? files
      : files.filter((file) => {
          if (!isScript(file)) return false;
          const text = contents.get(file);

          if (![...entryNames].some((name) => text.includes(name)))
            return false;
          const parsed = parse(file, text);
          let relevant = false;

          const visit = (node) => {
            if (ts.isIdentifier(node) && entryNames.has(node.text))
              relevant = true;

            if (
              ts.isStringLiteralLike(node) &&
              entryNames.has(node.text) &&
              ((ts.isElementAccessExpression(node.parent) &&
                node.parent.argumentExpression === node) ||
                ((ts.isPropertyAssignment(node.parent) ||
                  ts.isPropertySignature(node.parent)) &&
                  node.parent.name === node))
            )
              relevant = true;
            ts.forEachChild(node, visit);
          };

          visit(parsed);

          return relevant;
        });

  const resolver = createSymbolResolver(root, files, contents, entryFiles);
  const edits = new Map();
  const operationByReference = new Map();
  const proposalByDeclaration = new Map();
  const operations = [];
  const refusals = [];
  const parsedByFile = new Map();

  const canonicalImportReference = (item, declaration) => {
    if (item.after !== `${item.before} as ${declaration.proposed}`)
      return item.after;
    let parsed = parsedByFile.get(item.file);

    if (!parsed) {
      parsed = parse(item.file, contents.get(item.file));
      parsedByFile.set(item.file, parsed);
    }

    let moduleOwner;

    const visit = (node) => {
      if (ts.isIdentifier(node) && node.getStart(parsed) === item.start) {
        if (ts.isImportSpecifier(node.parent) && !node.parent.propertyName)
          moduleOwner = node.parent.parent.parent.parent;

        if (ts.isExportSpecifier(node.parent) && !node.parent.propertyName)
          moduleOwner = node.parent.parent.parent;
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
    const specifier = moduleOwner?.moduleSpecifier?.text;

    return typeof specifier === "string" &&
      (resolver.ownsModule(specifier, item.file) ||
        canonicalModuleNames.has(specifier))
      ? declaration.proposed
      : item.after;
  };

  const composeShorthand = (previous, current) => {
    let parsed = parsedByFile.get(current.file);

    if (!parsed) {
      parsed = parse(current.file, contents.get(current.file));
      parsedByFile.set(current.file, parsed);
    }

    let shorthand = false;

    const visit = (node) => {
      if (
        (ts.isShorthandPropertyAssignment(node) ||
          (ts.isBindingElement(node) &&
            !node.propertyName &&
            ts.isIdentifier(node.name))) &&
        node.name.getStart(parsed) === current.start &&
        node.name.text === current.before
      )
        shorthand = true;
      ts.forEachChild(node, visit);
    };

    visit(parsed);

    if (!shorthand || previous.before !== current.before) return undefined;

    const slots = (value) => {
      const parts = value.split(": ");

      if (
        parts.length > 2 ||
        parts.some((part) => !ts.isIdentifierText(part, ts.ScriptTarget.Latest))
      )
        return undefined;

      return parts.length === 1 ? [parts[0], parts[0]] : parts;
    };

    const first = slots(previous.after);
    const second = slots(current.after);

    if (!first || !second) return undefined;

    const result = first.map((value, index) => {
      if (value === current.before) return second[index];

      if (second[index] === current.before || second[index] === value)
        return value;
      throw new Error(
        `Conflicting shorthand slot at ${current.file}:${current.start}`,
      );
    });

    return result[0] === result[1] ? result[0] : result.join(": ");
  };

  try {
    const importedKinds = new Set([
      "ImportSpecifier",
      "ImportClause",
      "NamespaceImport",
      "ExportSpecifier",
    ]);

    const canonicalOwners = new Set([
      "packages/plugin-sdk/src/backend-contract.ts",
      "packages/plugin-sdk/src/app-contract.ts",
      "packages/sdk/src/core.ts",
      "packages/sdk/src/response.ts",
      "apps/app/src/lib/plugin-sdk-hooks.ts",
    ]);

    const priority = (declaration) =>
      importedKinds.has(declaration.declarationKind)
        ? 4
        : canonicalOwners.has(declaration.file)
          ? 0
          : /\.test\.[cm]?[jt]sx?$/.test(declaration.file)
            ? 3
            : declaration.declarationKind === "BindingElement"
              ? 2
              : 1;

    const declarations = [...bindings.declarations].sort(
      (a, b) => priority(a) - priority(b),
    );

    for (const declaration of declarations) {
      if (
        legacyFixture(declaration.file) ||
        !declaration.proposed ||
        (!includeSerialized && declaration.serialized) ||
        (selectedNames && !selectedNames.has(declaration.before))
      )
        continue;
      const key = `${declaration.file}:${declaration.position}`;
      const proposed = proposalByDeclaration.get(key);

      if (proposed !== undefined && proposed !== declaration.proposed) {
        refusals.push({
          ...declaration,
          reason: `Conflicting declaration targets ${proposed} and ${declaration.proposed}`,
        });
        continue;
      }

      proposalByDeclaration.set(key, declaration.proposed);

      if (edits.has(key) && declaration.declarationKind !== "BindingElement")
        continue;

      try {
        const references = resolver.resolve({
          file: declaration.file,
          position: declaration.position,
          before: declaration.before,
          after: declaration.proposed,
        });

        for (const item of references) {
          if (legacyFixture(item.file)) continue;
          item.after = canonicalImportReference(item, declaration);
          const identity = `${item.file}:${item.start}`;
          const previous = edits.get(identity);

          if (previous) {
            if (previous.after !== item.after) {
              const composed = composeShorthand(previous, item);

              if (composed === undefined)
                throw new Error(
                  `Semantic mappings differ at ${item.file}:${item.start}: ${previous.after} versus ${item.after}`,
                );
              previous.after = composed;
              const operation = operationByReference.get(identity);
              operation.selector.after = composed;
              operation.selector.context += `; paired with ${declaration.file}:${declaration.position}`;

              if (item.serialized) {
                operation.selector.serialized = true;
                operation.migration_ids = ["S07"];
              }
            }

            continue;
          }

          edits.set(identity, item);
          operationByReference.set(identity, {
            id: `symbol-${String(operations.length + 1).padStart(7, "0")}`,
            rule_id: targets.has(declaration.before) ? "R04" : "R06",
            ledger_ids: ["PKG-010", "PKG-011", "PLG-004"],
            proof_ids: ["V01-source-transform", "V09-packages"],
            migration_ids: item.serialized ? ["S07"] : [],
            owner,
            selector: {
              kind: "span",
              file: item.file,
              start: item.start,
              before: item.before,
              after: item.after,
              serialized: item.serialized,
              context: `TypeScript language-service reference to ${declaration.file}:${declaration.position} ${declaration.before}`,
            },
          });
          operations.push(operationByReference.get(identity));
        }
      } catch (error) {
        refusals.push({ ...declaration, reason: error.message });
      }
    }

    const aliasEntryFiles = Object.keys(aliasedModuleMembers).length
      ? entryFiles
      : [];

    for (const file of aliasEntryFiles) {
      const parsed = parsedByFile.get(file) ?? parse(file, contents.get(file));

      for (const statement of parsed.statements) {
        if (
          !(
            ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)
          ) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteralLike(statement.moduleSpecifier)
        )
          continue;
        const specifier = statement.moduleSpecifier.text;
        const members = aliasedModuleMembers[specifier];

        if (members === undefined) continue;

        if (
          !resolver.ownsModule(specifier, file) &&
          !canonicalModuleNames.has(specifier)
        )
          throw new Error(
            `Aliased module export is not owned or explicitly bound: ${specifier}`,
          );

        const clause = ts.isImportDeclaration(statement)
          ? statement.importClause?.namedBindings
          : statement.exportClause;

        if (
          !clause ||
          !(ts.isNamedImports(clause) || ts.isNamedExports(clause))
        )
          continue;

        for (const binding of clause.elements) {
          if (!binding.propertyName || !ts.isIdentifier(binding.propertyName))
            continue;
          const before = binding.propertyName.text;
          const after = members[before];

          if (after === undefined || before === after) continue;

          if (
            !ts.isIdentifierText(after, ts.ScriptTarget.Latest) ||
            !resolver.hasExport(specifier, after, file)
          )
            throw new Error(
              `Canonical export ${specifier}:${after} does not exist in the resolved module`,
            );
          const start = binding.propertyName.getStart(parsed);
          const identity = `${file}:${start}`;
          const previous = edits.get(identity);

          if (previous) {
            if (previous.after !== after)
              throw new Error(`Aliased module export conflicts at ${identity}`);
            continue;
          }

          edits.set(identity, { after });
          operations.push({
            id: `module-member-${String(operations.length + 1).padStart(7, "0")}`,
            rule_id: "R04",
            ledger_ids: ["PKG-010", "PLG-004"],
            proof_ids: ["V01-source-transform", "V09-packages"],
            migration_ids: [],
            owner,
            selector: {
              kind: "span",
              file,
              start,
              before,
              after,
              serialized: false,
              context: `Aliased ${specifier} export ${before}; target ${after} verified in resolved module export table`,
            },
          });
        }
      }
    }
  } finally {
    resolver.dispose();
  }

  const inputFiles = [
    ...new Set(operations.map((operation) => operation.selector.file)),
  ];

  const inputs = inputFiles.map((file) => ({
    file,
    digest: hash(contents.get(file)),
  }));

  return {
    schema: 1,
    candidate: { root, owner },
    operations,
    refusals,
    inputs,
  };
}

export function bindUntouchedFileDeferrals({ root, manifest, phase = "P3" }) {
  const canonicalRoot = realpathSync(root);

  const explicitlyDeferred = new Set(
    manifest.operations
      .filter(
        ({ selector }) =>
          selector.kind === "defer" &&
          selector.start === undefined &&
          selector.length === undefined &&
          selector.pathOnly !== true,
      )
      .map(({ selector }) => selector.file),
  );

  const selected = manifest.operations.filter(
    (operation) => !["defer", "preserve"].includes(operation.selector.kind),
  );

  const operations = [...manifest.operations];

  for (const file of sourcePaths(canonicalRoot)) {
    if (
      explicitlyDeferred.has(file) ||
      selected.some(
        (operation) =>
          operation.selector.file === file ||
          (operation.selector.kind === "path" &&
            file.startsWith(`${operation.selector.file}/`)),
      )
    )
      continue;
    const absolute = resolve(canonicalRoot, file);

    if (realpathSync(absolute) !== absolute)
      throw new Error("Deferral cannot traverse a symlink");
    operations.push({
      id: `untouched-${String(operations.length + 1).padStart(7, "0")}`,
      rule_id: "R06",
      ledger_ids: ["PKG-011"],
      proof_ids: ["V01-source-transform"],
      migration_ids: [],
      owner: manifest.candidate.owner,
      selector: {
        kind: "defer",
        file,
        digest: hash(readFileSync(absolute)),
        phase,
        reason:
          "Exact untouched file remains owned by later source/state/asset wave; no edit permitted",
      },
    });
  }

  return { ...manifest, operations };
}

export function deferRemainingCandidates({ root, manifest, plan }) {
  const files = new Map(plan.universe.map((file) => [file.path, file]));
  const operations = [...manifest.operations];
  const unknown = new Map();

  for (const candidate of plan.unresolved) {
    const entries = unknown.get(candidate.file) ?? [];
    entries.push(candidate);
    unknown.set(candidate.file, entries);
  }

  for (const [file, candidates] of unknown) {
    const entry = files.get(file);

    if (
      !plan.files.some((edited) => edited.input_path === file) ||
      candidates.some((candidate) => candidate.context === "unparsed")
    ) {
      if (plan.files.some((edited) => edited.input_path === file))
        throw new Error(`Path/unparsed work must join the same wave: ${file}`);
      operations.push({
        id: `defer-file-${operations.length}`,
        rule_id: "R06",
        ledger_ids: ["PKG-011"],
        proof_ids: ["V01-source-transform"],
        migration_ids: [],
        owner: manifest.candidate.owner,
        selector: {
          kind: "defer",
          file,
          digest: entry.digest,
          phase: "P3",
          reason:
            "Retained exact file for later owned source/state transformation wave",
        },
      });
      continue;
    }

    for (const candidate of candidates)
      operations.push({
        id: `defer-range-${operations.length}`,
        rule_id: "R06",
        ledger_ids: ["PKG-011"],
        proof_ids: ["V01-source-transform"],
        migration_ids: [],
        owner: manifest.candidate.owner,
        selector: {
          kind: "defer",
          file,
          digest: entry.digest,
          ...(candidate.context === "path"
            ? { pathOnly: true }
            : { start: candidate.start, length: candidate.length }),
          phase: "P3",
          reason:
            "Exact pending symbol/state/copy context; this wave does not authorize changing it",
        },
      });
  }

  return { ...manifest, operations };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(process.argv[2]);
  const output = process.argv[3];
  const report = collectSourceBindings(root);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({
      packages: report.packages.length,
      declarations: report.declarations.length,
      modules: report.modules.length,
      paths: report.pathMap.length,
      collisions: report.collisions.length,
      output,
    }),
  );
}
