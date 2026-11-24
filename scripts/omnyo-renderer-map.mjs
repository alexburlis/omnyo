import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, basename } from "node:path";
import ts from "typescript";
import { collectSourceBindings } from "./omnyo-source-map.mjs";

const coreActions = new Set([
  "split",
  "newThreadInEnvironment",
  "copyLink",
  "read",
  "pin",
  "shelve",
  "rename",
  "archive",
  "delete",
]);

const coreActionFiles = new Set([
  "apps/app/src/lib/thread-actions/thread-action-registry.tsx",
  "apps/app/src/views/thread-detail/ThreadArchiveCommandHandler.tsx",
  "apps/app/src/views/thread-detail/ThreadShelveCommandHandler.tsx",
  "apps/app/src/views/thread-detail/ThreadCopyLinkCommandHandler.tsx",
  "apps/app/src/components/thread/ThreadActionsMenu.tsx",
  "apps/app/src/components/thread/ThreadActionsMenu.test.tsx",
]);

function legacy(node) {
  for (let p = node; p; p = p.parent)
    if (p.name && /legacy.*v1/i.test(p.name.text ?? "")) return true;

  return false;
}

function rendererContext(node, file, parsed) {
  for (let p = node; p; p = p.parent) {
    if (
      ts.isJsxAttribute(p) &&
      /^(?:className|class|style|data-)/.test(p.name.getText(parsed))
    )
      return true;

    if (
      ts.isCallExpression(p) &&
      /(?:querySelector(?:All)?|closest|matches|(?:get|set|has|remove)Attribute|getPropertyValue|setProperty|removeProperty|(?:add|remove|toggle|contains)|getElementsByClassName|(?:get|find|query)(?:All)?By(?:TestId|Role)|cn|clsx|cva|expect|to[A-Z]\w*)$/.test(
        p.expression.getText(parsed),
      )
    )
      return true;

    if (
      ts.isPropertyAssignment(p) &&
      /^(?:top|bottom|left|right|transform|translate|display|position|zIndex|background|color|border|boxShadow|font|opacity|maxHeight|maxWidth|minHeight|minWidth)$/.test(
        p.name.text ?? "",
      )
    )
      return true;

    if (
      (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) &&
      p.name === node &&
      /^(?:data-bb-|--bb-)/.test(node.text ?? "")
    )
      return true;

    if (
      p.name &&
      /class|style|selector|scope|portal|animation|keyframe|attribute|attr|theme|preview|css|registry|html|markup|document|template|offset|width|height|inset|property|padding|margin|gap|size/i.test(
        p.name.text ?? "",
      )
    )
      return true;
  }

  if (/\.test\.[cm]?[jt]sx?$/.test(file)) return true;

  return false;
}

