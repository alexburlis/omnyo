import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const apiMembers = new Set([
  "agents",
  "background",
  "cli",
  "events",
  "hosts",
  "http",
  "log",
  "onDispose",
  "realtime",
  "rpc",
  "sdk",
  "settings",
  "status",
  "storage",
  "ui",
]);

const metadataMembers = new Set([
  "app",
  "branding",
  "description",
  "host",
  "name",
  "server",
  "skills",
  "themes",
]);

const sdkSymbols = new Map([
  ["BbPluginApi", "PluginApi"],
  ["useBbContext", "experimental_useAppContext"],
  ["useBbNavigate", "experimental_useAppNavigate"],
]);

export function projectCurrentGuideParagraph(before, environmentPairs) {
  if (
    /The finite legacy layout importer is|\b(?:copyright|MIT license|licensed under)\b/i.test(
      before,
    )
  )
    return before;
  const protectedValues = [];

  let text = before.replace(
    /https?:\/\/[^\s<>"'`]+|(?:~|\/Users|\/home|[A-Z]:\\)[^\s<>"'`]+|\b(?:packages|plugins|apps|scripts|docs)\/[^\s<>"'`]+/g,
    (value) => {
      const canonicalState =
        /^~\/\.bb(?:\/|$|-dev(?:\/|$)|-machines(?:\/|$))/.test(value);

      if (canonicalState) return value.replace(/^~\/\.bb/, "~/.omnyo");
      protectedValues.push(value);

      return `\u0000${protectedValues.length - 1}\u0000`;
    },
  );

  text = text.replace(
    /\bBB_[A-Z][A-Z0-9_]*\b/g,
    (name) => environmentPairs.get(name) ?? name,
  );
  text = text.replace(/\bBB_FF_\*/g, "OMNYO_FF_*");
  text = text.replace(/@(?:get-bb|bb)\/plugin-sdk\b/g, "@omnyo/plugin-sdk");
  text = text.replace(
    /\b(?:BbPluginApi|useBbContext|useBbNavigate)\b/g,
    (name) => sdkSymbols.get(name),
  );
  text = text.replace(/\bbb\.([A-Za-z]+)\b/g, (value, member) =>
    apiMembers.has(member)
      ? `api.${member}`
      : metadataMembers.has(member)
        ? `omnyo.${member}`
        : value,
  );

  if (/"(?:engines|branding|server|app|host)"\s*:/.test(text))
    text = text.replace(/"bb"(?=\s*:)/g, '"omnyo"');
  text = text.replace(/"bb"(?=\s*:)/g, (value) => {
    protectedValues.push(value);

    return `\u0000${protectedValues.length - 1}\u0000`;
  });
  text = text
    .replace(/\bengines\.bb\b/g, "engines.omnyo")
    .replace(/\bbbPluginSdk\b/g, "omnyoPluginSdk");
  text = text.replace(/(?<![\w/-])bb-app(?![\w/-])/g, "omnyo-app");
  text = text.replace(
    /(?<![\w/-])bb-plugin-(?=hello\b|<name>|`)/g,
    "omnyo-plugin-",
  );
  text = text.replace(/<bb-data-dir>/g, "<omnyo-data-dir>");
  text = text.replace(/(?<![\w/])\.bb(?=\/|$|[`,)\s])/g, ".omnyo");
  text = text.replace(/\.bb-env-(setup|teardown)\.sh/g, ".omnyo-env-$1.sh");
  text = text.replace(/\bbb\.db\b/g, "app.db");
  text = text
    .replace(/\bBB-managed\b/g, "Omnyo-managed")
    .replace(/\bbb-owned\b/g, "Omnyo-owned");
  text = text.replace(/(?<![\w./:@-])BB(?![\w/@-]|[.:][\w])/g, "Omnyo");
  text = text.replace(
    /(?<![\w./:@-])bb(?![\w/@-]|[.:][\w])/g,
    (value, offset) => {
      const prefix = text.slice(0, offset);
      const suffix = text.slice(offset + value.length);
      const inlineCode = (prefix.match(/`/g)?.length ?? 0) % 2 === 1;

      const command =
        /^\s+<[^>]+>/.test(suffix) ||
        inlineCode ||
        /(?:\b(?:npx|exec|run|use|bare|installed|bundled)|\$)\s+$/i.test(
          prefix,
        ) ||
        /^\s+(?:thread|plugin|guide|server|machine|provider|project|environment|terminal|theme|skill|settings|updates|help|browser|pool|prompts|canvas|question|callback|preview|automation|terminal|diagnostics|glance|run|le|status|--[\w-]+)(?:\s|$)/.test(
          suffix,
        );

      return command ? "omnyo" : "Omnyo";
    },
  );

  return text.replace(
    /\u0000(\d+)\u0000/g,
    (_, index) => protectedValues[Number(index)],
  );
}

