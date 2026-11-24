import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

export const STREAMING_WORD_ATTRIBUTE = "data-streaming-word";

export const STREAMING_WORD_LIMIT = 16;

const STREAMING_WORD_TOKEN_PATTERN = /\s+|\S+/gu;

const STREAMING_WORD_WHITESPACE_PATTERN = /^\s/u;

const STREAMING_WORD_BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "ul",
]);

const STREAMING_WORD_INLINE_TAGS = new Set([
  "b",
  "del",
  "em",
  "i",
  "s",
  "strong",
]);

type StreamingWordDescent = "block" | "fragment" | "inline" | "opaque";

interface StreamingWordElementProps {
  children?: ReactNode;
  node?: unknown;
}

interface StreamingWordCursor {
  count: number;
  inWord: boolean;
}

function elementTagName(
  element: ReactElement<StreamingWordElementProps>,
): string | null {
  if (typeof element.type === "string") return element.type;

  const node = element.props.node;

  if (typeof node !== "object" || node === null || !("tagName" in node)) {
    return null;
  }

  return typeof node.tagName === "string" ? node.tagName : null;
}

function streamingWordDescent(
  element: ReactElement<StreamingWordElementProps>,
): StreamingWordDescent {
  if (element.type === Fragment) return "fragment";
  const tagName = elementTagName(element);

  if (tagName === null) return "opaque";

  if (STREAMING_WORD_BLOCK_TAGS.has(tagName)) return "block";

  return STREAMING_WORD_INLINE_TAGS.has(tagName) ? "inline" : "opaque";
}

function countStreamingWords(
  node: ReactNode,
  cursor: StreamingWordCursor,
): void {
  if (typeof node === "string" || typeof node === "number") {
    for (const token of String(node).match(STREAMING_WORD_TOKEN_PATTERN) ??
      []) {
      if (STREAMING_WORD_WHITESPACE_PATTERN.test(token)) {
        cursor.inWord = false;
      } else if (!cursor.inWord) {
        cursor.count += 1;
        cursor.inWord = true;
      }
    }

    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) countStreamingWords(child, cursor);

    return;
  }

  if (!isValidElement<StreamingWordElementProps>(node)) return;
  const descent = streamingWordDescent(node);

  if (descent === "opaque") {
    cursor.inWord = false;

    return;
  }

  if (descent === "block") cursor.inWord = false;
  countStreamingWords(node.props.children, cursor);

  if (descent === "block") cursor.inWord = false;
}

function wrapStreamingWordText(
  text: string,
  cursor: StreamingWordCursor,
  firstWrapped: number,
): ReactNode {
  const tokens = text.match(STREAMING_WORD_TOKEN_PATTERN) ?? [];
  const parts: ReactNode[] = [];
  let plain = "";
  let wrapped = false;

  for (const token of tokens) {
    if (STREAMING_WORD_WHITESPACE_PATTERN.test(token)) {
      cursor.inWord = false;
      plain += token;
      continue;
    }

    if (!cursor.inWord) {
      cursor.count += 1;
      cursor.inWord = true;
    }

    const ordinal = cursor.count - 1;

    if (ordinal < firstWrapped) {
      plain += token;
      continue;
    }

    if (plain !== "") parts.push(plain);
    plain = "";
    wrapped = true;
    parts.push(
      createElement(
        "span",
        { key: ordinal, [STREAMING_WORD_ATTRIBUTE]: ordinal },
        token,
      ),
    );
  }

  if (!wrapped) return text;

  if (plain !== "") parts.push(plain);

  return parts;
}

function wrapStreamingWordNode(
  node: ReactNode,
  cursor: StreamingWordCursor,
  firstWrapped: number,
): ReactNode {
  if (typeof node === "string" || typeof node === "number") {
    return wrapStreamingWordText(String(node), cursor, firstWrapped);
  }

  if (Array.isArray(node)) {
    let changed = false;

    const children = node.map((child: ReactNode) => {
      const next = wrapStreamingWordNode(child, cursor, firstWrapped);

      if (next !== child) changed = true;

      return next;
    });

    return changed ? children : node;
  }

  if (!isValidElement<StreamingWordElementProps>(node)) return node;
  const descent = streamingWordDescent(node);

  if (descent === "opaque") {
    cursor.inWord = false;

    return node;
  }

  if (descent === "block") cursor.inWord = false;
  const children = node.props.children;
  const nextChildren = wrapStreamingWordNode(children, cursor, firstWrapped);

  if (descent === "block") cursor.inWord = false;

  return nextChildren === children
    ? node
    : cloneElement(node, undefined, nextChildren);
}

export function wrapStreamingTailWords(node: ReactNode): ReactNode {
  const counted: StreamingWordCursor = { count: 0, inWord: false };
  countStreamingWords(node, counted);

  if (counted.count === 0) return node;

  return wrapStreamingWordNode(
    node,
    { count: 0, inWord: false },
    Math.max(0, counted.count - STREAMING_WORD_LIMIT),
  );
}
