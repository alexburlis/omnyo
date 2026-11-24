import { extname } from "node:path";
import { parseAst, type Plugin, type Rollup } from "vite";

type AstNode = { type: string; [key: string]: unknown };

interface SplitDeclaration {
  id: string;
  imports: string[];
}

const SOURCE_LANGUAGES: Record<string, "js" | "jsx" | "ts" | "tsx"> = {
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".ts": "ts",
  ".tsx": "tsx",
};

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string"
  );
}

function children(node: AstNode): AstNode[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);

  for (const child of children(node)) walk(child, visit);
}

function stringLiteral(node: unknown): string | null {
  return isNode(node) &&
    node.type === "Literal" &&
    typeof node.value === "string"
    ? node.value
    : null;
}

function propertyName(node: AstNode): string | null {
  const key = node.key;

  if (!isNode(key)) return null;

  return key.type === "Identifier" && typeof key.name === "string"
    ? key.name
    : stringLiteral(key);
}

function findSplitDeclarations(
  program: AstNode,
  moduleId: string,
): SplitDeclaration[] {
  const declarations: SplitDeclaration[] = [];

  walk(program, (node) => {
    const callee = node.callee;

    if (
      node.type !== "CallExpression" ||
      !isNode(callee) ||
      callee.type !== "Identifier" ||
      callee.name !== "defineSplit"
    )
      return;
    const options = Array.isArray(node.arguments) ? node.arguments[0] : null;

    if (!isNode(options) || options.type !== "ObjectExpression")
      throw new Error(`defineSplit in ${moduleId} needs an options object`);

    const idProperty = children(options).find(
      (property) =>
        property.type === "Property" && propertyName(property) === "id",
    );

    const id = stringLiteral(idProperty?.value);

    if (id === null)
      throw new Error(`defineSplit in ${moduleId} needs a string literal id`);
    const imports: string[] = [];

    walk(options, (inner) => {
      if (inner.type !== "ImportExpression") return;
      const specifier = stringLiteral(inner.source);

      if (specifier === null)
        throw new Error(
          `Split ${id} in ${moduleId} must import a string literal module`,
        );
      imports.push(specifier);
    });

    if (imports.length === 0)
      throw new Error(`Split ${id} in ${moduleId} imports no module`);
    declarations.push({ id, imports });
  });

  return declarations;
}

export function splitPrefetch(): Plugin {
  let base = "/";
  const splits = new Map<string, { definedIn: string; modules: string[] }>();

  return {
    name: "omnyo:split-prefetch",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transform: {
      order: "pre",
      async handler(code, moduleId) {
        const lang = SOURCE_LANGUAGES[extname(moduleId.split("?")[0] ?? "")];

        if (lang === undefined || !code.includes("defineSplit")) return null;
        const program: unknown = parseAst(code, { lang }, moduleId);

        if (!isNode(program))
          throw new Error(`Could not parse splits in ${moduleId}`);

        for (const split of findSplitDeclarations(program, moduleId)) {
          const existing = splits.get(split.id);

          if (existing !== undefined && existing.definedIn !== moduleId)
            throw new Error(
              `Split ${split.id} is defined in both ${existing.definedIn} and ${moduleId}`,
            );

          const modules = await Promise.all(
            split.imports.map(async (specifier) => {
              const resolved = await this.resolve(specifier, moduleId);

              if (resolved === null)
                throw new Error(
                  `Split ${split.id} imports unresolved ${specifier} from ${moduleId}`,
                );

              return resolved.id;
            }),
          );

          splits.set(split.id, { definedIn: moduleId, modules });
        }

        return null;
      },
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle, chunk: entry }) {
        if (bundle === undefined) return [];
        const chunkByModule = new Map<string, Rollup.OutputChunk>();

        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;

          for (const moduleId of Object.keys(output.modules))
            chunkByModule.set(moduleId, output);
        }

        const closure = (fileName: string, files: Set<string>) => {
          if (files.has(fileName)) return;
          files.add(fileName);
          const output = bundle[fileName];

          if (output?.type !== "chunk") return;
          output.viteMetadata?.importedCss.forEach((css) => files.add(css));
          output.imports.forEach((imported) => closure(imported, files));
        };

        const loadedAtBoot = new Set<string>();

        if (entry !== undefined) closure(entry.fileName, loadedAtBoot);

        const files: string[] = [];
        const indexOf = new Map<string, number>();
        const manifestSplits: Record<string, number[]> = {};

        for (const [id, split] of [...splits].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const needed = new Set<string>();

          for (const module of split.modules) {
            const output = chunkByModule.get(module);

            if (output === undefined)
              throw new Error(`Missing prefetch split: ${id}`);
            closure(output.fileName, needed);
          }

          manifestSplits[id] = [...needed]
            .filter((fileName) => !loadedAtBoot.has(fileName))
            .map((fileName) => {
              let index = indexOf.get(fileName);

              if (index === undefined) {
                index = files.push(`${base}${fileName}`) - 1;
                indexOf.set(fileName, index);
              }

              return index;
            });
        }

        return [
          {
            tag: "script",
            attrs: { type: "application/json", id: "omnyo-prefetch-manifest" },
            children: JSON.stringify({
              files,
              splits: manifestSplits,
            }).replaceAll("<", "\\u003c"),
            injectTo: "head" as const,
          },
        ];
      },
    },
  };
}
