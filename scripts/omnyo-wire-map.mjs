import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { collectSourceBindings } from "./omnyo-source-map.mjs";

const ownedWireHeaderNames = [
  "account-pool-token",
  "app-surface",
  "archive-sha256",
  "artifact-sha256",
  "cache",
  "cloud-dev-host",
  "composer-prediction-token",
  "connect-code",
  "connect-machine",
  "direct-proof",
  "gate-auth",
  "gate-machine-id",
  "gate-owner",
  "plugin-caller",
  "plugin-token",
  "relay",
  "relay-content-length",
  "relay-has-body",
  "relay-method",
  "tunnel-offline",
  "tunnel-status",
  "tunnel-target",
  "web-source",
];

const headerPattern = new RegExp(
  `(?<![\\w-])x-bb-(?:${ownedWireHeaderNames.sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`,
  "gi",
);

function versionedInput(node) {
  for (let parent = node; parent; parent = parent.parent)
    if (parent.name && /(?:legacy.*v1|V1)$/.test(parent.name.text ?? ""))
      return true;

  return false;
}

export function materializeWireHeaderOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  excludeFiles = [],
}) {
  const excluded = new Set(excludeFiles);
  const operations = [];

  const append = (file, start, before, after) =>
    operations.push({
      id: `wire-${operations.length + 1}`,
      rule_id: "R09",
      ledger_ids: ["APP-017", "APP-035", "APP-036", "PKG-014", "PKG-027"],
      proof_ids: ["V01-source-transform", "V06-authority", "V10-surfaces"],
      migration_ids: ["S04", "S07"],
      owner,
      selector: {
        kind: "span",
        file,
        start,
        before,
        after,
        serialized: true,
        context:
          "Exact current owned HTTP header or runtime artifact route, excluding finite V1 inputs and opaque custom headers",
      },
    });

  for (const file of bindings.files) {
    if (
      excluded.has(file) ||
      !/\.[cm]?[jt]sx?$/.test(file) ||
      /^(?:docs\/|scripts\/omnyo-|packages\/scripts\/test\/omnyo-)|(?:^|\/)legacy[^/]*v1\.|(?:^|\/)recordings\/|bb-plugin-sdk-0\.4\.8-scaffold|(?:^|\/)omnyo-[^/]+\.test\./.test(
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
    );

    const selected = new Set();

    const replacements = (start, before) => {
      for (const match of before.matchAll(headerPattern)) {
        const position = start + match.index;

        if (selected.has(position)) continue;
        selected.add(position);
        append(
          file,
          position,
          match[0],
          match[0].toLowerCase().replace("x-bb-", "x-omnyo-"),
        );
      }

      for (const [from, to] of [
        ["/install/bb-app.tgz", "/install/omnyo-app.tgz"],
        ["\\/install\\/bb-app\\.tgz", "\\/install\\/omnyo-app\\.tgz"],
      ]) {
        let index = before.indexOf(from);

        while (index !== -1) {
          const position = start + index;

          if (!selected.has(position)) {
            selected.add(position);
            append(file, position, from, to);
          }

          index = before.indexOf(from, index + from.length);
        }
      }
    };

    const visit = (node) => {
      if (versionedInput(node)) return;

      if (
        ts.isStringLiteralLike(node) &&
        (node.text === "bb-app" || node.text.startsWith("bb-app/"))
      )
        append(
          file,
          node.getStart(parsed) + 1,
          node.text,
          `omnyo-app${node.text.slice(6)}`,
        );

      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isRegularExpressionLiteral(node)
      )
        replacements(
          node.getStart(parsed),
          text.slice(node.getStart(parsed), node.end),
        );

      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        const content = text.slice(range.pos, range.end);

        if (!/copyright|\bMIT\b|oxlint|eslint|@ts-/i.test(content))
          replacements(range.pos, content);
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return { schema: 1, candidate: { root, owner }, operations };
}
