import ts from "typescript";

export const LEGACY_SDK_PACKAGE_NAMES_V1 = [
  "@get-bb/plugin-sdk",
  "@bb/plugin-sdk",
] as const;

export const LEGACY_VENDORED_DECLARATIONS_V1 = [
  "bb-plugin-sdk.d.ts",
  "bb-plugin-sdk-app.d.ts",
] as const;

const legacyExportNamesV1 = new Map([
  ["BbPluginApi", "PluginApi"],
  ["PluginBbSdk", "PluginSdk"],
  ["useBbContext", "experimental_useAppContext"],
  ["useBbNavigate", "experimental_useAppNavigate"],
  ["BbContext", "experimental_AppContext"],
  ["BbNavigate", "experimental_AppNavigate"],
  ["PluginBrowserBbSdk", "experimental_PluginBrowserSdk"],
]);

function canonicalSdkModuleV1(value: string): string | null {
  for (const before of LEGACY_SDK_PACKAGE_NAMES_V1) {
    if (value === before || value.startsWith(`${before}/`))
      return `@omnyo/plugin-sdk${value.slice(before.length)}`;
  }

  return value === "@omnyo/plugin-sdk" || value.startsWith("@omnyo/plugin-sdk/")
    ? value
    : null;
}

export function rewriteLegacySdkSourceV1(
  file: string,
  source: string,
): { text: string; imports: number } {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const host = ts.createCompilerHost({ noResolve: true, noLib: true });
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, create) =>
    name === file ? parsed : original(name, version, onError, create);

  const program = ts.createProgram(
    [file],
    { noResolve: true, noLib: true },
    host,
  );

  if (program.getSyntacticDiagnostics(parsed).length > 0)
    throw new Error(`Cannot parse legacy plugin source ${file}`);
  const checker = program.getTypeChecker();
  const namespaces = new Set<ts.Symbol>();
  const edits: { start: number; before: string; after: string }[] = [];
  let imports = 0;

  const add = (start: number, before: string, after: string) => {
    if (before !== after) edits.push({ start, before, after });
  };

  for (const statement of parsed.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier;
    const target = canonicalSdkModuleV1(specifier.text);

    if (target === null) continue;

    if (target !== specifier.text) {
      add(
        specifier.getStart(parsed) + 1,
        source.slice(specifier.getStart(parsed) + 1, specifier.end - 1),
        target,
      );
      imports += 1;
    }

    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;

    if (bindings && ts.isNamespaceImport(bindings)) {
      const symbol = checker.getSymbolAtLocation(bindings.name);

      if (symbol) namespaces.add(symbol);
    }

    if (
      !bindings ||
      !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
    )
      continue;

    for (const binding of bindings.elements) {
      const name = binding.propertyName ?? binding.name;
      const after = legacyExportNamesV1.get(name.text);

      if (after === undefined) continue;
      add(
        name.getStart(parsed),
        name.getText(parsed),
        binding.propertyName ? after : `${after} as ${name.text}`,
      );
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const after = legacyExportNamesV1.get(node.name.text);

      if (symbol && namespaces.has(symbol) && after)
        add(node.name.getStart(parsed), node.name.text, after);
    }

    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left);
      const after = legacyExportNamesV1.get(node.right.text);

      if (symbol && namespaces.has(symbol) && after)
        add(node.right.getStart(parsed), node.right.text, after);
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);
  let text = source;

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (text.slice(edit.start, edit.start + edit.before.length) !== edit.before)
      throw new Error(`Legacy source edit drift ${file}`);
    text =
      text.slice(0, edit.start) +
      edit.after +
      text.slice(edit.start + edit.before.length);
  }

  return { text, imports: imports + (edits.length > imports ? 1 : 0) };
}

export function importLegacySdkManifestV1(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = { ...input };

  const identity = (value: unknown) =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
          )
        : entry,
    );

  if (manifest.bb !== undefined) {
    if (
      manifest.omnyo !== undefined &&
      identity(manifest.bb) !== identity(manifest.omnyo)
    )
      throw new Error("Conflicting legacy and canonical plugin metadata");
    manifest.omnyo ??= manifest.bb;
    delete manifest.bb;
  }

  if (manifest.engines !== undefined) {
    const value = manifest.engines;

    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Plugin engines must be an object");
    const engines: Record<string, unknown> = { ...value };

    for (const [before, after] of [
      ["bb", "omnyo"],
      ["bbPluginSdk", "omnyoPluginSdk"],
    ] as const) {
      if (engines[before] === undefined) continue;

      if (engines[after] !== undefined && engines[before] !== engines[after])
        throw new Error(
          "Conflicting legacy and canonical plugin engine requirements",
        );
      engines[after] ??= engines[before];
      delete engines[before];
    }

    manifest.engines = engines;
  }

  return manifest;
}
