import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import ts from "typescript";

const scriptExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

export function isScript(file) {
  return scriptExtensions.has(extname(file));
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function source(file, text) {
  const parsed = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".json") ? ts.ScriptKind.JSON : undefined,
  );

  if (parsed.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);

  return parsed;
}

function moduleLiteral(node) {
  const parent = node.parent;

  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(parent) && parent.expression === node) ||
    (ts.isImportTypeNode(parent.parent) && ts.isLiteralTypeNode(parent)) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(parent.expression) &&
          parent.expression.text === "require")))
  );
}

function edit(start, length, before, after, metadata = {}) {
  return { start, length, before, after, ...metadata };
}

function literalEdits(file, text, selector) {
  if (!isScript(file))
    throw new Error(
      `Unsupported literal format ${file}; use its format selector`,
    );
  const parsed = source(file, text);
  const edits = [];
  visit(parsed, (node) => {
    if (selector.kind === "moduleSpecifier") {
      if (
        ts.isStringLiteralLike(node) &&
        node.text === selector.before &&
        moduleLiteral(node)
      )
        edits.push(
          edit(
            node.getStart(parsed) + 1,
            node.getWidth(parsed) - 2,
            text.slice(node.getStart(parsed) + 1, node.end - 1),
            selector.after,
          ),
        );

      return;
    }

    const isProperty =
      node.parent &&
      (ts.isPropertyAssignment(node.parent) ||
        ts.isPropertySignature(node.parent) ||
        ts.isMethodDeclaration(node.parent)) &&
      node.parent.name === node;

    if (
      selector.context === "property" &&
      isProperty &&
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === selector.before
    ) {
      edits.push(
        edit(
          node.getStart(parsed),
          node.getWidth(parsed),
          text.slice(node.getStart(parsed), node.end),
          ts.isIdentifier(node)
            ? selector.after
            : JSON.stringify(selector.after),
          { serialized: true },
        ),
      );
    } else if (
      selector.context === "string" &&
      ts.isStringLiteralLike(node) &&
      node.text === selector.before &&
      !isProperty &&
      !moduleLiteral(node)
    ) {
      edits.push(
        edit(
          node.getStart(parsed),
          node.getWidth(parsed),
          text.slice(node.getStart(parsed), node.end),
          JSON.stringify(selector.after),
        ),
      );
    } else if (
      selector.context === "jsxAttribute" &&
      ts.isJsxAttribute(node) &&
      node.name.getText(parsed) === selector.before
    ) {
      edits.push(
        edit(
          node.name.getStart(parsed),
          node.name.getWidth(parsed),
          selector.before,
          selector.after,
          { serialized: true },
        ),
      );
    }
  });

  return edits;
}

function jsonEdits(file, text, selector) {
  JSON.parse(text);
  const parsed = source(file, text);
  const expression = parsed.statements[0]?.expression;
  let current = expression;
  let parent;

  for (const [index, key] of selector.path.entries()) {
    if (!ts.isObjectLiteralExpression(current))
      throw new Error(`JSON path is not an object in ${file}`);

    const matches = current.properties.filter(
      (property) =>
        ts.isPropertyAssignment(property) && property.name.text === key,
    );

    if (matches.length !== 1)
      throw new Error(`JSON path missing or duplicated in ${file}`);
    parent = current;
    current = matches[0];

    if (index !== selector.path.length - 1) current = current.initializer;
  }

  if (!current || !ts.isPropertyAssignment(current))
    throw new Error(`JSON path does not select a property in ${file}`);

  const selected =
    selector.field === "key" ? current.name : current.initializer;

  const before = JSON.parse(
    text.slice(selected.getStart(parsed), selected.end),
  );

  if (JSON.stringify(before) !== JSON.stringify(selector.before))
    throw new Error(`Expected JSON value differs in ${file}`);

  if (
    selector.field === "key" &&
    parent.properties.some(
      (property) =>
        property !== current && property.name?.text === selector.after,
    )
  )
    throw new Error(`JSON key collision in ${file}`);

  return [
    edit(
      selected.getStart(parsed),
      selected.getWidth(parsed),
      text.slice(selected.getStart(parsed), selected.end),
      JSON.stringify(selector.after),
      {
        serialized: selector.kind !== "packageName",
        jsonParent: selector.path.slice(0, -1).join("/"),
        jsonKey: selector.field === "key" ? selector.after : undefined,
      },
    ),
  ];
}

