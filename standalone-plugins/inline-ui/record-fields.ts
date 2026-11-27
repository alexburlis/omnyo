import type { DirectiveAttributes } from "./block-fields.ts";

export type RecordAttributes = DirectiveAttributes;

export type FenceParseResult =
  | { ok: true; attributes: RecordAttributes }
  | { ok: false; reason: string; attributes: RecordAttributes | null };

export const recordFenceLanguages = ["status-table", "file-card"] as const;

export type RecordFenceLanguage = (typeof recordFenceLanguages)[number];

const fileKinds = new Set(["file", "download", "link"]);

const controlCharacters = /\p{Cc}/u;

const htmlMarkup = new RegExp(
  [
    String.raw`<!--`,
    String.raw`<![A-Za-z]`,
    String.raw`<\?[A-Za-z]`,
    String.raw`<\/[A-Za-z][A-Za-z0-9-]*\s*>`,
    String.raw`<[A-Za-z][A-Za-z0-9-]*\s[^<>]*=[^<>]*>`,
    String.raw`<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/>`,
    String.raw`<(?:br|hr|img|wbr)(?:\s[^<>]*)?>`,
  ].join("|"),
  "iu",
);

const codeSpan = /`[^`]*`/gu;

export function containsMarkup(value: string): boolean {
  return htmlMarkup.test(value.replace(codeSpan, ""));
}

export const webAddress = /^https?:\/\/[^\s<>]+$/u;

const localPath = /^(?![A-Za-z][A-Za-z0-9+.-]+:)[^<>]+$/u;

function plainText(value: string, maximum: number): boolean {
  return value.length <= maximum && !controlCharacters.test(value) && !containsMarkup(value);
}

function filled(value: string, maximum: number): boolean {
  return value.trim().length > 0 && plainText(value, maximum);
}

function listProblem(
  name: string,
  values: string[],
  maximum: number,
  required: boolean,
): string | null {
  const index = values.findIndex((value) =>
    required ? !filled(value, maximum) : !plainText(value, maximum),
  );

  if (index === -1) return null;

  return values[index].length > maximum
    ? `${name} ${index + 1} is longer than ${maximum} characters`
    : `${name} ${index + 1} is empty or contains markup`;
}

function statusTableProblem(attributes: RecordAttributes): string | null {
  const { label, note } = attributes;
  const columns = attributes.columns?.split("|");
  const labels = attributes.labels?.split("|");
  const values = attributes.values?.split("|");
  const details = attributes.details?.split("|");

  if (label !== undefined && !filled(label, 120)) return "the label is empty or too long";

  if (columns) {
    const problem = listProblem("Column", columns, 60, false);

    if (problem) return problem;
  }

  if (!labels || !values) return "rows need labels and values";

  if (labels.length > 60) return "a status table has at most 60 rows";

  if (values.length !== labels.length) return "each row needs exactly one value";

  if ([...labels, ...values].every((cell) => cell.trim().length === 0)) {
    return "every row is empty";
  }

  const problem =
    listProblem("Row", labels, 160, false) ?? listProblem("Value", values, 1200, false);

  if (problem) return problem;

  if (details && details.length !== labels.length) return "each row needs exactly one detail";

  if (details) {
    const detailProblem = listProblem("Detail", details, 500, false);

    if (detailProblem) return detailProblem;
  }

  if (note !== undefined && !plainText(note, 400)) return "the note is too long or contains markup";

  return null;
}

function rowsFromReadingOrder(attributes: RecordAttributes): RecordAttributes {
  const labels = attributes.labels?.split("|");
  const values = attributes.values?.split("|");

  if (!labels || !values || labels.length % values.length !== 0) return attributes;
  const width = labels.length / values.length;

  if (width !== 2 && width !== 3) return attributes;
  const details = attributes.details?.split("|");
  const rows = values.map((_, row) => labels.slice(row * width, (row + 1) * width));

  const proven = rows.every(
    ([, value, detail], row) =>
      value.trim() === values[row].trim() &&
      (detail === undefined || details === undefined || detail.trim() === details[row]?.trim()),
  );

  if (!proven) return attributes;
  const rowLabels = rows.map(([label]) => label).join("|");

  return width === 3 && details === undefined
    ? { ...attributes, labels: rowLabels, details: rows.map(([, , detail]) => detail).join("|") }
    : { ...attributes, labels: rowLabels };
}

function tolerateStatusTable(attributes: RecordAttributes): RecordAttributes {
  const rowCount = attributes.labels?.split("|").length;

  if (rowCount === undefined) return attributes;
  const { tones, columns, details, ...rest } = attributes;
  const table = Object.entries(rest);
  const columnCount = columns?.split("|").length;
  const detailList = details?.split("|");

  if (tones !== undefined && tones.split("|").length === rowCount) table.push(["tones", tones]);

  if (columns !== undefined && (columnCount === 2 || columnCount === 3)) {
    table.push(["columns", columns]);
  }

  if (detailList !== undefined) {
    const padding = Array<string>(Math.max(0, rowCount - detailList.length)).fill("");

    table.push(["details", [...detailList, ...padding].join("|")]);
  }

  return Object.fromEntries(table);
}

export function readStatusTable(attributes: RecordAttributes): FenceParseResult {
  const table = tolerateStatusTable(rowsFromReadingOrder(attributes));
  const problem = statusTableProblem(table);

  return problem
    ? { ok: false, reason: problem, attributes: table }
    : { ok: true, attributes: table };
}

function fileName(href: string): string {
  const name = href
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .split("/")
    .pop();

  return name?.trim() || href;
}

function tolerateFileCard(attributes: RecordAttributes): RecordAttributes {
  const href = attributes.href?.trim();
  const kind = attributes.kind?.trim().toLowerCase();
  const card = Object.entries(attributes);

  if (href && !attributes.title?.trim()) card.push(["title", fileName(href)]);

  if (kind !== undefined) card.push(["kind", fileKinds.has(kind) ? kind : "file"]);

  return Object.fromEntries(card);
}

function fileCardProblem(attributes: RecordAttributes): string | null {
  const { title, meta } = attributes;
  const href = attributes.href?.trim();
  const kind = attributes.kind ?? "file";

  if (title === undefined || !filled(title, 160) || /[<>]/u.test(title)) {
    return "the title is missing, too long or contains markup";
  }

  if (!href) return "the path or link is missing";

  if (
    href.length > 2000 ||
    controlCharacters.test(href) ||
    !(webAddress.test(href) || localPath.test(href))
  ) {
    return "the path or link is not a file path or web address";
  }

  if (meta !== undefined && !plainText(meta, 200))
    return "the meta line is too long or contains markup";

  if (!fileKinds.has(kind)) return `unknown kind "${kind}"`;

  return null;
}

export function parseFileCard(attributes: RecordAttributes): FenceParseResult {
  const { path, ...canonical } = attributes;

  const normalized = tolerateFileCard(
    path !== undefined && !canonical.href?.trim() ? { ...canonical, href: path } : canonical,
  );

  const problem = fileCardProblem(normalized);

  return problem
    ? { ok: false, reason: problem, attributes: normalized }
    : { ok: true, attributes: normalized };
}

const directiveLine = /^::([a-z][a-z-]*)\{(.*)\}$/u;

const attributePair = /\s*([A-Za-z][\w-]*)="([^"]*)"\s*/uy;

function parseDirectiveAttributes(body: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};

  attributePair.lastIndex = 0;

  while (attributePair.lastIndex < body.length) {
    const match = attributePair.exec(body);

    if (!match) return null;
    attributes[match[1]] = match[2];
  }

  return attributes;
}

const fieldLine = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u;

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function parseFieldLines(lines: string[]): FenceParseResult {
  const attributes: Record<string, string> = {};

  for (const line of lines) {
    const match = fieldLine.exec(line);

    if (!match) return rejected(`"${line}" is not a "field: value" line`);
    attributes[match[1]] = unquote(match[2].trim());
  }

  return { ok: true, attributes };
}

const toneMarks: ReadonlyArray<readonly [string, string]> = [
  ["✅", "positive"],
  ["✔️", "positive"],
  ["❌", "negative"],
  ["⚠️", "warning"],
  ["⚠", "warning"],
];

function tableCells(line: string): string[] | null {
  if (!line.startsWith("|") || !line.endsWith("|") || line.length < 2) return null;

  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function splitTone(value: string): [string, string] {
  const mark = toneMarks.find(([symbol]) => value.startsWith(symbol));

  return mark ? [value.slice(mark[0].length).trim(), mark[1]] : [value, "neutral"];
}

type StatusTableFields = {
  columns?: string;
  labels: string;
  values: string;
  tones?: string;
  details?: string;
};

function rejected(reason: string): FenceParseResult {
  return { ok: false, reason, attributes: null };
}

const dividerCell = /^:?-+:?$/u;

function threeCells(cells: string[]): [string, string, string] {
  return [cells[0] ?? "", cells[1] ?? "", cells.slice(2).filter(Boolean).join(" · ")];
}

function parsePipeTable(lines: string[]): FenceParseResult {
  const rows: string[][] = [];

  for (const line of lines) {
    const cells = tableCells(line);

    if (!cells) return rejected(`"${line}" is not a table row`);
    rows.push(cells);
  }

  const headed = rows.length > 1 && rows[1].every((cell) => dividerCell.test(cell));
  const header = headed ? threeCells(rows[0]) : null;
  const body = (headed ? rows.slice(2) : rows).map(threeCells);

  if (body.length === 0) return rejected("the table has no rows");
  const hasDetails = (header !== null && header[2] !== "") || body.some(([, , detail]) => detail);
  const values = body.map((row) => splitTone(row[1]));
  const labels = body.map((row) => row[0]).join("|");
  const joinedValues = values.map(([value]) => value).join("|");
  const attributes: StatusTableFields = { labels, values: joinedValues };

  if (header) attributes.columns = (hasDetails ? header : header.slice(0, 2)).join("|");

  if (values.some(([, tone]) => tone !== "neutral")) {
    attributes.tones = values.map(([, tone]) => tone).join("|");
  }

  if (hasDetails) attributes.details = body.map((row) => row[2]).join("|");

  return { ok: true, attributes };
}

function parseFenceAttributes(language: RecordFenceLanguage, code: string): FenceParseResult {
  const lines = code
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return rejected("the block is empty");

  if (lines[0].startsWith("::")) {
    const match = lines.length === 1 ? directiveLine.exec(lines[0]) : null;

    if (!match) return rejected(`expected one ::${language}{…} line`);

    if (match[1] !== language) return rejected(`found ::${match[1]} inside a ${language} block`);
    const attributes = parseDirectiveAttributes(match[2]);

    return attributes
      ? { ok: true, attributes }
      : rejected('attributes must be written as name="value"');
  }

  if (lines[0].startsWith("|")) {
    return language === "status-table"
      ? parsePipeTable(lines)
      : rejected("a file card is written as field: value lines");
  }

  return parseFieldLines(lines);
}

export function parseRecordFence(language: RecordFenceLanguage, code: string): FenceParseResult {
  const parsed = parseFenceAttributes(language, code);

  if (!parsed.ok) return parsed;

  return language === "file-card"
    ? parseFileCard(parsed.attributes)
    : readStatusTable(parsed.attributes);
}
