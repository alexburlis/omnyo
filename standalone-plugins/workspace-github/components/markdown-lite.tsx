import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { UrlLink } from "@omnyo/plugin-sdk/app";

const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    ZeroWidthSpace: "​",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    bull: "•",
    middot: "·",
    copy: "©",
    reg: "®",
    trade: "™",
    deg: "°",
    plusmn: "±",
    times: "×",
    divide: "÷",
    laquo: "«",
    raquo: "»",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    larr: "←",
    rarr: "→",
    uarr: "↑",
    darr: "↓",
    check: "✓",
    hearts: "♥",
  } satisfies Record<string, string>),
);

const ENTITY_PATTERN = /&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

function codePointToString(codePoint: number, fallback: string): string {
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return fallback;
  }

  return String.fromCodePoint(codePoint);
}

function decodeEntities(text: string): string {
  return text.replace(
    ENTITY_PATTERN,
    (entity: string, hex: string | undefined, decimal: string | undefined, name?: string) => {
      if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16), entity);

      if (decimal !== undefined) return codePointToString(Number.parseInt(decimal, 10), entity);

      return (name !== undefined ? NAMED_ENTITIES.get(name) : undefined) ?? entity;
    },
  );
}

function stripInvisible(text: string): string {
  return text.replace(/​/g, "");
}

function cleanText(text: string): string {
  return stripInvisible(decodeEntities(text));
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"),
  );

  const value = match?.[1] ?? match?.[2] ?? match?.[3];

  return value === undefined ? undefined : decodeEntities(value);
}

function safeHref(href: string): string | undefined {
  const decoded = decodeEntities(href).trim();

  return /^(?:https?:\/\/|mailto:)/i.test(decoded) ? decoded : undefined;
}

function renderImage(
  key: number,
  src: string | undefined,
  alt: string,
  width?: string,
  height?: string,
): React.ReactNode {
  const cleanAlt = cleanText(alt);
  const cleanSrc = src === undefined ? undefined : decodeEntities(src).trim();

  if (!cleanSrc || !/^https?:\/\//i.test(cleanSrc)) return cleanAlt;

  return (
    <img
      key={key}
      src={cleanSrc}
      alt={cleanAlt}
      loading="lazy"
      {...(width && /^\d+$/.test(width) ? { width: Number(width) } : {})}
      {...(height && /^\d+$/.test(height) ? { height: Number(height) } : {})}
      className="my-1 inline-block h-auto max-w-full rounded-md border border-border"
    />
  );
}

function renderLink(key: number, href: string, label: React.ReactNode[]): React.ReactNode {
  const safe = safeHref(href);

  if (safe === undefined) return <Fragment key={key}>{label}</Fragment>;

  return (
    <UrlLink
      key={key}
      href={safe}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {label}
    </UrlLink>
  );
}

function plainHtmlText(html: string): string {
  return cleanText(html.replace(/<[^>]*>/g, ""));
}

const INLINE_PATTERN = new RegExp(
  [
    String.raw`\\(?<escaped>[\\\x60*_{}\[\]()#+\-.!|<>~&])`,
    String.raw`!\[(?<imageAlt>[^\]]*)\]\((?<imageSrc>[^)\s]+)(?:\s+"[^"]*")?\)`,
    String.raw`\[(?<linkLabel>(?:[^\[\]]|!\[[^\]]*\]\([^)\s]*\))+)\]\((?<linkHref>[^)\s]+)(?:\s+"[^"]*")?\)`,
    String.raw`(?<htmlImage><img\b[^>]*>)`,
    String.raw`<a\b(?<anchorAttributes>[^>]*)>(?<anchorBody>[\s\S]*?)</a\s*>`,
    String.raw`<(?<strongTag>strong|b)\b[^>]*>(?<strongBody>[\s\S]*?)</\k<strongTag>\s*>`,
    String.raw`<(?<emphasisTag>em|i)\b[^>]*>(?<emphasisBody>[\s\S]*?)</\k<emphasisTag>\s*>`,
    String.raw`<code\b[^>]*>(?<htmlCode>[\s\S]*?)</code\s*>`,
    String.raw`(?<lineBreak><br\b[^>]*>\n?)`,
    String.raw`<(?<autolink>https?://[^>\s]+)>`,
    "`(?<codeSpan>[^`]+)`",
    String.raw`\*\*(?<strong>[^*]+)\*\*`,
    String.raw`\*(?<emphasis>[^*]+)\*`,
    String.raw`~~(?<strike>[^~]+)~~`,
    String.raw`(?<strayTag></?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?/?>)`,
  ].join("|"),
  "g",
);

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    const groups = match.groups ?? {};

    if (index > last) nodes.push(cleanText(text.slice(last, index)));
    last = index + match[0].length;

    if (groups.escaped !== undefined) {
      nodes.push(groups.escaped);
    } else if (groups.imageSrc !== undefined) {
      nodes.push(renderImage(key++, groups.imageSrc, groups.imageAlt ?? ""));
    } else if (groups.linkHref !== undefined) {
      nodes.push(renderLink(key++, groups.linkHref, renderInline(groups.linkLabel ?? "")));
    } else if (groups.htmlImage !== undefined) {
      const tag = groups.htmlImage;
      nodes.push(
        renderImage(
          key++,
          htmlAttribute(tag, "src"),
          htmlAttribute(tag, "alt") ?? "",
          htmlAttribute(tag, "width"),
          htmlAttribute(tag, "height"),
        ),
      );
    } else if (groups.anchorBody !== undefined) {
      const href = htmlAttribute(groups.anchorAttributes ?? "", "href") ?? "";
      nodes.push(renderLink(key++, href, renderInline(groups.anchorBody)));
    } else if (groups.strongBody !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(groups.strongBody)}</strong>);
    } else if (groups.emphasisBody !== undefined) {
      nodes.push(<em key={key++}>{renderInline(groups.emphasisBody)}</em>);
    } else if (groups.htmlCode !== undefined) {
      nodes.push(<InlineCode key={key++}>{plainHtmlText(groups.htmlCode)}</InlineCode>);
    } else if (groups.lineBreak !== undefined) {
      nodes.push(<br key={key++} />);
    } else if (groups.autolink !== undefined) {
      nodes.push(renderLink(key++, groups.autolink, [cleanText(groups.autolink)]));
    } else if (groups.codeSpan !== undefined) {
      nodes.push(<InlineCode key={key++}>{stripInvisible(groups.codeSpan)}</InlineCode>);
    } else if (groups.strong !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(groups.strong)}</strong>);
    } else if (groups.emphasis !== undefined) {
      nodes.push(<em key={key++}>{renderInline(groups.emphasis)}</em>);
    } else if (groups.strike !== undefined) {
      nodes.push(<del key={key++}>{renderInline(groups.strike)}</del>);
    }
  }

  if (last < text.length) nodes.push(cleanText(text.slice(last)));

  return nodes;
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

