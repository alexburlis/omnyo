import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { collectSourceBindings } from "./omnyo-source-map.mjs";

const humanFields = new Set([
  "title",
  "description",
  "summary",
  "message",
  "label",
  "ariaLabel",
  "aria-label",
  "alt",
  "placeholder",
  "primaryLabel",
  "actionLabel",
  "openLabel",
  "tagline",
  "headlineLead",
  "frameTitlePrefix",
  "builtInDescription",
  "name",
]);

const copyArrays = new Set(["bullets", "firstParty"]);

const comparisonDisplayFields = new Set([
  "question",
  "headline",
  "sub",
  "body",
  "text",
]);

const brandPattern = /(?<![\w./:@-])(?:BB|bb|Omni)(?![\w/@-]|[.:][\w])/g;

const legalPattern = /\b(?:MIT|licen[cs]e|copyright|upstream|open.source)\b/i;

const legacyPattern = /legacy.*v1|V1$/i;

function currentCopyOwner(file) {
  return (
    /^(?:apps\/(?:app|web)\/src\/.*\.tsx|plugins\/plugin-api-docs\/src\/.*\.[jt]sx?|apps\/cli\/src\/(?:commands\/[^/]+|index)\.ts|plugins\/[^/]+\/package\.json)$/.test(
      file,
    ) &&
    !/\.test\.|\.stories\.|(?:privacy|terms|legal|license)|\/generated\//i.test(
      file,
    )
  );
}

function finiteLegacyNode(node) {
  for (let parent = node; parent; parent = parent.parent)
    if (parent.name && legacyPattern.test(parent.name.text ?? "")) return true;

  return false;
}

