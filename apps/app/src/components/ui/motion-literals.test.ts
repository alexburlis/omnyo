import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const appSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const NAMED_LOOP_PATTERN =
  /ultracode|omnyo-working-(?:breathe|ping|spin|halo|sheen|orb-ring|orb-halo)|omnyo-search-flash|omnyo-count-flash|omnyo-hero-drift|omnyo-hero-progress|omnyo-rail-wiggle|omnyo-intro|indeterminate-progress|caret|shine|pulse|ping/;

const TIME_PATTERN = /(?<![\w.$#-])(\d*\.?\d+)(ms|s)\b/g;

const MOTION_DECLARATION_PATTERN =
  /(?<![\w-])((?:-webkit-)?(?:animation|transition)(?:-duration|-delay|-timing-function)?)\s*:\s*([^;{}]+);/g;

const BARE_EASING_KEYWORD_PATTERN =
  /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out)(?![\w-])/;

const CLASS_LIST_HINT_PATTERN =
  /(?:^|\s)(?:[\w-]+:)*(?:flex|grid|inline-flex|block|hidden|absolute|relative|px-[\w.]+|py-[\w.]+|p-[\w.]+|text-[\w/-]+|bg-[\w/-]+|rounded[\w-]*|items-\w+|opacity-\d+|ease-[\w()-]+|duration-[\w()-]+)(?=\s|$)/;

const INLINE_TIMING_PROPERTY_PATTERN =
  /(?<![\w(-])(?:opacity|transform|translate|scale|rotate|height|width|top|left|right|bottom|filter|color|background-color|border-color|box-shadow|grid-template-rows|margin[\w-]*|padding[\w-]*|clip-path|visibility|all)[\s_]+(\d*\.?\d+)(ms|s)\b/g;

type Violation = string;

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "generated") continue;
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (!/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function hasNonZeroTime(value: string): boolean {
  for (const match of value.matchAll(TIME_PATTERN)) {
    if (Number.parseFloat(match[1] ?? "0") !== 0) return true;
  }

  return false;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

function enclosingSelector(css: string, index: number): string {
  const blockStart = css.lastIndexOf("{", index);

  const previousBoundary = Math.max(
    css.lastIndexOf("}", blockStart - 1),
    css.lastIndexOf("{", blockStart - 1),
    css.lastIndexOf(";", blockStart - 1),
  );

  return css.slice(previousBoundary + 1, blockStart);
}

function cssViolations(file: string, source: string): Violation[] {
  const css = stripCssComments(source);
  const name = relative(appSourceRoot, file);
  const violations: Violation[] = [];

  for (const match of css.matchAll(MOTION_DECLARATION_PATTERN)) {
    const property = match[1] ?? "";
    const value = match[2] ?? "";
    const context = `${enclosingSelector(css, match.index)} ${value}`;
    const location = `${name}:${lineOf(css, match.index)}`;

    if (hasNonZeroTime(value) && !NAMED_LOOP_PATTERN.test(context)) {
      violations.push(`${location} literal timing in ${property}: ${value}`);
    }

    if (BARE_EASING_KEYWORD_PATTERN.test(value)) {
      violations.push(`${location} bare easing keyword in ${property}`);
    }
  }

  for (const match of css.matchAll(/cubic-bezier\(/g)) {
    const lineStart = css.lastIndexOf("\n", match.index) + 1;
    const line = css.slice(lineStart, css.indexOf("\n", match.index));

    if (
      !/^\s*--motion-ease-[\w-]+:\s*cubic-bezier\(/.test(line) &&
      !NAMED_LOOP_PATTERN.test(enclosingSelector(css, match.index))
    ) {
      violations.push(
        `${name}:${lineOf(css, match.index)} cubic-bezier outside the motion tokens`,
      );
    }
  }

  return violations;
}

function stringViolations(text: string): string[] {
  const problems: string[] = [];

  if (/cubic-bezier\(/.test(text)) {
    problems.push("literal cubic-bezier()");
  }

  if (
    /(?<![\w-])(?:[\w-]+:|\[[^\]\s]*\]:)*(?:duration|delay)-\d+(?![\w.])/.test(
      text,
    )
  ) {
    problems.push("numeric Tailwind duration or delay");
  }

  if (/(?:duration|delay)-\[\s*\d*\.?\d+m?s\s*\]/.test(text)) {
    problems.push("arbitrary literal duration or delay");
  }

  if (/(?<![\w-])transition-all(?![\w-])/.test(text)) {
    problems.push("transition-all");
  }

  if (
    /(?:^|\s)(?:[\w-]+:)*transition(?=\s|$)/.test(text) &&
    CLASS_LIST_HINT_PATTERN.test(text)
  ) {
    problems.push("bare transition class");
  }

  for (const match of text.matchAll(
    /\[(?:transition|animation)[\w-]*:[^\]]*\]/g,
  )) {
    if (
      hasNonZeroTime(match[0].replace(/_/g, " ")) &&
      !NAMED_LOOP_PATTERN.test(match[0])
    ) {
      problems.push(`literal timing in ${match[0]}`);
    }
  }

  for (const match of text.includes("\n")
    ? []
    : text.matchAll(INLINE_TIMING_PROPERTY_PATTERN)) {
    if (Number.parseFloat(match[1] ?? "0") !== 0) {
      problems.push(`literal timing in "${match[0]}"`);
    }
  }

  return problems;
}

function scriptViolations(file: string, source: string): Violation[] {
  const name = relative(appSourceRoot, file);

  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];

  const check = (node: ts.Node, text: string) => {
    for (const problem of stringViolations(text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );

      violations.push(`${name}:${line + 1} ${problem}`);
    }
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      check(node, node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return violations;
}

describe("motion literals", () => {
  const files = listSourceFiles(appSourceRoot);

  it("keeps CSS timings and curves on the motion tokens", () => {
    const violations = files
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) => cssViolations(file, readFileSync(file, "utf8")));

    expect(violations).toEqual([]);
  });

  it("keeps class strings and inline styles on the motion tokens", () => {
    const violations = files
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) => scriptViolations(file, readFileSync(file, "utf8")));

    expect(violations).toEqual([]);
  });

  it("flags the literals it guards against", () => {
    expect(stringViolations("px-2 transition duration-150")).toEqual([
      "numeric Tailwind duration or delay",
      "bare transition class",
    ]);
    expect(stringViolations("transition-all hover:bg-accent")).toEqual([
      "transition-all",
    ]);
    expect(stringViolations("opacity 120ms ease")).toEqual([
      'literal timing in "opacity 120ms"',
    ]);
    expect(
      stringViolations("[transition:opacity_120ms_var(--motion-ease-out)]"),
    ).toEqual([
      "literal timing in [transition:opacity_120ms_var(--motion-ease-out)]",
    ]);
    expect(
      stringViolations(
        "[transition:translate_var(--motion-duration-sidebar)_var(--motion-ease-smooth),width_0s_linear_0s]",
      ),
    ).toEqual([]);
    expect(stringViolations("ease-[cubic-bezier(0.2,0.7,0.2,1)]")).toEqual([
      "literal cubic-bezier()",
    ]);
    expect(
      cssViolations(
        join(appSourceRoot, "example.css"),
        ".a { transition: opacity 120ms ease-in-out; }",
      ),
    ).toEqual([
      "example.css:1 literal timing in transition: opacity 120ms ease-in-out",
      "example.css:1 bare easing keyword in transition",
    ]);
  });
});
