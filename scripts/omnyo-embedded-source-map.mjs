import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { collectSourceBindings, moduleTarget } from "./omnyo-source-map.mjs";
import { brandedCandidates } from "./omnyo-rename/selectors.mjs";

const sdkExports = new Map([
  ["BbPluginApi", "PluginApi"],
  ["PluginBbSdk", "PluginSdk"],
  ["useBbContext", "experimental_useAppContext"],
  ["useBbNavigate", "experimental_useAppNavigate"],
  ["BbContext", "experimental_AppContext"],
  ["BbNavigate", "experimental_AppNavigate"],
  ["PluginBrowserBbSdk", "experimental_PluginBrowserSdk"],
  ["BbHttpError", "OmnyoHttpError"],
  ["createBbSdk", "createOmnyoSdk"],
  ["createNodeBbSdk", "createNodeOmnyoSdk"],
  ["createBrowserBbSdk", "createBrowserOmnyoSdk"],
  ["createCliBbSdk", "createCliOmnyoSdk"],
  ["BBSdk", "OmnyoSdk"],
]);

function finiteOrNegative(node) {
  for (let p = node; p; p = p.parent) {
    if (p.name && /(?:legacy.*v1|V1)$/i.test(p.name.text ?? "")) return true;

    if (
      ts.isCallExpression(p) &&
      ts.isIdentifier(p.expression) &&
      ["it", "test"].includes(p.expression.text) &&
      /retired|legacy|unsupported|outside|invalid|reject|refus|private/i.test(
        p.arguments[0]?.text ?? "",
      )
    )
      return true;
  }

  return false;
}

function ownedContext(node, parsed) {
  const p = node.parent;

  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
    return /source|code|entry/i.test(p.name.text);

  if (ts.isPropertyAssignment(p))
    return /^(?:serverSource|appSource|hostSource|source|code|content|server|app|host)$/.test(
      p.name.text ?? "",
    );

  if (ts.isReturnStatement(p)) {
    for (let a = p.parent; a; a = a.parent)
      if (a.name && /source|code|entry/i.test(a.name.text ?? "")) return true;
  }

  if (ts.isCallExpression(p) && p.arguments.indexOf(node) === 1)
    return /(?:writeFile|writeFileSync)$/.test(p.expression.getText(parsed));

  return false;
}

function embeddedEdits(file, source, packages) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const options = { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, create) =>
    name === file ? parsed : original(name, version, onError, create);
  const program = ts.createProgram([file], options, host);

  if (program.getSyntacticDiagnostics(parsed).length) return null;
  const checker = program.getTypeChecker();
  const aliases = new Map();
  const namespaces = new Set();
  const edits = [];
  const spans = new Set();

  const add = (start, length, after) => {
    const before = source.slice(start, start + length);

    if (before === after) return;
    const key = `${start}:${length}`;

    if (spans.has(key)) return;
    spans.add(key);
    edits.push({ start, before, after });
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

    const after =
      moduleTarget(specifier.text, packages, false) ??
      (/^@omnyo\/(?:plugin-sdk|sdk)(?:\/|$)/.test(specifier.text)
        ? specifier.text
        : undefined);

    if (!after) continue;
    add(
      specifier.getStart(parsed) + 1,
      specifier.end - specifier.getStart(parsed) - 2,
      after,
    );

    if (!/^@omnyo\/(?:plugin-sdk|sdk)(?:\/|$)/.test(after)) continue;

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
      const imported = binding.propertyName ?? binding.name;
      const target = sdkExports.get(imported.text);

      if (!target) continue;

      if (binding.propertyName) {
        add(imported.getStart(parsed), imported.getWidth(parsed), target);
        continue;
      }

      if (ts.isExportSpecifier(binding)) {
        add(
          imported.getStart(parsed),
          imported.getWidth(parsed),
          `${target} as ${imported.text}`,
        );
        continue;
      }

      const symbol = checker.getSymbolAtLocation(binding.name);

      if (!symbol) throw Error(`Unbound embedded SDK import ${file}`);

      if (
        checker
          .getSymbolsInScope(
            binding.name,
            ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias,
          )
          .some((other) => other !== symbol && other.name === target)
      )
        throw Error(`Embedded SDK target collision ${file}:${target}`);
      aliases.set(symbol, target);
    }
  }

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const after = aliases.get(symbol);

      if (after) {
        const value = ts.isShorthandPropertyAssignment(node.parent)
          ? `${node.text}: ${after}`
          : after;

        add(node.getStart(parsed), node.getWidth(parsed), value);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(checker.getSymbolAtLocation(node.expression))
    ) {
      const after = sdkExports.get(node.name.text);

      if (after)
        add(node.name.getStart(parsed), node.name.getWidth(parsed), after);
    }

    if (
      ts.isQualifiedName(node) &&
      ts.isIdentifier(node.left) &&
      namespaces.has(checker.getSymbolAtLocation(node.left))
    ) {
      const after = sdkExports.get(node.right.text);

      if (after)
        add(node.right.getStart(parsed), node.right.getWidth(parsed), after);
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);

  return edits;
}