function outerLiteral(node) {
  let current = node;

  while (
    ts.isTemplateSpan(current.parent) ||
    ts.isTemplateExpression(current.parent) ||
    (ts.isBinaryExpression(current.parent) &&
      current.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
  )
    current = current.parent;

  return current;
}

function humanContext(node, file) {
  if (ts.isJsxText(node)) return "JSX product copy";
  const literal = outerLiteral(node);
  const parent = literal.parent;

  if (ts.isJsxAttribute(parent) && humanFields.has(parent.name.text))
    return `JSX ${parent.name.text}`;

  if (
    file.startsWith("apps/web/src/compare/") &&
    ts.isPropertyAssignment(parent) &&
    comparisonDisplayFields.has(parent.name.text)
  )
    return `Current comparison ${parent.name.text}`;

  if (ts.isPropertyAssignment(parent) && humanFields.has(parent.name.text)) {
    if (file.endsWith("package.json")) {
      const fields = [];

      for (let current = parent; current; current = current.parent)
        if (ts.isPropertyAssignment(current)) fields.unshift(current.name.text);
      const path = fields.join(".");

      return ["omnyo.name", "omnyo.description", "description"].includes(path)
        ? `Current private package ${path}`
        : null;
    }

    return `Product display ${parent.name.text}`;
  }

  if (
    ts.isVariableDeclaration(parent) &&
    /(?:LABEL|DESCRIPTION|MESSAGE|WARNING|TITLE|HEADING)$/i.test(
      parent.name.getText(),
    )
  )
    return "Product display constant";

  if (
    ts.isArrayLiteralExpression(parent) &&
    file.startsWith("plugins/plugin-api-docs/src/")
  ) {
    let current = parent;

    while (current && !ts.isPropertyAssignment(current))
      current = current.parent;

    if (current && copyArrays.has(current.name.text))
      return "Current Plugin Guide display copy";
  }

  if (ts.isCallExpression(parent)) {
    const call = parent.expression.getText();

    if (
      file.startsWith("apps/web/src/compare/") &&
      ["cell", "linkedCell", "price"].includes(call) &&
      parent.arguments[1] === literal
    )
      return "Current comparison cell display";

    if (/\.(?:description|usage|help|addHelpText)$/.test(call))
      return "Current CLI help";

    if (
      file.startsWith("apps/cli/src/commands/") &&
      /\.(?:option|requiredOption)$/.test(call) &&
      parent.arguments[1] === literal
    )
      return "Current CLI option help";

    if (
      /^(?:console\.(?:log|error|warn)|printInfo|printSuccess|printError)$/.test(
        call,
      )
    )
      return "Current command output";
  }

  if (
    file.startsWith("apps/cli/src/commands/") &&
    ts.isNewExpression(parent) &&
    parent.expression.getText() === "Error"
  )
    return "Current CLI error message";

  if (
    file === "apps/cli/src/commands/plugin.ts" &&
    ts.isArrayLiteralExpression(parent)
  ) {
    for (let current = parent.parent; current; current = current.parent)
      if (ts.isFunctionDeclaration(current))
        return current.name?.text === "installPlanSummary"
          ? "Current plugin install summary"
          : null;
  }

  if (
    ts.isConditionalExpression(parent) ||
    ts.isBinaryExpression(parent) ||
    ts.isReturnStatement(parent)
  )
    return file.endsWith(".tsx")
      ? "Current rendered message"
      : file.startsWith("apps/cli/src/commands/")
        ? "Current CLI display message"
        : null;

  return null;
}

function precedingTemplateBackticks(node, source, text) {
  const parent = node.parent;

  const template = ts.isTemplateExpression(parent)
    ? parent
    : ts.isTemplateSpan(parent)
      ? parent.parent
      : null;

  if (template === null || !ts.isTemplateExpression(template)) return 0;
  let count = 0;

  for (const chunk of [
    template.head,
    ...template.templateSpans.map((span) => span.literal),
  ]) {
    if (chunk === node) return count;

    const end =
      chunk.end -
      (ts.isTemplateHead(chunk) || ts.isTemplateMiddle(chunk) ? 2 : 1);

    count +=
      text.slice(chunk.getStart(source) + 1, end).match(/`/g)?.length ?? 0;
  }

  return 0;
}

function copyTarget(
  raw,
  commandOnly,
  precedingBackticks = 0,
  comparisonDisplay = false,
) {
  if (
    legalPattern.test(raw) &&
    (!comparisonDisplay || /\b(?:copyright|upstream)\b/i.test(raw))
  )
    return raw;

  const protectedRanges = [
    ...raw.matchAll(
      /https?:\/\/[^\s<>"'`]+|(?:~|\/Users|\/home|[A-Z]:\\)[^\s<>"'`]+/g,
    ),
  ].map((match) => [match.index, match.index + match[0].length]);

  return raw.replace(brandPattern, (value, index) => {
    if (protectedRanges.some(([start, end]) => index >= start && index < end))
      return value;
    const prefix = raw.slice(0, index);
    const suffix = raw.slice(index + value.length);

    const codeSpan =
      (precedingBackticks + (prefix.match(/`/g)?.length ?? 0)) % 2 === 1;

    const command =
      commandOnly ||
      codeSpan ||
      (/(?:\b(?:run|npx|exec)|\$)\s+$/i.test(prefix) &&
        (!comparisonDisplay ||
          /^\s+(?:thread|plugin|server|browser|machine|project|updates|settings|skill|workflow|help|--[a-z])(?:\s|$)/.test(
            suffix,
          ))) ||
      /\b(?:command|usage:)\s*["']?$/i.test(prefix) ||
      (prefix.trim() === "" &&
        /^\s+(?:thread|plugin|server|browser|machine|project|updates|settings|skill|workflow|help|--[a-z])(?:\s|$)/.test(
          suffix,
        ));

    return command && !/^['’]s\b/.test(suffix) ? "omnyo" : "Omnyo";
  });
}

export function materializeCurrentCopyOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  excludeFiles = [],
}) {
  const excluded = new Set(excludeFiles);
  const operations = [];
  const pairs = new Map();
  const files = bindings.files;

  const append = (file, start, before, after, context) =>
    operations.push({
      id: `copy-${operations.length + 1}`,
      rule_id: "R16",
      ledger_ids: ["APP-004", "APP-018", "PLG-028"],
      proof_ids: ["V01-source-transform", "V10-surfaces"],
      migration_ids: [],
      owner,
      selector: {
        kind: "span",
        file,
        start,
        before,
        after,
        serialized: false,
        context,
      },
    });

  for (const file of files) {
    if (excluded.has(file) || !currentCopyOwner(file)) continue;
    const text = readFileSync(resolve(root, file), "utf8");

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".json") ? ts.ScriptKind.JSON : undefined,
    );

    if (source.parseDiagnostics.length)
      throw new Error(`Cannot classify current copy in ${file}`);

    const visit = (node) => {
      if (finiteLegacyNode(node)) return;

      if (
        ts.isStringLiteralLike(node) ||
        ts.isJsxText(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const context = humanContext(node, file);
        const start = node.getStart(source) + (ts.isJsxText(node) ? 0 : 1);

        const end =
          node.end -
          (ts.isJsxText(node)
            ? 0
            : ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
              ? 2
              : 1);

        const before = text.slice(start, end);

        const standaloneDisplay =
          context?.startsWith("Current comparison") ||
          ts.isJsxText(node) ||
          ts.isJsxAttribute(node.parent) ||
          (ts.isPropertyAssignment(node.parent) &&
            humanFields.has(node.parent.name.text));

        if (
          context &&
          (standaloneDisplay || /\s/.test(before)) &&
          !/^\[bb\]/.test(before)
        ) {
          const after = copyTarget(
            before,
            context === "Current CLI help" && /^bb(?:\s|$)/.test(before),
            precedingTemplateBackticks(node, source, text),
            file.startsWith("apps/web/src/compare/"),
          );

          if (before !== after) {
            append(file, start, before, after, context);

            if (pairs.has(before) && pairs.get(before) !== after)
              throw new Error("Copy context target disagreement");
            pairs.set(before, after);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  for (const file of files) {
    if (
      excluded.has(file) ||
      !/\.(?:test|stories)\.[cm]?[jt]sx?$/.test(file) ||
      !/^(?:apps\/(?:app|web|cli)\/|plugins\/plugin-api-docs\/)/.test(file)
    )
      continue;
    const text = readFileSync(resolve(root, file), "utf8");

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) {
        const start = node.getStart(source) + 1;
        const before = text.slice(start, node.end - 1);
        const after = pairs.get(before);

        if (after !== undefined)
          append(
            file,
            start,
            before,
            after,
            "Exact assertion/story value coupled to classified current product copy",
          );
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  const inputs = [
    ...new Set(operations.map((operation) => operation.selector.file)),
  ].map((file) => ({
    file,
    digest: createHash("sha256")
      .update(readFileSync(resolve(root, file)))
      .digest("hex"),
  }));

  return { schema: 1, candidate: { root, owner }, operations, inputs };
}
