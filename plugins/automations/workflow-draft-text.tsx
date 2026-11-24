import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const UNORDERED = /^\s*[-*+]\s+(.*)$/;

const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

const QUOTE = /^\s*>\s?(.*)$/;

export function draftBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    const quote = QUOTE.exec(line);
    const last = blocks[blocks.length - 1];

    if (line.trim() === "") {
      flush();
    } else if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
    } else if (unordered || ordered) {
      flush();
      const isOrdered = ordered !== null;
      const text = (ordered ?? unordered)?.[1] ?? "";

      if (last?.kind === "list" && last.ordered === isOrdered)
        last.items.push(text);
      else blocks.push({ kind: "list", ordered: isOrdered, items: [text] });
    } else if (quote) {
      flush();

      if (last?.kind === "quote") last.text = `${last.text}\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1] });
    } else {
      paragraph.push(line);
    }
  }

  flush();

  return blocks;
}

const INLINE =
  /!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;

export function inertInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;

    if (start > cursor) nodes.push(text.slice(cursor, start));
    const [, image, link, code, strong, strongAlt, em, emAlt] = match;
    const key = `${start}`;

    if (image !== undefined) {
      if (image) nodes.push(image);
    } else if (link !== undefined) {
      nodes.push(link);
    } else if (code !== undefined) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-state-hover px-1 font-mono text-xs"
        >
          {code}
        </code>,
      );
    } else if (strong !== undefined || strongAlt !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {strong ?? strongAlt}
        </strong>,
      );
    } else {
      nodes.push(<em key={key}>{em ?? emAlt}</em>);
    }

    cursor = start + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));

  return nodes;
}

export function InertDraftText({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div data-inert-draft className={className}>
      {draftBlocks(source).map((block, index) => {
        if (block.kind === "heading")
          return (
            <p
              key={index}
              role="heading"
              aria-level={Math.min(block.level + 3, 6)}
              className="mt-6 text-base font-semibold text-foreground first:mt-0"
            >
              {inertInline(block.text)}
            </p>
          );

        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";

          return (
            <List
              key={index}
              className={`mt-4 space-y-1.5 pl-5 first:mt-0 ${block.ordered ? "list-decimal" : "list-disc"}`}
            >
              {block.items.map((item, position) => (
                <li key={position} className="pl-1">
                  {inertInline(item)}
                </li>
              ))}
            </List>
          );
        }

        if (block.kind === "quote")
          return (
            <blockquote
              key={index}
              className="mt-4 whitespace-pre-wrap border-l-2 border-border pl-4 text-muted-foreground first:mt-0"
            >
              {inertInline(block.text)}
            </blockquote>
          );

        return (
          <p
            key={index}
            className="mt-4 whitespace-pre-wrap break-words first:mt-0"
          >
            {inertInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