function decode(raw, quote, rawTemplate) {
  if (rawTemplate) return raw;
  let invalid = false;

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    `${quote}${raw}${quote}`,
    () => {
      invalid = true;
    },
  );

  scanner.scan();

  return invalid ? undefined : scanner.getTokenValue();
}

export function materializeEmbeddedSourceOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  packageIdentities,
}) {
  const identities =
    packageIdentities ??
    JSON.parse(
      readFileSync(
        resolve(root, "docs/omnyo-migration/execution-package-identities.json"),
        "utf8",
      ),
    ).packages;

  const packages = new Map(identities.map((p) => [p.before, p.after]));
  packages.set("@get-bb/plugin-sdk", "@omnyo/plugin-sdk");
  packages.set("@bb/plugin-sdk", "@omnyo/plugin-sdk");
  const operations = [];
  const pending = [];

  const candidatePattern =
    /@(?:get-)?bb\/|\b(?:BbPluginApi|PluginBbSdk|useBbContext|useBbNavigate|BbContext|BbNavigate|PluginBrowserBbSdk|BbHttpError|createBbSdk|createNodeBbSdk|createBrowserBbSdk|createCliBbSdk|BBSdk)\b/;

  for (const file of bindings.files) {
    if (
      !/\.[cm]?[jt]sx?$/.test(file) ||
      /^(?:docs\/|scripts\/omnyo-|packages\/scripts\/test\/omnyo-)|(?:^|\/)legacy[^/]*v1\.|(?:^|\/)omnyo-[^/]+\.test\.|bb-plugin-sdk-0\.4\.8-scaffold|(?:^|\/)recordings\//.test(
        file,
      )
    )
      continue;
    const text = readFileSync(resolve(root, file), "utf8");

    if (!candidatePattern.test(text)) continue;

    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const coverage = brandedCandidates(file, text);

    const visit = (node) => {
      if (finiteOrNegative(node)) return;

      if (
        ts.isTemplateExpression(node) &&
        ownedContext(node, parsed) &&
        candidatePattern.test(text.slice(node.getStart(parsed), node.end))
      )
        pending.push({
          file,
          start: node.getStart(parsed),
          reason:
            "Interpolated owned source requires an exact segment or assembled-source operator",
        });

      if (ts.isStringLiteralLike(node) && ownedContext(node, parsed)) {
        const start = node.getStart(parsed) + 1;
        const raw = text.slice(start, node.end - 1);
        const quote = text[start - 1];

        const rawTemplate =
          ts.isTaggedTemplateExpression(node.parent) &&
          node.parent.tag.getText(parsed) === "String.raw";

        const value = decode(raw, quote, rawTemplate);

        if (typeof value !== "string" || !candidatePattern.test(value)) return;

        const inner = embeddedEdits(
          `${resolve(root, file)}.embedded.tsx`,
          value,
          packages,
        );

        if (inner === null) {
          pending.push({
            file,
            start,
            reason:
              "Owned code context does not form a complete parseable source literal",
          });

          return;
        }

        for (const edit of inner) {
          let position = raw.indexOf(edit.before);

          while (
            position !== -1 &&
            decode(raw.slice(0, position), quote, rawTemplate) !==
              value.slice(0, edit.start)
          )
            position = raw.indexOf(edit.before, position + 1);

          if (position === -1) {
            pending.push({
              file,
              start: start + edit.start,
              reason:
                "Encoded embedded token requires a larger exact raw selector",
            });
            continue;
          }

          let from = start + position;
          let end = from + edit.before.length;
          let after = edit.after;

          for (const c of coverage)
            if (c.start < end && c.start + c.length > from) {
              if (c.start < start || c.start + c.length > node.end - 1)
                throw Error(`Embedded token escaped literal ${file}`);
              const nextStart = Math.min(from, c.start);
              const nextEnd = Math.max(end, c.start + c.length);
              after =
                text.slice(nextStart, from) + after + text.slice(end, nextEnd);
              from = nextStart;
              end = nextEnd;
            }

          operations.push({
            id: `embedded-${operations.length + 1}`,
            rule_id: "R04",
            ledger_ids: ["PKG-010", "PKG-018", "PLG-004"],
            proof_ids: ["V01-source-transform", "V09-packages"],
            migration_ids: ["S07"],
            owner,
            selector: {
              kind: "span",
              file,
              start: from,
              before: text.slice(from, end),
              after,
              context:
                "Parsed owned embedded source module/import binding with pinned TypeScript identity; opaque literals and negative/versioned inputs excluded",
            },
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return { schema: 1, candidate: { root, owner }, operations, pending };
}