type TableAlignment = "left" | "center" | "right" | null;

interface ParsedTable {
  alignments: TableAlignment[];
  header: string[];
  rows: string[][];
  nextLine: number;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;

  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }

  return backslashes % 2 === 1;
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && !isEscaped(line, i)) return true;
  }

  return false;
}

function splitTableRow(line: string): string[] {
  let row = line.trim();

  if (row.startsWith("|")) row = row.slice(1);

  if (row.endsWith("|") && !isEscaped(row, row.length - 1)) {
    row = row.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = "";

  for (let i = 0; i < row.length; i++) {
    if (row[i] === "|" && !isEscaped(row, i)) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    if (row[i] === "|" && cell.endsWith("\\")) {
      cell = cell.slice(0, -1);
    }

    cell += row[i];
  }

  cells.push(cell.trim());

  return cells;
}

function parseTableAlignment(cell: string): TableAlignment | undefined {
  if (!/^:?-+:?$/.test(cell)) return undefined;
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");

  if (left && right) return "center";

  if (right) return "right";

  if (left) return "left";

  return null;
}

function parseTable(lines: string[], startLine: number): ParsedTable | null {
  if (startLine + 1 >= lines.length) return null;
  const headerLine = lines[startLine];
  const delimiterLine = lines[startLine + 1];

  if (!hasUnescapedPipe(headerLine) || !hasUnescapedPipe(delimiterLine)) {
    return null;
  }

  const header = splitTableRow(headerLine);
  const delimiterCells = splitTableRow(delimiterLine);

  if (header.length !== delimiterCells.length) return null;

  const alignments: TableAlignment[] = [];

  for (const cell of delimiterCells) {
    const alignment = parseTableAlignment(cell);

    if (alignment === undefined) return null;
    alignments.push(alignment);
  }

  const rows: string[][] = [];
  let nextLine = startLine + 2;

  while (
    nextLine < lines.length &&
    lines[nextLine].trim() !== "" &&
    hasUnescapedPipe(lines[nextLine])
  ) {
    const cells = splitTableRow(lines[nextLine]).slice(0, header.length);

    while (cells.length < header.length) cells.push("");
    rows.push(cells);
    nextLine++;
  }

  return { alignments, header, rows, nextLine };
}

function tableAlignmentClass(alignment: TableAlignment): string {
  switch (alignment) {
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    default:
      return "text-left";
  }
}

const HEADING_CLASSES = [
  "text-lg font-semibold",
  "text-base font-semibold",
  "text-sm font-semibold",
];

const ALERT_LABELS = new Map(
  Object.entries({
    NOTE: "Note",
    TIP: "Tip",
    IMPORTANT: "Important",
    WARNING: "Warning",
    CAUTION: "Caution",
  } satisfies Record<string, string>),
);

const FENCE = /^ {0,3}```/;

const HEADING = /^(#{1,6})\s+(.*)$/;

const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

const QUOTE = /^ {0,3}>/;

const BULLET = /^\s*[-*+]\s+/;

const ORDERED = /^\s*\d{1,9}[.)]\s+/;

const ALERT = /^\\?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\?\]\s*$/i;

type Range = readonly [number, number];

function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let fenceStart = -1;

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      if (fenceStart < 0) {
        fenceStart = offset;
      } else {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = -1;
      }
    }

    offset += line.length + 1;
  }

  if (fenceStart >= 0) ranges.push([fenceStart, text.length]);

  for (const span of text.matchAll(/`[^`\n]+`/g)) {
    const start = span.index ?? 0;
    ranges.push([start, start + span[0].length]);
  }

  return ranges;
}