function environmentPairs(root) {
  const file = resolve(root, "packages/config/src/omnyo-environment.ts");

  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const pairs = new Map();

  const visit = (node) => {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      node.elements.every(ts.isStringLiteral)
    ) {
      const [before, after] = node.elements;

      if (/^BB_/.test(before.text) && /^OMNYO_/.test(after.text))
        pairs.set(before.text, after.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return pairs;
}

export function splitGuideProtectedRanges(text, start, ranges) {
  const end = start + text.length;

  const protectedRanges = ranges
    .filter((range) => range.start < end && range.end > start)
    .map((range) => ({
      start: Math.max(start, range.start),
      end: Math.min(end, range.end),
    }))
    .sort((a, b) => a.start - b.start);

  const parts = [];
  let cursor = start;

  for (const range of protectedRanges) {
    if (range.start > cursor)
      parts.push({
        start: cursor,
        text: text.slice(cursor - start, range.start - start),
      });
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < end)
    parts.push({ start: cursor, text: text.slice(cursor - start) });

  return parts;
}

export function materializeGuideOperations({
  root,
  owner,
  files,
  contractEdits = new Map(),
}) {
  const pairs = environmentPairs(root);
  const operations = [];
  const inputs = [];

  for (const file of files) {
    if (
      !/^(?:packages\/templates\/src\/templates\/[^/]+\.md|plugins\/bb-guide\/skills\/bb-cli\/(?:references\/)?[^/]+\.md|docs\/cli-guide-and-skill\.md)$/.test(
        file,
      )
    )
      throw Error(`Unowned guide input ${file}`);
    const source = readFileSync(resolve(root, file), "utf8");
    const explicit = contractEdits.get(file) ?? [];
    const ranges = [];

    for (const edit of explicit) {
      const start = source.indexOf(edit.before);

      if (start === -1 || source.indexOf(edit.before, start + 1) !== -1)
        throw Error(`Guide contract input drift ${file}`);
      ranges.push({ start, end: start + edit.before.length });
      operations.push({
        id: `guide-contract-${operations.length + 1}`,
        rule_id: "R16",
        ledger_ids: ["PKG-010", "PLG-028"],
        proof_ids: ["V01-source-transform", "V10-surfaces"],
        migration_ids: ["S07"],
        owner,
        selector: {
          kind: "span",
          file,
          start,
          before: edit.before,
          after: edit.after,
          serialized: false,
          context: edit.context,
        },
      });
    }

    for (const match of source.matchAll(
      /^  - `omnyo plugin migrate[^\n]*(?:\n(?!  - )[^\n]*)*/gm,
    ))
      ranges.push({ start: match.index, end: match.index + match[0].length });

    let fencedLanguage = null;
    const chunks = source.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g);

    for (const match of chunks) {
      const before = match[0];
      const markers = [...before.matchAll(/^\s*```([^\n]*)/gm)];

      const css =
        /^(?:css|text)$/.test(fencedLanguage ?? "") ||
        markers.some((marker) => /^(?:css|text)\s*$/.test(marker[1]));

      for (const marker of markers)
        fencedLanguage = fencedLanguage === null ? marker[1].trim() : null;

      if (css) continue;

      for (const part of splitGuideProtectedRanges(
        before,
        match.index,
        ranges,
      )) {
        const after = projectCurrentGuideParagraph(part.text, pairs);

        if (part.text === after) continue;
        operations.push({
          id: `guide-${operations.length + 1}`,
          rule_id: "R16",
          ledger_ids: ["PKG-010", "PLG-028"],
          proof_ids: ["V01-source-transform", "V10-surfaces"],
          migration_ids: ["S07"],
          owner,
          selector: {
            kind: "span",
            file,
            start: part.start,
            before: part.text,
            after,
            serialized: false,
            context:
              "Current authored guide paragraph: exact config environment table, canonical SDK/API/manifest roles, current lifecycle hook contract and S07 paths; upstream URLs, source homes, finite legacy paragraph and existing opaque skill/settings identities preserved",
          },
        });
      }
    }

    if (operations.some((operation) => operation.selector.file === file))
      inputs.push({
        file,
        digest: createHash("sha256").update(source).digest("hex"),
      });
  }

  return { schema: 1, candidate: { root, owner }, operations, inputs };
}
