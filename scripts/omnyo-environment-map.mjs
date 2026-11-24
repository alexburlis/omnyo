import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function targetMap(pairs) {
  const result = new Map();
  const destinations = new Set();

  for (const [before, after] of pairs) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(before) || !/^[A-Z][A-Z0-9_]*$/u.test(after))
      throw new Error("Environment mappings require exact portable names");

    if (result.has(before) || destinations.has(after) || before === after)
      throw new Error("Environment mapping is not injective");
    result.set(before, after);
    destinations.add(after);
  }

  return result;
}

function declarationTarget(name, names) {
  if (names.has(name)) return names.get(name);

  for (const [before, after] of names) {
    if (name === `${before}_ENV`) return `${after}_ENV`;

    if (name === `DEFAULT_${before}`) return `DEFAULT_${after}`;
  }

  return undefined;
}

function literalContext(node, source) {
  const parent = node.parent;

  if (
    ts.isLiteralTypeNode(parent) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
  )
    return "typed environment field";

  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
    parent.name === node
  )
    return "environment object key";

  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    parent.name.getText(source) === "name"
  )
    return "environment definition name";

  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(source);

    if (
      /(?:stubEnv|unstubEnvs|readEnv|Environment|EnvName|\.delete|\.has|\.get)$/u.test(
        callee,
      )
    )
      return "environment boundary argument";
  }

  return undefined;
}

export function materializeEnvironmentOperations({
  root,
  owner,
  files,
  pairs,
  literalFiles = [],
  embeddedFiles = [],
}) {
  const names = targetMap(pairs);

  const embeddedPattern = new RegExp(
    `(?<![A-Z0-9_])(?:${[...names.keys()].join("|")})(?![A-Z0-9_])`,
    "gu",
  );

  const reviewedLiteralFiles = new Set(literalFiles);
  const reviewedEmbeddedFiles = new Set(embeddedFiles);
  const operations = [];
  const unresolved = [];
  const refusals = [];
  const inputs = [];

  for (const file of files) {
    const text = readFileSync(resolve(root, file), "utf8");

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    if (source.parseDiagnostics.length) {
      refusals.push({ file, reason: "Environment source does not parse" });
      continue;
    }

    const selected = [];

    const visit = (node) => {
      let after;
      let start = node.getStart(source);
      let before;
      let context;

      if (ts.isIdentifier(node)) {
        before = node.text;
        after = declarationTarget(before, names);
        context = "Exact owned environment field or declaration";
      } else if (ts.isStringLiteralLike(node) && names.has(node.text)) {
        before = node.text;
        after = names.get(before);
        start += 1;
        context = literalContext(node, source);

        if (!context && reviewedLiteralFiles.has(file))
          context = "Reviewed current environment contract literal";

        if (!context) {
          unresolved.push({
            file,
            start,
            before,
            context: ts.SyntaxKind[node.parent.kind],
          });
          after = undefined;
        }
      } else if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        node.kind === ts.SyntaxKind.RegularExpressionLiteral
      ) {
        const raw = node.getText(source);

        for (const match of raw.matchAll(embeddedPattern)) {
          const oldName = match[0];
          const newName = names.get(oldName);
          const position = node.getStart(source) + match.index;

          if (!reviewedEmbeddedFiles.has(file)) {
            unresolved.push({
              file,
              start: position,
              before: oldName,
              context: "Unclassified embedded environment token",
            });
            continue;
          }

          selected.push({
            node,
            start: position,
            before: oldName,
            after: newName,
            context:
              "Reviewed embedded shell, message, regex or code environment contract",
          });
        }
      }

      if (after !== undefined)
        selected.push({ node, start, before, after, context });
      ts.forEachChild(node, visit);
    };

    visit(source);

    const selectedAt = new Map(
      selected.map((entry) => [entry.node, entry.after]),
    );

    const checkDuplicates = (node) => {
      if (ts.isArrayLiteralExpression(node)) {
        const values = new Set(
          node.elements
            .filter(ts.isStringLiteralLike)
            .map((entry) => entry.text),
        );

        for (const [before, after] of names) {
          if (values.has(before) && values.has(after))
            refusals.push({
              file,
              reason: `Mixed legacy/current environment list requires its versioned owner: ${before}`,
            });
        }
      }

      const members = ts.isObjectLiteralExpression(node)
        ? node.properties
        : ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)
          ? node.members
          : undefined;

      if (members) {
        const seen = new Map();

        for (const member of members) {
          if (
            !member.name ||
            (!ts.isIdentifier(member.name) &&
              !ts.isStringLiteralLike(member.name))
          )
            continue;
          const original = member.name.text;
          const target = selectedAt.get(member.name) ?? original;
          const previous = seen.get(target);

          if (previous !== undefined && previous !== original)
            refusals.push({
              file,
              reason: `Environment field collision at ${target}`,
            });
          seen.set(target, original);
        }
      }

      ts.forEachChild(node, checkDuplicates);
    };

    checkDuplicates(source);

    if (selected.length) inputs.push({ file, digest: digest(text) });

    for (const item of selected) {
      operations.push({
        id: `environment-${String(operations.length + 1).padStart(7, "0")}`,
        rule_id: "R10",
        ledger_ids: [
          "APP-019",
          "APP-027",
          "APP-030",
          "PKG-003",
          "PKG-031",
          "PKG-041",
          "PLG-008",
          "PLG-011",
          "PLG-025",
          "ROOT-010",
          "ROOT-012",
        ],
        proof_ids: ["V01-source-transform", "V06-state-continuity"],
        migration_ids: ["S01"],
        owner,
        selector: {
          kind: "span",
          file,
          start: item.start,
          before: item.before,
          after: item.after,
          serialized: true,
          context: `${item.context}; finite environment namespace mapping`,
        },
      });
    }
  }

  return {
    schema: 1,
    candidate: { root, owner },
    operations,
    unresolved,
    refusals,
    inputs,
  };
}