function isProtected(ranges: Range[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function replaceUnprotected(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => string,
): string {
  const ranges = protectedRanges(text);
  let result = "";
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;

    if (isProtected(ranges, index)) continue;
    result += text.slice(last, index) + replace(match);
    last = index + match[0].length;
  }

  return result + text.slice(last);
}

function normalizeHtml(content: string): string {
  let text = content.replace(/\r\n?/g, "\n");
  text = replaceUnprotected(text, /<!--[\s\S]*?-->/g, () => "");
  text = replaceUnprotected(
    text,
    /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi,
    (match) => `\n\n\`\`\`\n${plainHtmlText(match[1]).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`,
  );
  text = replaceUnprotected(text, /<hr\b[^>]*>/gi, () => "\n\n---\n\n");
  text = replaceUnprotected(
    text,
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (match) => `\n\n${"#".repeat(Number(match[1]))} ${match[2].replace(/\s+/g, " ").trim()}\n\n`,
  );
  text = replaceUnprotected(text, /\s*<li\b[^>]*>\s*/gi, () => "\n- ");
  text = replaceUnprotected(text, /\s*<\/li\s*>/gi, () => "");
  text = replaceUnprotected(text, /\s*<\/?(?:ul|ol|tr)\b[^>]*>\s*/gi, () => "\n");
  text = replaceUnprotected(
    text,
    /<\/?(?:p|div|center|section|article|header|footer|figure|figcaption|table|thead|tbody)\b[^>]*>/gi,
    () => "\n\n",
  );

  return text;
}

type DocumentNode =
  | { kind: "text"; text: string }
  | { kind: "details"; summary: string; open: boolean; children: DocumentNode[] }
  | { kind: "quote"; children: DocumentNode[] };

interface ContainerFrame {
  name: string;
  open: boolean;
  children: DocumentNode[];
}

const SUMMARY_PATTERN = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

function finishContainer(frame: ContainerFrame): DocumentNode {
  if (frame.name === "blockquote") return { kind: "quote", children: frame.children };

  const first = frame.children[0];
  const summaryMatch = first?.kind === "text" ? first.text.match(SUMMARY_PATTERN) : null;

  if (first?.kind === "text" && summaryMatch) {
    const rest = first.text.slice(summaryMatch[0].length);
    const following = frame.children.slice(1);

    return {
      kind: "details",
      summary: summaryMatch[1].replace(/\s+/g, " ").trim(),
      open: frame.open,
      children: rest.trim() === "" ? following : [{ kind: "text", text: rest }, ...following],
    };
  }

  return { kind: "details", summary: "", open: frame.open, children: frame.children };
}

function buildTree(text: string): DocumentNode[] {
  const ranges = protectedRanges(text);
  const root: ContainerFrame = { name: "", open: false, children: [] };
  const stack: ContainerFrame[] = [root];
  let last = 0;

  const pushText = (value: string) => {
    if (value.trim() !== "") stack[stack.length - 1].children.push({ kind: "text", text: value });
  };

  const closeTop = () => {
    const frame = stack.pop();

    if (frame) stack[stack.length - 1].children.push(finishContainer(frame));
  };

  for (const match of text.matchAll(/<(\/?)(details|blockquote)\b([^>]*)>/gi)) {
    const index = match.index ?? 0;

    if (isProtected(ranges, index)) continue;
    pushText(text.slice(last, index));
    last = index + match[0].length;
    const name = match[2].toLowerCase();

    if (match[1] === "") {
      stack.push({ name, open: /(?:^|\s)open\b/i.test(match[3]), children: [] });
      continue;
    }

    let target = -1;

    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) {
        target = i;
        break;
      }
    }

    while (target > 0 && stack.length > target) closeTop();
  }

  pushText(text.slice(last));

  while (stack.length > 1) closeTop();

  return root.children;
}