export function createSymbolResolver(
  root,
  files,
  contents,
  entryFiles = files,
) {
  const scriptFiles = entryFiles
    .filter(isScript)
    .map((file) => resolve(root, file));

  const paths = {};

  const sourceExport = (entry) => {
    if (typeof entry === "string") return entry;

    if (!entry || typeof entry !== "object") return undefined;

    return (
      sourceExport(entry.source) ??
      sourceExport(entry.import) ??
      sourceExport(entry.default)
    );
  };

  for (const [file, text] of contents) {
    if (!file.endsWith("package.json")) continue;
    let pkg;

    try {
      pkg = JSON.parse(text);
    } catch {
      continue;
    }

    if (typeof pkg.name !== "string" || !pkg.exports) continue;

    const exports =
      typeof pkg.exports === "object" &&
      Object.keys(pkg.exports).some((key) => key.startsWith("."))
        ? pkg.exports
        : { ".": pkg.exports };

    for (const [key, value] of Object.entries(exports)) {
      const target = sourceExport(value);

      if (!target || !target.startsWith("./")) continue;
      const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
      const resolved = resolve(root, dirname(file), target);

      if (contents.has(resolved.slice(root.length + 1)))
        paths[specifier] = [resolved];
    }
  }

  const settings = {
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    customConditions: ["source"],
    paths,
  };

  const configurationByDirectory = new Map();

  const configurationFor = (file) => {
    const directory = dirname(file);

    if (configurationByDirectory.has(directory))
      return configurationByDirectory.get(directory);
    let current = directory;
    let configuration;

    while (current === root || current.startsWith(`${root}/`)) {
      const path = join(current, "tsconfig.json");

      if (ts.sys.fileExists(path)) {
        const raw = ts.readConfigFile(path, ts.sys.readFile);

        if (raw.error)
          throw new Error(`Cannot parse source configuration ${path}`);

        const parsed = ts.parseJsonConfigFileContent(
          raw.config,
          ts.sys,
          current,
        );

        configuration = {
          ...parsed.options,
          ...settings,
          baseUrl: parsed.options.baseUrl ?? current,
          paths: { ...parsed.options.paths, ...paths },
        };
        break;
      }

      if (current === root) break;
      current = dirname(current);
    }

    const result = configuration ?? settings;
    configurationByDirectory.set(directory, result);

    return result;
  };

  const resolveModule = (specifier, containingFile) =>
    ts.resolveModuleName(
      specifier,
      containingFile,
      configurationFor(containingFile),
      ts.sys,
    ).resolvedModule;

  const host = {
    getScriptFileNames: () => scriptFiles,
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) => {
      const relative = file.slice(root.length + 1).replaceAll("\\", "/");
      const text = contents.get(relative) ?? ts.sys.readFile(file);

      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => settings,
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => resolveModule(name, containingFile)),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };

  const service = ts.createLanguageService(host);

  return {
    dispose: () => service.dispose(),
    ownsModule(specifier, file) {
      const resolved = resolveModule(
        specifier,
        resolve(root, file),
      )?.resolvedFileName;

      return (
        resolved !== undefined &&
        contents.has(resolved.slice(root.length + 1).replaceAll("\\", "/"))
      );
    },
    hasExport(specifier, name, file) {
      const target = resolveModule(
        specifier,
        resolve(root, file),
      )?.resolvedFileName;

      const program = service.getProgram();
      const parsed = target && program.getSourceFile(target);

      if (!parsed) return false;
      const checker = program.getTypeChecker();
      const symbol = checker.getSymbolAtLocation(parsed);

      return (
        symbol !== undefined &&
        checker.getExportsOfModule(symbol).some((entry) => entry.name === name)
      );
    },
    resolve(selector) {
      const absolute = resolve(root, selector.file);
      const program = service.getProgram();
      const parsed = program.getSourceFile(absolute);

      if (!parsed)
        throw new Error(`Symbol file not in source graph ${selector.file}`);
      let selected;
      visit(parsed, (node) => {
        if (
          ts.isIdentifier(node) &&
          node.getStart(parsed) === selector.position
        )
          selected = node;
      });

      if (!selected || selected.text !== selector.before)
        throw new Error(`Symbol declaration mismatch in ${selector.file}`);
      const checker = program.getTypeChecker();
      const symbol = checker.getSymbolAtLocation(selected);

      if (
        !symbol ||
        !symbol.declarations?.some(
          (declaration) => declaration.name === selected,
        )
      )
        throw new Error(`Selector is not a declaration in ${selector.file}`);

      if (!ts.isIdentifierText(selector.after, ts.ScriptTarget.Latest))
        throw new Error("Invalid target identifier");

      const memberName = (node) =>
        node.parent?.name === node &&
        (ts.isPropertySignature(node.parent) ||
          ts.isPropertyDeclaration(node.parent) ||
          ts.isPropertyAssignment(node.parent) ||
          ts.isMethodSignature(node.parent) ||
          ts.isMethodDeclaration(node.parent) ||
          ts.isPropertyAccessExpression(node.parent));

      if (
        !memberName(selected) &&
        checker
          .getSymbolsInScope(
            selected,
            ts.SymbolFlags.Value |
              ts.SymbolFlags.Type |
              ts.SymbolFlags.Namespace |
              ts.SymbolFlags.Alias,
          )
          .some(
            (candidate) =>
              candidate.name === selector.after && candidate !== symbol,
          )
      )
        throw new Error(`Symbol collision for ${selector.after}`);
      const declarationParent = selected.parent.parent;

      if (
        (declarationParent?.members ?? declarationParent?.properties)?.some(
          (member) => member.name?.text === selector.after,
        )
      )
        throw new Error(`Member collision for ${selector.after}`);

      const info = service.getRenameInfo(absolute, selector.position, {
        allowRenameOfImportPath: false,
      });

      if (!info.canRename)
        throw new Error(`Cannot rename declaration in ${selector.file}`);

      const locations = service.findRenameLocations(
        absolute,
        selector.position,
        false,
        false,
        { providePrefixAndSuffixTextForRename: true },
      );

      if (!locations?.length)
        throw new Error(`No semantic references in ${selector.file}`);

      return locations.map((location) => {
        const file = location.fileName
          .slice(root.length + 1)
          .replaceAll("\\", "/");

        if (!contents.has(file))
          throw new Error(`Symbol rename escapes owned graph at ${file}`);

        const original = contents
          .get(file)
          .slice(
            location.textSpan.start,
            location.textSpan.start + location.textSpan.length,
          );

        let locationNode;
        const locationSource = program.getSourceFile(location.fileName);
        visit(locationSource, (node) => {
          if (
            ts.isIdentifier(node) &&
            node.getStart(locationSource) === location.textSpan.start
          )
            locationNode = node;
        });

        if (locationNode) {
          const ultimate = (candidate) =>
            candidate.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(candidate)
              : candidate;

          if (
            !memberName(locationNode) &&
            checker
              .getSymbolsInScope(
                locationNode,
                ts.SymbolFlags.Value |
                  ts.SymbolFlags.Type |
                  ts.SymbolFlags.Namespace |
                  ts.SymbolFlags.Alias,
              )
              .some(
                (candidate) =>
                  candidate.name === selector.after &&
                  ultimate(candidate) !== ultimate(symbol),
              )
          )
            throw new Error(`Reference scope collision in ${file}`);
        }

        const suffix =
          locationNode?.parent &&
          ts.isExportSpecifier(locationNode.parent) &&
          !locationNode.parent.propertyName
            ? ""
            : (location.suffixText ?? "");

        return {
          file,
          ...edit(
            location.textSpan.start,
            location.textSpan.length,
            original,
            `${location.prefixText ?? ""}${selector.after}${suffix}`,
            {
              serialized:
                ts.isPropertySignature(selected.parent) ||
                ts.isPropertyDeclaration(selected.parent) ||
                ts.isPropertyAssignment(selected.parent),
            },
          ),
        };
      });
    },
  };
}

