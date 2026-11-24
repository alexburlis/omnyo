import type { ExtraProps } from "react-markdown";

type HastElement = NonNullable<ExtraProps["node"]>;

type HastContent = HastElement["children"][number];

interface HastParent {
  children: HastContent[];
}

interface MarkdownTableRows {
  body: HastElement[];
  header: HastElement[];
}

export const MARKDOWN_BLOCK_SURFACE_CLASS =
  "group/block my-4 overflow-hidden rounded-xl bg-surface-recessed ring-1 ring-inset ring-border-seam";

export const MARKDOWN_BLOCK_CONTROLS_CLASS =
  "flex items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-duration-fast) group-focus-within/block:opacity-100 group-hover/block:opacity-100 motion-reduce:transition-none";

export const MARKDOWN_NUMERIC_CELL_PROPERTY = "dataMarkdownNumeric";

export const MARKDOWN_LEAD_PARAGRAPH_PROPERTY = "dataMarkdownLead";

const MARKDOWN_NUMERIC_CELL_PATTERN =
  /^[+\-−±]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:%|[kKMB]|ms|s|x|×))?$/u;

const MARKDOWN_PLACEHOLDER_CELL_PATTERN = /^(?:|-|–|—|n\/a)$/iu;

function isHastElement(node: HastContent): node is HastElement {
  return node.type === "element";
}

function childElements(parent: HastParent, tagName: string): HastElement[] {
  return parent.children.filter(
    (child): child is HastElement =>
      isHastElement(child) && child.tagName === tagName,
  );
}

function rowCells(row: HastElement): HastElement[] {
  return row.children.filter(
    (child): child is HastElement =>
      isHastElement(child) &&
      (child.tagName === "td" || child.tagName === "th"),
  );
}

function hastText(node: HastContent): string {
  if (node.type === "text") return node.value;

  if (!isHastElement(node)) return "";

  return node.children.map(hastText).join("");
}

function collectTableRows(table: HastElement): MarkdownTableRows {
  const header = childElements(table, "thead").flatMap((section) =>
    childElements(section, "tr"),
  );

  const body = [
    ...childElements(table, "tbody"),
    ...childElements(table, "tfoot"),
  ].flatMap((section) => childElements(section, "tr"));

  const directRows = childElements(table, "tr");

  if (header.length === 0 && body.length === 0 && directRows.length > 1) {
    return { header: directRows.slice(0, 1), body: directRows.slice(1) };
  }

  return { header, body: [...body, ...directRows] };
}

function isNumericColumn(cells: readonly (HastElement | undefined)[]): boolean {
  let numericCells = 0;

  for (const cell of cells) {
    if (cell === undefined) continue;

    const text = hastText(cell).trim();

    if (MARKDOWN_PLACEHOLDER_CELL_PATTERN.test(text)) continue;

    if (!MARKDOWN_NUMERIC_CELL_PATTERN.test(text)) return false;

    numericCells += 1;
  }

  return numericCells > 0;
}

function markNumericTableColumns(table: HastElement): void {
  const { body, header } = collectTableRows(table);

  if (body.length === 0) return;

  const headerCells = header.map(rowCells);
  const bodyCells = body.map(rowCells);
  const columnCount = Math.max(0, ...bodyCells.map((cells) => cells.length));

  for (let column = 0; column < columnCount; column += 1) {
    if (!isNumericColumn(bodyCells.map((cells) => cells[column]))) continue;

    for (const cells of [...headerCells, ...bodyCells]) {
      const cell = cells[column];

      if (cell !== undefined) {
        cell.properties[MARKDOWN_NUMERIC_CELL_PROPERTY] = "";
      }
    }
  }
}

function visitTables(parent: HastParent): void {
  for (const child of parent.children) {
    if (!isHastElement(child)) continue;

    if (child.tagName === "table") {
      markNumericTableColumns(child);
    } else {
      visitTables(child);
    }
  }
}

export function rehypeMarkdownNumericColumns() {
  return (tree: HastParent): void => {
    visitTables(tree);
  };
}

function isLeadParagraph(node: HastElement): boolean {
  let strong: HastElement | null = null;

  for (const child of node.children) {
    if (child.type === "text" && child.value.trim() === "") continue;

    if (
      !isHastElement(child) ||
      child.tagName !== "strong" ||
      strong !== null
    ) {
      return false;
    }

    strong = child;
  }

  return strong !== null && hastText(strong).trim() !== "";
}

export function rehypeMarkdownLeadParagraph() {
  return (tree: HastParent): void => {
    const first = tree.children.find(
      (child) => !(child.type === "text" && child.value.trim() === ""),
    );

    if (
      first !== undefined &&
      isHastElement(first) &&
      first.tagName === "p" &&
      isLeadParagraph(first)
    ) {
      first.properties[MARKDOWN_LEAD_PARAGRAPH_PROPERTY] = "";
    }
  };
}

const MARKDOWN_SETTLED_FIRST_BLOCK_PATTERN = /\n[ \t]*\n\s*\S/u;

export function hasSettledFirstMarkdownBlock(body: string): boolean {
  return MARKDOWN_SETTLED_FIRST_BLOCK_PATTERN.test(body);
}
