import {
  isMarkdownFenceClose,
  type MarkdownFence,
  parseMarkdownFenceStart,
  trimMarkdownLineCarriageReturn,
} from "./markdown-prompt-blockquote-boundaries.js";

const DIRECTIVE_LINE_PATTERN = /^( {0,3}::)([A-Za-z][\w-]*)\{(.*)\}([ \t]*)$/u;

const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_:][\w:.-]*/u;

const UNQUOTED_VALUE_PATTERN = /^[^\s"'<=>`}]+/u;

const WHITESPACE_PATTERN = /^[ \t]*/u;

const NEXT_ATTRIBUTE_PATTERN = /^[ \t]+[A-Za-z_:][\w:.-]*[ \t]*=/u;

const STRAY_CLOSE_PATTERN = /^\}["']?(?=[ \t]+[A-Za-z_:][\w:.-]*[ \t]*=)/u;

const QUOTE_REFERENCES: Record<string, string> = {
  '"': "&quot;",
  "'": "&#39;",
};

function closesQuotedValue(rest: string): boolean {
  return /^[ \t]*$/u.test(rest) || NEXT_ATTRIBUTE_PATTERN.test(rest);
}

function scanAttributes(body: string, lenient: boolean): string | null {
  let output = "";
  let index = 0;
  let repaired = false;

  while (index < body.length) {
    const whitespace = WHITESPACE_PATTERN.exec(body.slice(index))![0];
    output += whitespace;
    index += whitespace.length;

    if (index >= body.length) break;

    const key = ATTRIBUTE_KEY_PATTERN.exec(body.slice(index))?.[0];

    if (key === undefined) return null;
    output += key;
    index += key.length;

    if (body[index] !== "=") {
      if (index < body.length && !/[ \t]/u.test(body[index]!)) return null;
      continue;
    }

    output += "=";
    index += 1;
    const marker = body[index];

    if (marker !== '"' && marker !== "'") {
      const value = UNQUOTED_VALUE_PATTERN.exec(body.slice(index))?.[0];

      if (value === undefined) return null;
      output += value;
      index += value.length;
      continue;
    }

    index += 1;
    let value = "";
    let closed = false;

    while (index < body.length) {
      const character = body[index]!;

      if (
        character !== marker &&
        !(character === "\\" && body[index + 1] === marker)
      ) {
        value += character;
        index += 1;
        continue;
      }

      if (!lenient) {
        if (character !== marker) {
          value += character;
          index += 1;
          continue;
        }

        index += 1;
        closed = index >= body.length || /[ \t]/u.test(body[index]!);

        if (!closed) return null;
        break;
      }

      if (character === "\\") {
        value += QUOTE_REFERENCES[marker];
        index += 2;
        repaired = true;
        continue;
      }

      const rest = body.slice(index + 1);

      if (closesQuotedValue(rest)) {
        index += 1;
        closed = true;
        break;
      }

      const stray = STRAY_CLOSE_PATTERN.exec(rest)?.[0];

      if (stray !== undefined) {
        index += 1 + stray.length;
        closed = true;
        repaired = true;
        break;
      }

      value += QUOTE_REFERENCES[marker];
      index += 1;
      repaired = true;
    }

    if (!closed) {
      if (!lenient) return null;
      repaired = true;
    }

    output += `${marker}${value}${marker}`;
  }

  if (!lenient) return output;

  return repaired ? output : null;
}

function repairDirectiveLine(
  line: string,
  names: ReadonlySet<string>,
): string | null {
  const match = DIRECTIVE_LINE_PATTERN.exec(line);

  if (match === null) return null;
  const [, prefix, name, body, trailing] = match;

  if (!names.has(name!) || scanAttributes(body!, false) !== null) return null;
  const repaired = scanAttributes(body!, true);

  return repaired === null ? null : `${prefix}${name}{${repaired}}${trailing}`;
}

export function repairMessageDirectiveLines(
  markdown: string,
  names: ReadonlySet<string>,
): string {
  if (names.size === 0 || !markdown.includes("::")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  let activeFence: MarkdownFence | null = null;
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const line = trimMarkdownLineCarriageReturn(rawLine);

    if (activeFence !== null) {
      if (isMarkdownFenceClose(line, activeFence)) activeFence = null;
      continue;
    }

    activeFence = parseMarkdownFenceStart(line);

    if (activeFence !== null) continue;
    const repaired = repairDirectiveLine(line, names);

    if (repaired === null) continue;
    lines[index] = `${repaired}${rawLine.slice(line.length)}`;
    changed = true;
  }

  return changed ? lines.join("\n") : markdown;
}