export function collectRendererPairs({
  root,
  bindings = collectSourceBindings(root),
}) {
  const pairs = new Map();

  const add = (before, file, kind) => {
    const after = before.replace(/bb/, "omnyo");
    const row = pairs.get(before) ?? { before, after, owner: kind, owners: [] };

    if (!row.owners.includes(file)) row.owners.push(file);
    pairs.set(before, row);
  };

  const postcss = createRequire(
    new URL("../apps/mobile/package.json", import.meta.url),
  )("postcss");

  for (const file of bindings.files) {
    if (
      /^(?:docs\/|scripts\/omnyo-|packages\/scripts\/test\/omnyo-)|(?:^|\/)legacy[^/]*v1\.|(?:^|\/)recordings\/|bb-plugin-sdk-0\.4\.8-scaffold|^packages\/plugin-registry\/r\//.test(
        file,
      )
    )
      continue;

    if (!/\.(?:css|pcss|[cm]?[jt]sx?)$/.test(file)) continue;
    const text = readFileSync(resolve(root, file), "utf8");

    if (!/(?:--bb-|data-bb-|bb-)/.test(text)) continue;

    if (/\.(?:css|pcss)$/.test(file)) {
      const css = postcss.parse(text, { from: file });
      css.walk((node) => {
        for (const match of (node.selector ?? "").matchAll(/\.(bb-[\w-]+)/g)) {
          add(match[0], file, "Parsed CSS class selector");
          add(match[1], file, "Parsed CSS class selector");
        }

        if (
          node.type === "atrule" &&
          /keyframes$/.test(node.name) &&
          /^bb-[\w-]+$/.test(node.params)
        )
          add(node.params, file, "Parsed CSS keyframe");

        for (const match of node
          .toString()
          .matchAll(/(?:--bb-|data-bb-)[\w-]+/g))
          add(match[0], file, "Parsed CSS property or attribute");
      });
      continue;
    }

    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node) => {
      if (legacy(node)) return;

      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(parsed).startsWith("data-bb-")
      )
        add(node.name.getText(parsed), file, "Current JSX attribute");

      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const raw = node.getText(parsed);

        for (const match of raw.matchAll(/data-bb-[\w-]+/g))
          add(match[0], file, "Candidate DOM attribute; AST consumer required");

        if (/var\(--bb-|--bb-[\w-]+\s*:/.test(raw))
          for (const match of raw.matchAll(/--bb-[\w-]+/g))
            add(
              match[0],
              file,
              "CSS variable in an explicit declaration or var() expression",
            );
        let classContext = false;

        for (let p = node; p; p = p.parent) {
          if (
            ts.isJsxAttribute(p) &&
            /^(?:className|class)$/.test(p.name.getText(parsed))
          )
            classContext = true;

          if (
            ts.isCallExpression(p) &&
            /(?:querySelector(?:All)?|closest|matches|getElementsByClassName)$/.test(
              p.expression.getText(parsed),
            )
          )
            classContext = true;

          if (p.name && /class|selector|css|style/i.test(p.name.text ?? ""))
            classContext = true;
        }

        if (classContext) {
          for (const match of raw.matchAll(/--bb-[\w-]+/g))
            add(match[0], file, "Current style or selector consumer");

          for (const match of raw.matchAll(/(?<![\w-])(\.?bb-[\w-]+)/g)) {
            add(
              match[1],
              file,
              "Current JSX class or parsed selector consumer",
            );

            if (match[1].startsWith("."))
              add(
                match[1].slice(1),
                file,
                "Current JSX class or parsed selector consumer",
              );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return [...pairs.values()].sort((a, b) => a.before.localeCompare(b.before));
}

export function materializeRendererOperations({
  root,
  owner,
  bindings = collectSourceBindings(root),
  pairs,
}) {
  const mappings = new Map(pairs.map((p) => [p.before, p.after]));
  mappings.set(
    "bb.persistent-drawer-stack.v1",
    "omnyo.persistent-drawer-stack.v1",
  );
  const escapes = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const expression = new RegExp(
    `(?<![\\w-])(?:${[...mappings.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapes)
      .join("|")})(?![\\w-])`,
    "g",
  );

  const replace = (value) =>
    value.replace(expression, (before) => mappings.get(before));

  const operations = [],
    pending = [];

  const append = (file, start, before, after, context) => {
    if (before !== after)
      operations.push({
        id: `renderer-${operations.length + 1}`,
        rule_id: context.startsWith("Core") ? "R08" : "R12",
        ledger_ids: [
          "APP-006",
          "APP-012",
          "PKG-022",
          "PKG-023",
          "PLG-019",
          "PLG-020",
          "PLG-021",
          "PLG-022",
        ],
        proof_ids: ["V01-source-transform", "V10-surfaces"],
        migration_ids: ["S07"],
        owner,
        selector: {
          kind: "span",
          file,
          start,
          before,
          after,
          serialized: true,
          context,
        },
      });
  };

  const postcss = createRequire(
    new URL("../apps/mobile/package.json", import.meta.url),
  )("postcss");

  for (const file of bindings.files) {
    if (
      /^(?:docs\/|scripts\/omnyo-|packages\/scripts\/test\/omnyo-)|(?:^|\/)legacy[^/]*v1\.|(?:^|\/)omnyo-[^/]+\.test\.|(?:^|\/)recordings\/|bb-plugin-sdk-0\.4\.8-scaffold|^packages\/plugin-registry\/r\//.test(
        file,
      )
    )
      continue;

    if (/\.(?:css|pcss)$/.test(file)) {
      const text = readFileSync(resolve(root, file), "utf8");
      const css = postcss.parse(text, { from: file });
      css.walk((node) => {
        const start = node.source.start.offset;

        for (const [field, kind] of node.type === "rule"
          ? [["selector", "selector"]]
          : node.type === "decl"
            ? [
                ["prop", "property"],
                ["value", "value"],
              ]
            : node.type === "atrule"
              ? [["params", "at-rule parameter"]]
              : []) {
          const before = node[field];

          if (typeof before !== "string" || !before) continue;
          const after = replace(before);

          if (before === after) continue;

          const from =
            field === "prop"
              ? start
              : field === "value"
                ? text.indexOf(before, start + node.prop.length)
                : text.indexOf(before, start);

          if (from < start || from + before.length > node.source.end.offset + 1)
            throw Error(`CSS raw context mismatch ${file}`);
          append(
            file,
            from,
            before,
            after,
            `Parsed current CSS ${kind}; only exact owned names change`,
          );
        }
      });
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const text = readFileSync(resolve(root, file), "utf8");

    if (!expression.test(text) && !coreActionFiles.has(file)) continue;
    expression.lastIndex = 0;

    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node) => {
      if (legacy(node)) return;

      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(parsed).startsWith("data-bb-")
      ) {
        const before = node.name.getText(parsed);
        const after = mappings.get(before);

        if (after)
          append(
            file,
            node.name.getStart(parsed),
            before,
            after,
            "Exact current JSX data attribute owner",
          );
        else
          pending.push({
            file,
            start: node.name.getStart(parsed),
            before,
            reason: "Attribute is outside the materialized owner table",
          });
      }

      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isRegularExpressionLiteral(node)
      ) {
        const regexp = ts.isRegularExpressionLiteral(node);
        const start = node.getStart(parsed) + (regexp ? 0 : 1);

        const end =
          node.end -
          (regexp
            ? 0
            : ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
              ? 2
              : 1);

        const before = text.slice(start, end);
        let after = replace(before);

        if (coreActionFiles.has(file)) {
          if (before === "bb--core") after = "omnyo--core";

          for (const id of coreActions)
            if (before === `bb--core/${id}`) after = `omnyo--core/${id}`;
        }

        if (before !== after) {
          const embeddedRendererFiles = new Set([
            "apps/desktop/src/find-bar-view.ts",
            "apps/mobile/src/screens/dev/webview-spike-probes.ts",
            "plugins/agent-annotations/page-script.ts",
            "plugins/agent-annotations/smoke-design.mjs",
            "plugins/agent-annotations/visual-capture.ts",
            "plugins/inline-vis/frame.ts",
            "tests/qa/unread-native/proof.mjs",
          ]);

          const context =
            coreActionFiles.has(file) && before.startsWith("bb--core")
              ? "Core ephemeral action registry and current renderer lookup"
              : rendererContext(node, file, parsed) ||
                  embeddedRendererFiles.has(file) ||
                  before === "bb.persistent-drawer-stack.v1"
                ? "Exact parsed renderer CSS/class/attribute/event registry consumer"
                : null;

          if (context) append(file, start, before, after, context);
          else
            pending.push({
              file,
              start,
              before,
              reason:
                "Known owned selector appears outside a proven renderer context",
            });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return { schema: 1, candidate: { root, owner }, operations, pending };
}