function renderNodes(nodes: DocumentNode[]): React.ReactNode[] {
  return nodes.flatMap((node, index) => {
    if (node.kind === "text") return [<Fragment key={index}>{renderLines(node.text)}</Fragment>];

    if (node.kind === "details") {
      return [
        <details key={index} open={node.open} className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {node.summary === "" ? "Details" : renderInline(node.summary)}
          </summary>
          <div className="mt-2 space-y-3">{renderNodes(node.children)}</div>
        </details>,
      ];
    }

    return [<QuoteBlock key={index}>{renderNodes(node.children)}</QuoteBlock>];
  });
}

function QuoteBlock({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
      {label ? (
        <p className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
          {label}
        </p>
      ) : null}
      {children}
    </blockquote>
  );
}

function renderMarkdownQuote(key: number, inner: string): React.ReactNode {
  const lines = inner.replace(/^\s+/, "").split("\n");
  const alert = lines[0].match(ALERT);

  return (
    <QuoteBlock key={key} label={alert ? ALERT_LABELS.get(alert[1].toUpperCase()) : undefined}>
      {renderNodes(buildTree(alert ? lines.slice(1).join("\n") : inner))}
    </QuoteBlock>
  );
}

function renderListItem(key: number, text: string): React.ReactNode {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);

  if (!task) return <li key={key}>{renderInline(text)}</li>;

  return (
    <li key={key} className="-ml-5 list-none">
      <input
        type="checkbox"
        checked={task[1] !== " "}
        readOnly
        disabled
        className="mr-2 align-middle"
      />
      {renderInline(task[2])}
    </li>
  );
}

const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S/u;

function renderLines(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || LINK_DEFINITION.test(line)) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;

      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }

      i++;
      blocks.push(
        <pre key={key++} className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
          <code>{stripInvisible(code.join("\n"))}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(HEADING);

    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const tags = ["h1", "h2", "h3", "h4"] as const;
      const Tag = tags[Math.min(heading[1].length, 4) - 1] ?? "h4";

      blocks.push(
        <Tag key={key++} className={HEADING_CLASSES[level - 1]}>
          {renderInline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={key++} className="border-border" />);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];

      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }

      blocks.push(renderMarkdownQuote(key++, quoted.join("\n")));
      continue;
    }

    const table = parseTable(lines, i);

    if (table) {
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-max min-w-full border-collapse border border-border">
            <thead className="bg-surface-recessed">
              <tr>
                {table.header.map((cell, column) => (
                  <th
                    key={column}
                    className={cn(
                      "border border-border px-2 py-1 font-medium",
                      tableAlignmentClass(table.alignments[column]),
                    )}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className={cn(
                        "border border-border px-2 py-1",
                        tableAlignmentClass(table.alignments[column]),
                      )}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = table.nextLine;
      continue;
    }

    const ordered = !BULLET.test(line) && ORDERED.test(line);
    const marker = ordered ? ORDERED : BULLET;

    if (ordered || BULLET.test(line)) {
      const items: React.ReactNode[] = [];

      while (i < lines.length && marker.test(lines[i])) {
        items.push(renderListItem(key++, lines[i].replace(marker, "")));
        i++;
      }

      const List = ordered ? "ol" : "ul";

      blocks.push(
        <List key={key++} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items}
        </List>,
      );
      continue;
    }

    const para: string[] = [];

    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      parseTable(lines, i) === null
    ) {
      para.push(lines[i]);
      i++;
    }

    blocks.push(
      <p key={key++} className="whitespace-pre-wrap break-words">
        {renderInline(para.join("\n"))}
      </p>,
    );
  }

  return blocks;
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {renderNodes(buildTree(normalizeHtml(content)))}
    </div>
  );
}
