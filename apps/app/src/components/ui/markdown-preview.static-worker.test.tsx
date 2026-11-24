// @vitest-environment jsdom

import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MarkdownParseRequest } from "./markdown-parse-protocol";
import { MarkdownPreview } from "./markdown-preview";

class ControlledWorker extends EventTarget {
  static current: ControlledWorker | undefined;
  request: MarkdownParseRequest | undefined;
  terminated = false;

  constructor() {
    super();
    ControlledWorker.current = this;
  }

  postMessage(request: MarkdownParseRequest) {
    this.request = request;
  }

  terminate() {
    this.terminated = true;
  }

  reply() {
    const request = this.request;

    if (!request) throw new Error("Expected a requested Markdown parse");

    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath, { singleDollarTextMath: false })
      .parse(request.source);

    this.dispatchEvent(
      new MessageEvent("message", { data: { ...request, tree } }),
    );
  }
}

let client: QueryClient;

const padding = "x".repeat(100_001);

function preview(
  content: string,
  props: Partial<ComponentProps<typeof MarkdownPreview>> = {},
) {
  return (
    <QueryClientProvider client={client}>
      <MarkdownPreview content={content} {...props} />
    </QueryClientProvider>
  );
}

function worker() {
  const current = ControlledWorker.current;

  if (!current) throw new Error("Expected a Markdown worker");

  return current;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ControlledWorker.current = undefined;
  vi.stubGlobal("Worker", ControlledWorker);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "renders static Markdown from its worker with incremental blocks %s",
  async (incrementalBlocks) => {
    const math = render(preview("$$x$$"));
    await waitFor(() =>
      expect(math.container.querySelector(".katex")).not.toBeNull(),
    );
    math.unmount();

    const source =
      "# Review\n\n| Name | Value |\n| --- | --- |\n| first | checked |\n\n" +
      "- list item\n\n```ts\nconst answer = 42;\n```\n\n" +
      "**Selected** ~~removed~~ [safe](https://example.com) [blocked](javascript:evil) $$x$$ " +
      padding;

    const view = render(preview(source, { incrementalBlocks }));
    expect(view.container.querySelector("strong")).toBeNull();
    expect(within(view.container).getByRole("status")).toBeDefined();
    await act(async () => worker().reply());
    const reference = render(preview(source, { streamingTail: true }));
    expect(view.container.innerHTML).toBe(reference.container.innerHTML);
    expect(view.container.querySelector("h1")?.textContent).toBe("Review");
    expect(view.container.querySelector("table")?.textContent).toContain(
      "checked",
    );
    expect(view.container.querySelector("li")?.textContent).toBe("list item");
    expect(view.container.querySelector("code")?.textContent).toBe(
      "const answer = 42;",
    );
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Selected",
    );
    expect(view.container.querySelector("del")?.textContent).toBe("removed");
    expect(view.container.querySelector(".katex")).not.toBeNull();
    expect(
      view.container.querySelector('a[href="https://example.com"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull();
  },
);

it("cancels replaced static documents and render configurations without showing late results", async () => {
  const source = (title: string) =>
    `# ${title}\n\n![preview](https://example.com/a.png)\n\n${padding}`;

  const view = render(preview(source("First")));
  const first = worker();
  view.rerender(preview(source("Second")));
  expect(first.terminated).toBe(true);
  await act(async () => first.reply());
  expect(view.container.querySelector("h1")).toBeNull();
  const second = worker();
  view.rerender(preview(source("Second"), { imagePolicy: "alt-text" }));
  expect(second.terminated).toBe(true);
  await act(async () => second.reply());
  expect(view.container.querySelector("h1")).toBeNull();
  await act(async () => worker().reply());
  expect(view.container.querySelector("h1")?.textContent).toBe("Second");
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.textContent).toContain("preview");
  const last = worker();
  view.unmount();
  expect(last.terminated).toBe(true);
});

it("preserves selection at completion and hides superseded static content", async () => {
  const source = "**Selected** " + padding;
  const props = { incrementalBlocks: true, streamingTailOwner: "answer" };
  const view = render(preview(source, { ...props, streamingTail: true }));
  await act(async () => worker().reply());
  const selected = view.container.querySelector("strong")?.firstChild;

  if (!selected) throw new Error("Expected selectable prose");
  const range = document.createRange();
  range.selectNodeContents(selected);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  view.rerender(preview(source, { ...props, streamingTail: false }));
  expect(view.container.querySelector("strong")?.firstChild).toBe(selected);
  expect(window.getSelection()?.toString()).toBe("Selected");
  view.rerender(
    preview(source + " appended", { ...props, streamingTail: false }),
  );
  expect(view.container.querySelector("strong")).toBeNull();
  await act(async () => worker().reply());
  expect(view.container.textContent?.endsWith(" appended")).toBe(true);
});