function formatEdits(root, file, text, selector) {
  if (selector.format === "css") {
    const require = createRequire(join(root, "apps/mobile/package.json"));
    const postcss = require("postcss");
    const parsed = postcss.parse(text, { from: file });
    const edits = [];
    const lineOffsets = [0];

    for (let i = 0; i < text.length; i++)
      if (text[i] === "\n") lineOffsets.push(i + 1);
    parsed.walk((node) => {
      const value =
        selector.context === "selector" && node.type === "rule"
          ? node.selector
          : selector.context === "property" && node.type === "decl"
            ? node.prop
            : selector.context === "value" && node.type === "decl"
              ? node.value
              : undefined;

      if (value !== selector.before) return;

      const start =
        lineOffsets[node.source.start.line - 1] + node.source.start.column - 1;

      const index =
        selector.context === "value"
          ? text.indexOf(node.value, start + node.prop.length)
          : start;

      edits.push(edit(index, value.length, value, selector.after));
    });

    return edits;
  }

  if (selector.format === "html") {
    const require = createRequire(join(root, "apps/server/package.json"));
    const parse5 = require("parse5");
    const parsed = parse5.parse(text, { sourceCodeLocationInfo: true });
    const edits = [];

    const walk = (node) => {
      for (const attribute of node.attrs ?? []) {
        if (
          selector.context !== "attribute" ||
          attribute.name !== selector.attribute ||
          attribute.value !== selector.before
        )
          continue;
        const location = node.sourceCodeLocation.attrs[attribute.name];
        const raw = text.slice(location.startOffset, location.endOffset);
        const equal = raw.indexOf("=");
        const value = raw.slice(equal + 1).trim();

        if (!/^(["']).*\1$/s.test(value))
          throw new Error(`HTML attribute must be quoted in ${file}`);
        const start = location.endOffset - value.length + 1;
        edits.push(
          edit(start, value.length - 2, value.slice(1, -1), selector.after),
        );
      }

      for (const child of node.childNodes ?? []) walk(child);

      if (node.content) walk(node.content);
    };

    walk(parsed);

    return edits;
  }

  throw new Error(`Unsupported format selector in ${file}`);
}

export function selectEdits(root, file, text, selector) {
  if (selector.kind === "packageName")
    return jsonEdits(file, text, {
      ...selector,
      path: ["name"],
      field: "value",
    });

  if (selector.kind === "jsonPath") return jsonEdits(file, text, selector);

  if (selector.kind === "moduleSpecifier" || selector.kind === "literal")
    return literalEdits(file, text, selector);

  if (selector.kind === "format")
    return formatEdits(root, file, text, selector);

  if (selector.kind === "span") {
    if (
      !Number.isSafeInteger(selector.start) ||
      selector.start < 0 ||
      typeof selector.context !== "string" ||
      !selector.context
    )
      throw new Error("Span requires an exact context and position");

    if (
      text.slice(selector.start, selector.start + selector.before.length) !==
      selector.before
    )
      throw new Error(`Span context mismatch in ${file}`);

    return [
      edit(
        selector.start,
        selector.before.length,
        selector.before,
        selector.after,
        { serialized: selector.serialized === true },
      ),
    ];
  }

  throw new Error(`Unknown selector ${selector.kind}`);
}

const brandingPattern =
  /@(?:get-)?bb\/|\bBB\b|\b\w*BBSdk\w*|\bBB[A-Z]\w*|\b\w*Bb(?:[A-Z0-9]\w*|\b)|\bbb(?:[A-Z_./-]\w*|\b)|\bBB_[A-Z_]+|\b[A-Z][A-Z0-9_]*_BB(?:_[A-Z0-9]+)*\b|__bb\w*|__BB_\w*/g;

let jsxParser;

function decodeJsxBody(raw, attribute) {
  jsxParser ??= createRequire(
    new URL("../../apps/server/package.json", import.meta.url),
  )("parse5");

  if (attribute)
    return (
      jsxParser
        .parseFragment(
          `<span data-value=${attribute}${raw}${attribute}></span>`,
        )
        .childNodes[0]?.attrs?.find((entry) => entry.name === "data-value")
        ?.value ?? ""
    );
  const tree = jsxParser.parseFragment(raw);
  const values = [];

  const visit = (node) => {
    if (node.nodeName === "#text") values.push(node.value);

    for (const child of node.childNodes ?? []) visit(child);
  };

  visit(tree);

  return values.join("");
}

function decodeScriptBody(raw, quote) {
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

function rawNodeBody(node, parsed, text) {
  const start = node.getStart(parsed);

  if (ts.isIdentifier(node))
    return {
      start,
      end: node.end,
      decoded: node.text,
      decode: (raw) => decodeScriptBody(raw, '"'),
    };

  if (ts.isJsxText(node))
    return {
      start: node.pos,
      end: node.end,
      decode: (raw) => decodeJsxBody(raw),
      jsx: true,
    };

  if (ts.isStringLiteralLike(node)) {
    const quote = text[start];

    const attribute =
      ts.isJsxAttribute(node.parent) && node.parent.initializer === node;

    return {
      start: start + 1,
      end: node.end - 1,
      decoded: attribute ? undefined : node.text,
      decode: (raw) =>
        attribute ? decodeJsxBody(raw, quote) : decodeScriptBody(raw, quote),
    };
  }

  if (
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  )
    return {
      start: start + 1,
      end: node.end - (ts.isTemplateTail(node) ? 1 : 2),
      decoded: node.text,
      decode: (raw) => decodeScriptBody(raw, "`"),
    };

  return null;
}

export function brandedCandidates(file, text) {
  const candidates = [];
  const codeIdentifiers = [];

  if (isScript(file) || file.endsWith(".json")) {
    const parsed = source(file, text);
    visit(parsed, (node) => {
      if (ts.isIdentifier(node))
        codeIdentifiers.push({ start: node.getStart(parsed), end: node.end });
      const body = rawNodeBody(node, parsed, text);

      if (body === null) return;
      const raw = text.slice(body.start, body.end);
      const decoded = body.decoded ?? body.decode(raw);

      if (decoded === undefined)
        throw new Error(`Cannot decode source token in ${file}:${body.start}`);
      let encoded = false;
      let cursor = 0;

      for (const match of decoded.matchAll(brandingPattern)) {
        let found = -1;
        let position = raw.indexOf(match[0], cursor);

        if (raw === decoded) found = match.index;

        while (found === -1 && position !== -1) {
          const prefix = body.decode(raw.slice(0, position));

          if (prefix !== undefined && prefix.length === match.index) {
            found = position;
            break;
          }

          position = raw.indexOf(match[0], position + 1);
        }

        if (found === -1) {
          encoded = true;
          continue;
        }

        cursor = found + match[0].length;
        candidates.push({
          start: body.start + found,
          length: match[0].length,
          context: ts.SyntaxKind[node.kind],
        });
      }

      if (encoded)
        candidates.push({
          start: body.start,
          length: raw.length,
          context: "encoded-source-token",
        });
    });
  }

  const rawParts = [];
  let rawCursor = 0;

  for (const identifier of codeIdentifiers.sort((a, b) => a.start - b.start)) {
    rawParts.push(
      text.slice(rawCursor, identifier.start),
      " ".repeat(identifier.end - identifier.start),
    );
    rawCursor = identifier.end;
  }

  rawParts.push(text.slice(rawCursor));

  for (const match of rawParts.join("").matchAll(brandingPattern)) {
    if (
      candidates.some(
        (candidate) =>
          match.index >= candidate.start &&
          match.index + match[0].length <= candidate.start + candidate.length,
      )
    )
      continue;
    candidates.push({
      start: match.index,
      length: match[0].length,
      context: extname(file) || "text",
    });
  }

  const coverage = [];

  for (const candidate of candidates.sort(
    (a, b) => a.start - b.start || b.length - a.length,
  )) {
    const previous = coverage.at(-1);

    if (previous && candidate.start < previous.start + previous.length) {
      previous.length =
        Math.max(
          previous.start + previous.length,
          candidate.start + candidate.length,
        ) - previous.start;
      previous.context =
        previous.context === "encoded-source-token" ||
        candidate.context === "encoded-source-token"
          ? "encoded-source-token"
          : "overlapping-source-tokens";
    } else coverage.push({ ...candidate });
  }

  return coverage;
}
