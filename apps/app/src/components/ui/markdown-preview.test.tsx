// @vitest-environment jsdom

import { LazyMarkdownHtml } from "./lazy-markdown-html";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { highlightMarkdownCode } from "./markdown-code-highlight";
import {
  MarkdownPreview,
  MarkdownTablesContainedContext,
} from "./markdown-preview";
import {
  MarkdownLocalFileContextMenuContext,
  MarkdownLocalFileOpenTargetsContext,
  type MarkdownLinkRouting,
} from "./markdown-link-routing";

const workspaceLinkRouting = {
  localFile: {
    absoluteLinks: {
      kind: "trusted-host",
    },
    relativeLinks: {
      baseDir: "/workspace",
      rootPath: "/workspace",
    },
    onOpenLink: vi.fn(() => true),
  },
} satisfies MarkdownLinkRouting;

beforeAll(() => LazyMarkdownHtml.preload());

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function mockResizeObserverDeliveries(): {
  notifyResize: () => void;
  observerCount: () => number;
  observed: Element[];
} {
  const observed: Element[] = [];

  const observers: Array<{
    callback: ResizeObserverCallback;
    instance: ResizeObserver;
    targets: Set<Element>;
  }> = [];

  class ResizeObserverMock {
    private readonly record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) {
      this.record = {
        callback,
        instance: this as unknown as ResizeObserver,
        targets: new Set(),
      };
      observers.push(this.record);
    }
    observe(target: Element): void {
      observed.push(target);
      this.record.targets.add(target);
    }
    unobserve(target: Element): void {
      this.record.targets.delete(target);
    }
    disconnect(): void {
      this.record.targets.clear();
    }
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  return {
    observed,
    observerCount: () => observers.length,
    notifyResize: () => {
      act(() => {
        for (const { callback, instance, targets } of observers) {
          if (targets.size === 0) continue;
          callback(
            Array.from(
              targets,
              (target) => ({ target }) as unknown as ResizeObserverEntry,
            ),
            instance,
          );
        }
      });
    },
  };
}

function requireElement(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);

  if (element === null) {
    throw new Error(`Expected an element matching ${selector}`);
  }

  return element;
}

describe("MarkdownPreview", () => {
  it("keeps loaded media mounted when message link handlers refresh", () => {
    const content =
      "![Chart](https://example.com/chart.png)\n\n```mermaid\ngraph TD; A-->B;\n```";

    const { container, rerender } = render(
      <MarkdownPreview
        content={content}
        linkRouting={{ onOpenLink: () => true }}
      />,
    );

    const image = screen.getByRole("img", { name: "Chart" });
    const removed: Node[] = [];

    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes);
    });

    observer.observe(container, { childList: true, subtree: true });

    for (let refresh = 0; refresh < 3; refresh++) {
      rerender(
        <MarkdownPreview
          content={content}
          linkRouting={{ onOpenLink: () => true }}
        />,
      );
      expect(screen.getByRole("img", { name: "Chart" })).toBe(image);
    }

    removed.push(
      ...observer.takeRecords().flatMap((record) => [...record.removedNodes]),
    );
    observer.disconnect();
    expect(removed).toEqual([]);
  });

  it("makes a wide table a separately focusable scroll region with readable headers", () => {
    render(
      <MarkdownPreview
        content={
          "| Account identifier | Current allowance | Next reset |\n| --- | --- | --- |\n| Subscription one | 98 percent | Tomorrow |"
        }
      />,
    );

    const region = screen.getByRole("region", {
      name: "Table (scroll horizontally for more columns)",
    });

    region.focus();
    expect(document.activeElement).toBe(region);
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Account identifier", "Current allowance", "Next reset"]);
  });

  it("shares one observer and observes content width only for table previews", () => {
    const { notifyResize, observed, observerCount } =
      mockResizeObserverDeliveries();

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const plain = render(<MarkdownPreview content="Plain paragraph" />);
    expect(observed).toHaveLength(0);
    plain.unmount();

    const { container } = render(
      <>
        <MarkdownPreview content={"| A |\n| - |\n| B |"} />
        <MarkdownPreview content={"| C |\n| - |\n| D |"} />
      </>,
    );

    const breakouts = Array.from(
      container.querySelectorAll("table"),
      (table) => table.parentElement?.parentElement,
    );

    expect(observerCount()).toBe(1);
    expect(observed).toHaveLength(2);
    expect(
      observed.every((element) =>
        element.hasAttribute("data-markdown-preview"),
      ),
    ).toBe(true);
    expect(
      breakouts.every(
        (breakout) => breakout?.style.getPropertyValue("--md-content-w") === "",
      ),
    ).toBe(true);
    notifyResize();
    expect(
      breakouts.every(
        (breakout) =>
          breakout?.style.getPropertyValue("--md-content-w") === "320px",
      ),
    ).toBe(true);
  });

  it("keeps tables inside the column where breakout is turned off", () => {
    const { container } = render(
      <>
        <MarkdownPreview content={"| A |\n| - |\n| B |"} />
        <MarkdownTablesContainedContext.Provider value>
          <MarkdownPreview content={"| C |\n| - |\n| D |"} />
        </MarkdownTablesContainedContext.Provider>
      </>,
    );

    const [breakout, contained] = Array.from(
      container.querySelectorAll("table"),
      (table) => table.parentElement?.parentElement,
    );

    expect(breakout?.style.width).toContain("max(100%");
    expect(contained?.style.width).toBe("");
    expect(contained?.style.marginInline).toBe("");
  });

  it("right-aligns only numeric columns of chat tables", () => {
    const table = [
      "| Machine | Chats | Version |",
      "| - | - | - |",
      "| Mac Pro | 1,299 | 1.2.3 |",
      "| 3090 | — | 2.0.1 |",
      "| Air | 10 | 3.1.0 |",
    ].join("\n");

    const { container } = render(
      <>
        <MarkdownPreview content={table} />
        <MarkdownTablesContainedContext.Provider value>
          <MarkdownPreview content={table} />
        </MarkdownTablesContainedContext.Provider>
      </>,
    );

    const [plain, chat] = Array.from(container.querySelectorAll("table"));

    const columnAlignments = (tableElement: HTMLTableElement | undefined) =>
      Array.from(tableElement?.querySelectorAll("thead th") ?? [], (cell) =>
        cell.classList.contains("text-right"),
      );

    expect(columnAlignments(chat)).toEqual([false, true, false]);
    expect(
      chat?.querySelector("tbody tr:nth-child(2) td:nth-child(2)")?.className,
    ).toContain("tabular-nums");
    expect(columnAlignments(plain)).toEqual([false, false, false]);
    expect(chat?.parentElement?.className).toContain("border-border-hairline");
    expect(plain?.parentElement?.className).toContain("rounded-lg");
  });

  it("sets a fully bold opening paragraph as the headline of an assistant chat message", () => {
    const { container } = render(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview
          content={"**The 3090 is available.**\n\nNext: verify the files."}
          streamingTailOwner="thread:message:turn"
        />
        <MarkdownPreview
          content={"**TLDR:** The 3090 is available.\n\nNext."}
          streamingTailOwner="thread:other:turn"
        />
        <MarkdownPreview content={"**Not a message.**\n\nBody."} />
      </MarkdownTablesContainedContext.Provider>,
    );

    const leads = container.querySelectorAll("p[data-markdown-lead]");

    expect(leads).toHaveLength(1);
    expect(leads[0]?.textContent).toBe("The 3090 is available.");
    expect(leads[0]?.className).toContain("text-lead");
    expect(leads[0]?.className).toContain("mb-3");
  });

  it("keeps the headline to the first block across incremental pieces", () => {
    const { container, rerender } = render(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview
          content={"**Done.**"}
          incrementalBlocks
          streamingTail
          streamingTailOwner="thread:pieces:turn"
        />
      </MarkdownTablesContainedContext.Provider>,
    );

    expect(container.querySelector("p[data-markdown-lead]")).toBeNull();

    rerender(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview
          content={"**Done.**\n\nBody.\n\n**Also bold.**\n\nMore."}
          incrementalBlocks
          streamingTail
          streamingTailOwner="thread:pieces:turn"
        />
      </MarkdownTablesContainedContext.Provider>,
    );

    const leads = container.querySelectorAll("p[data-markdown-lead]");

    expect(leads).toHaveLength(1);
    expect(leads[0]?.textContent).toBe("Done.");
  });

  it("collapses long code blocks only in a settled chat timeline", () => {
    const code = `\`\`\`ts\n${Array.from(
      { length: 30 },
      (_, index) => `const line${index} = ${index};`,
    ).join("\n")}\n\`\`\``;

    const { container, rerender } = render(
      <>
        <MarkdownPreview content={code} />
        <MarkdownTablesContainedContext.Provider value>
          <MarkdownPreview
            content={code}
            streamingTailOwner="thread:settled:turn"
          />
        </MarkdownTablesContainedContext.Provider>
      </>,
    );

    expect(
      container.querySelectorAll("pre[data-markdown-code-collapsed]"),
    ).toHaveLength(1);

    const toggle = screen.getByRole("button", { name: "Show all 30 lines" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(
      container.querySelector("pre[data-markdown-code-collapsed]"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    rerender(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview
          content={code}
          streamingTail
          streamingTailOwner="thread:code:turn"
        />
      </MarkdownTablesContainedContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: /Show all/u })).toBeNull();

    rerender(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview content={code} streamingTailOwner="thread:code:turn" />
      </MarkdownTablesContainedContext.Provider>,
    );

    expect(
      container.querySelector("pre[data-markdown-code-collapsed]"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("keeps a long code block in a user chat message expanded", () => {
    const code = `\`\`\`ts\n${Array.from(
      { length: 30 },
      (_, index) => `const line${index} = ${index};`,
    ).join("\n")}\n\`\`\``;

    const { container } = render(
      <MarkdownTablesContainedContext.Provider value>
        <MarkdownPreview content={code} />
      </MarkdownTablesContainedContext.Provider>,
    );

    expect(container.querySelector("pre")).toBeTruthy();
    expect(
      container.querySelector("pre[data-markdown-code-collapsed]"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Show all/u })).toBeNull();
  });

  it("caps the table breakout at the nearest horizontally clipped ancestor", () => {
    const { notifyResize } = mockResizeObserverDeliveries();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const left = Number(this.dataset.left ?? 100);
        const width = Number(this.dataset.width ?? 300);

        return {
          bottom: 10,
          height: 10,
          left,
          right: left + width,
          top: 0,
          width,
          x: left,
          y: 0,
          toJSON: () => ({}),
        };
      },
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return Number((this as HTMLElement).dataset.width ?? 300);
      },
    );

    const renderClipped = (clipWidth: number) =>
      render(
        <div
          data-left="0"
          data-width={String(clipWidth)}
          style={{ overflowX: "hidden" }}
        >
          <MarkdownPreview content={"| A |\n| - |\n| B |"} />
        </div>,
      );

    const flush = renderClipped(400);

    const flushBreakout =
      flush.container.querySelector("table")?.parentElement?.parentElement;

    notifyResize();
    expect(
      flushBreakout?.style.getPropertyValue("--md-table-breakout-max"),
    ).toBe("300px");
    flush.unmount();

    const roomy = renderClipped(600);

    const roomyBreakout =
      roomy.container.querySelector("table")?.parentElement?.parentElement;

    notifyResize();
    expect(
      roomyBreakout?.style.getPropertyValue("--md-table-breakout-max"),
    ).toBe("500px");
    roomy.unmount();

    const sheet = document.createElement("style");
    sheet.textContent = ".overflow-x-hidden { overflow-x: hidden; }";
    document.head.appendChild(sheet);

    const rooted = render(
      <div data-left="0" data-width="600">
        <MarkdownPreview
          className="overflow-x-hidden"
          content={"| A |\n| - |\n| B |"}
        />
      </div>,
    );

    const rootedBreakout =
      rooted.container.querySelector("table")?.parentElement?.parentElement;

    notifyResize();
    expect(
      rootedBreakout?.style.getPropertyValue("--md-table-breakout-max"),
    ).toBe("300px");
    sheet.remove();
  });

  it("skips height-only resize events for tables", () => {
    const { notifyResize } = mockResizeObserverDeliveries();
    let width = 320;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        bottom: 0,
        height: 0,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    );

    const { container } = render(
      <MarkdownPreview content={"| A |\n| - |\n| B |"} />,
    );

    const breakout = container.querySelector("table")?.parentElement
      ?.parentElement as HTMLElement;

    expect(breakout.style.getPropertyValue("--md-content-w")).toBe("");
    notifyResize();
    expect(breakout.style.getPropertyValue("--md-content-w")).toBe("320px");

    breakout.style.setProperty("--md-content-w", "sentinel");
    notifyResize();
    expect(breakout.style.getPropertyValue("--md-content-w")).toBe("sentinel");

    width = 480;
    notifyResize();
    expect(breakout.style.getPropertyValue("--md-content-w")).toBe("480px");
  });

  it("keeps the starting number of an ordered list", () => {
    const { container } = render(
      <MarkdownPreview content={"> 2. What happens if debt is unpaid?"} />,
    );

    expect(container.querySelector("ol")?.getAttribute("start")).toBe("2");
  });

  it("HTML-escapes fenced code so it cannot inject markup", () => {
    const { container } = render(
      <MarkdownPreview
        content={'```ts\nconst html = "<script>alert(1)</script>";\n```'}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps highlighted code DOM until the code text changes", () => {
    const fence = "```ts\nconst a = 1;\n```";
    const view = render(<MarkdownPreview content={`${fence}\n\nPara one.`} />);
    const code = requireElement(view.container, "pre code");
    const line = requireElement(code, "span.sh__line");
    const observer = new MutationObserver(() => {});
    observer.observe(code, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    view.rerender(
      <MarkdownPreview content={`${fence}\n\nPara one.\n\nPara two.`} />,
    );

    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(view.container.textContent).toContain("Para two.");
    expect(mutations).toHaveLength(0);
    expect(line.isConnected).toBe(true);

    view.rerender(
      <MarkdownPreview
        content={"```ts\nconst a = 1;\nconst b = 2;\n```\n\nPara one."}
      />,
    );

    const expected = document.createElement("code");
    expected.innerHTML = highlightMarkdownCode({
      code: "const a = 1;\nconst b = 2;",
      language: "ts",
    });
    expect(requireElement(view.container, "pre code")).toBe(code);
    expect(code.innerHTML).toBe(expected.innerHTML);
    expect(code.querySelectorAll("span.sh__line")).toHaveLength(2);
  });

  it("renders inline-code Markdown file paths as local file links", () => {
    render(
      <MarkdownPreview
        content="Read `README.md`, `docs/guide.markdown:4`, and `src/app.ts`."
        linkRouting={workspaceLinkRouting}
      />,
    );

    expect(
      screen.getByRole("link", { name: "README.md" }).getAttribute("href"),
    ).toBe("file:///workspace/README.md");
    expect(
      screen
        .getByRole("link", { name: "docs/guide.markdown:4" })
        .getAttribute("href"),
    ).toBe("file:///workspace/docs/guide.markdown#L4");
    expect(screen.getByText("src/app.ts").tagName).toBe("CODE");
  });

  it("preserves inline commands ending in Markdown paths as code", () => {
    render(
      <MarkdownPreview
        content={
          "Added `orange` and ran `cat things.md`:\n\n```text\nasdf\napple\npear\norange\n```\n\n`cat /workspace/things.md` and `git diff docs/guide.markdown:4`. See [my notes](<notes/my notes.md>)."
        }
        linkRouting={workspaceLinkRouting}
      />,
    );

    for (const command of [
      "cat things.md",
      "cat /workspace/things.md",
      "git diff docs/guide.markdown:4",
    ]) {
      expect(screen.getByText(command).tagName).toBe("CODE");
      expect(screen.queryByRole("link", { name: command })).toBeNull();
    }

    expect(
      screen.getByRole("link", { name: "my notes" }).getAttribute("href"),
    ).toBe("file:///workspace/notes/my%20notes.md");
  });

  it("shows a context menu on local file links when the context provides items", () => {
    const openBuiltin = vi.fn();
    const openFinder = vi.fn();
    const openWithPlugin = vi.fn();
    render(
      <MarkdownLocalFileContextMenuContext.Provider
        value={(link) =>
          link.path.endsWith(".md")
            ? [
                {
                  id: "open-in",
                  items: [
                    {
                      id: "finder",
                      label: "Open in Finder",
                      onSelect: openFinder,
                    },
                  ],
                  label: "Open in",
                  type: "submenu",
                },
                {
                  id: "open-in-separator",
                  type: "separator",
                },
                {
                  id: "builtin",
                  label: "Open with built-in preview",
                  onSelect: openBuiltin,
                },
                {
                  id: "separator",
                  type: "separator",
                },
                {
                  id: "notes:editor",
                  label: "Open with Notes editor",
                  onSelect: openWithPlugin,
                },
              ]
            : null
        }
      >
        <MarkdownPreview
          content="See [notes](/workspace/notes/todo.md) and [app](/workspace/src/app.ts)."
          linkRouting={{
            localFile: {
              absoluteLinks: { kind: "trusted-host" },
              onOpenLink: vi.fn(() => true),
            },
          }}
        />
      </MarkdownLocalFileContextMenuContext.Provider>,
    );

    const link = screen.getByRole("link", { name: /notes/ });
    fireEvent.contextMenu(link);
    expect(screen.getByText("Open in")).not.toBeNull();
    fireEvent.click(screen.getByText("Open with Notes editor"));
    expect(openWithPlugin).toHaveBeenCalledTimes(1);
    expect(openFinder).not.toHaveBeenCalled();
    expect(openBuiltin).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole("link", { name: /app/ }));
    expect(screen.queryByText(/Open with/)).toBeNull();
  });

  it("leaves inline-code Markdown paths as code without local file routing", () => {
    render(<MarkdownPreview content="Read `README.md`." />);

    expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();
    expect(screen.getByText("README.md").tagName).toBe("CODE");
  });

  it("renders sanitized HTML video and source URLs through local file routing", () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={
          '<video controls poster="poster.png" title="Demo"><source src="clips/demo.mp4" type="video/mp4"></video>\n\n![image](still.mp4)\n\n[download](clips/demo.mp4)'
        }
        linkRouting={{
          localImage: {
            absolutePaths: { kind: "trusted-host" },
            relativePaths: { baseDir: "/workspace", rootPath: "/workspace" },
            resolveSrc: ({ path }) =>
              `/content?path=${encodeURIComponent(path)}`,
          },
        }}
      />,
    );

    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe(
      "/content?path=%2Fworkspace%2Fposter.png",
    );
    expect(video?.querySelector("source")?.getAttribute("src")).toBe(
      "/content?path=%2Fworkspace%2Fclips%2Fdemo.mp4",
    );
    expect(video?.querySelector("source")?.type).toBe("video/mp4");
    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.preload).toBe("metadata");
    expect(video?.getAttribute("aria-label")).toBe("Demo");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "download" })).not.toBeNull();
  });

  it("strips unsafe video attributes, URLs, and executable HTML", () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={
          '<video src="javascript:alert(1)" poster="javascript:alert(1)" onerror="alert(1)" autoplay style="position:fixed"><source src="javascript:alert(1)"></video><script>alert(1)</script><iframe src="https://example.com"></iframe>'
        }
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();

    for (const attribute of ["src", "poster", "onerror", "autoplay", "style"]) {
      expect(video?.hasAttribute(attribute)).toBe(false);
    }

    expect(video?.querySelector("source")?.hasAttribute("src")).toBe(false);
    expect(container.querySelector("script, iframe")).toBeNull();
  });

  it("preserves a video element as streaming Markdown grows", () => {
    const content =
      '<video src="https://example.com/clip.mp4" controls></video>\n\n';

    const { container, rerender } = render(
      <MarkdownPreview
        allowHtml
        incrementalBlocks
        content={content + "First"}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    rerender(
      <MarkdownPreview
        allowHtml
        incrementalBlocks
        content={content + "First paragraph grows"}
      />,
    );
    expect(container.querySelector("video")).toBe(video);
  });

  it("keeps video HTML disabled when not opted in and suppresses media in text-only previews", () => {
    const content =
      '<video src="https://example.com/clip.mp4" title="Demo"></video>';

    const { container, rerender } = render(
      <MarkdownPreview content={content} />,
    );

    expect(container.querySelector("video")).toBeNull();
    rerender(
      <MarkdownPreview allowHtml content={content} imagePolicy="alt-text" />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("[Video: Demo]")).not.toBeNull();
  });

  it("routes local Markdown images through the configured content resolver", () => {
    const resolveSrc = vi.fn(
      ({ path }: { path: string }) =>
        `/api/files/content?path=${encodeURIComponent(path)}`,
    );

    const { container } = render(
      <MarkdownPreview
        content={[
          "![absolute](/workspace/generated.png)",
          "![relative](art/chart.png)",
          "![remote](https://example.com/image.png)",
        ].join("\n\n")}
        linkRouting={{
          localImage: {
            absolutePaths: { kind: "trusted-host" },
            relativePaths: {
              baseDir: "/workspace",
              rootPath: "/workspace",
            },
            resolveSrc,
          },
        }}
      />,
    );

    expect(
      container.querySelector('img[alt="absolute"]')?.getAttribute("src"),
    ).toBe("/api/files/content?path=%2Fworkspace%2Fgenerated.png");
    expect(
      container.querySelector('img[alt="relative"]')?.getAttribute("src"),
    ).toBe("/api/files/content?path=%2Fworkspace%2Fart%2Fchart.png");
    expect(
      container.querySelector('img[alt="remote"]')?.getAttribute("src"),
    ).toBe("https://example.com/image.png");
    expect(resolveSrc).toHaveBeenCalledTimes(2);
  });

  it("keeps absolute app-origin URLs on the app-route path", () => {
    const onOpenLink = vi.fn(() => true);
    const href = `${window.location.origin}/threads/thr_localhost`;

    render(
      <MarkdownPreview
        content={`Open [local thread](${href}).`}
        linkRouting={{ onOpenLink }}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "local thread" }));

    expect(onOpenLink).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "local thread" }).getAttribute("href"),
    ).toBe(href);
  });

  it("routes editor file links to the local file handler with their editor", () => {
    const onOpenLink = vi.fn(() => true);
    const onOpenLocalFileLink = vi.fn(() => true);

    render(
      <MarkdownPreview
        content="Open [review](devin://file/Users/me/.omnyo/artifacts/thr_1/review.diff) or [cursor](Cursor://file/workspace/My%20App.ts:12:3)."
        linkRouting={{
          localFile: {
            absoluteLinks: { kind: "trusted-host" },
            onOpenLink: onOpenLocalFileLink,
          },
          onOpenLink,
        }}
      />,
    );

    const review = screen.getByRole("link", { name: "review" });
    expect(review.getAttribute("href")).toBe(
      "file:///Users/me/.omnyo/artifacts/thr_1/review.diff",
    );
    fireEvent.click(review);
    fireEvent.click(screen.getByRole("link", { name: "cursor" }));

    expect(onOpenLocalFileLink.mock.calls).toEqual([
      [
        {
          lineRange: null,
          openTargetId: "devin-desktop",
          path: "/Users/me/.omnyo/artifacts/thr_1/review.diff",
        },
      ],
      [
        {
          lineRange: { endLineNumber: 12, startLineNumber: 12 },
          openTargetId: "cursor",
          path: "/workspace/My App.ts",
        },
      ],
    ]);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("shows the editor logo only on links whose editor can open them", () => {
    const { container } = render(
      <MarkdownLocalFileOpenTargetsContext.Provider
        value={[
          {
            capabilities: {
              openDirectory: true,
              openFile: true,
              openFileAtLine: true,
            },
            icon: { kind: "builtin", name: "devin-desktop" },
            id: "devin-desktop",
            label: "Devin Desktop",
          },
        ]}
      >
        <MarkdownPreview
          content="[review](devin://file/tmp/review.diff:3) [app](vscode://file/tmp/app.ts) [plain](/tmp/notes.md)"
          linkRouting={{
            localFile: {
              absoluteLinks: { kind: "trusted-host" },
              onOpenLink: () => true,
            },
          }}
        />
      </MarkdownLocalFileOpenTargetsContext.Provider>,
    );

    const review = screen.getByRole("link", { name: "review" });
    expect(review.getAttribute("title")).toBe("Open in Devin Desktop");
    expect(review.querySelector("img")).not.toBeNull();

    for (const name of ["app", "plain"]) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("title")).toBeNull();
      expect(link.querySelector("img")).toBeNull();
      expect(link.querySelector("svg")).not.toBeNull();
    }

    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("keeps editor file links through the sanitized HTML path", () => {
    const onOpenLocalFileLink = vi.fn(() => true);

    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={
          'Press <kbd>Enter</kbd> for [review](devin://file/tmp/review.diff) or <a href="vscode://file/tmp/a.ts">code</a>, not <a href="javascript:alert(1)">script</a> or <a href="devin://chat-plugin/install?source=https://example.invalid/plugin">install</a>.'
        }
        linkRouting={{
          localFile: {
            absoluteLinks: { kind: "trusted-host" },
            onOpenLink: onOpenLocalFileLink,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "review" }));
    fireEvent.click(screen.getByRole("link", { name: "code" }));

    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(onOpenLocalFileLink.mock.calls).toEqual([
      [
        {
          lineRange: null,
          openTargetId: "devin-desktop",
          path: "/tmp/review.diff",
        },
      ],
      [{ lineRange: null, openTargetId: "vscode", path: "/tmp/a.ts" }],
    ]);
  });

  it("renders links with blocked protocols as inert text", () => {
    const onOpenLink = vi.fn(() => true);
    const onOpenLocalFileLink = vi.fn(() => true);

    const { container } = render(
      <MarkdownPreview
        content={
          "[script](javascript:alert(1)) [data](data:text/html,hi) [unknown](ms-msdt:/id) [install](devin://chat-plugin/install?source=https://example.invalid/plugin) [command](vscode://command/workbench.action.terminal.new) [query](vscode://file/tmp/a.ts?windowId=_blank) [zed](zed://file/tmp/a.ts) [empty]()"
        }
        linkRouting={{
          localFile: {
            absoluteLinks: { kind: "trusted-host" },
            onOpenLink: onOpenLocalFileLink,
          },
          onOpenLink,
        }}
      />,
    );

    expect(container.querySelectorAll("a")).toHaveLength(0);

    for (const name of [
      "script",
      "data",
      "unknown",
      "install",
      "command",
      "query",
      "zed",
      "empty",
    ]) {
      fireEvent.click(screen.getByText(name));
    }

    expect(onOpenLink).not.toHaveBeenCalled();
    expect(onOpenLocalFileLink).not.toHaveBeenCalled();
  });

  it("preserves original localhost URLs without a managed binding", () => {
    const displayedText = "http://127.0.0.1:5173";

    render(
      <MarkdownPreview
        content={`Open [${displayedText}](http://127.0.0.1:5173/demo).`}
      />,
    );

    const link = screen.getByRole("link", { name: displayedText });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:5173/demo");
  });

  it("keeps a rewritten link mounted across unrelated preview rerenders", () => {
    const content = "Open [preview](http://localhost:5173/demo).";

    const { rerender } = render(
      <MarkdownPreview className="first" content={content} />,
    );

    const link = screen.getByRole("link", { name: "preview" });

    rerender(<MarkdownPreview className="second" content={content} />);

    expect(screen.getByRole("link", { name: "preview" })).toBe(link);
  });

  it("renders inline LaTeX math with KaTeX", async () => {
    const { container } = render(
      <MarkdownPreview content={"Mass-energy is $$E = mc^2$$ exactly."} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
    expect(container.querySelector(".katex-display")).toBeNull();
  });

  it("leaves single-dollar spans as literal text", () => {
    const { container } = render(
      <MarkdownPreview
        content={"It went from $5 to $10 last week, so $x$ stays literal."}
      />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5 to $10");
    expect(container.textContent).toContain("$x$");
  });

  it("leaves escaped dollar amounts as literal text", () => {
    const { container } = render(
      <MarkdownPreview content={"It went from \\$5 to \\$10 last week."} />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  it("renders math while still sanitizing untrusted HTML when allowHtml is set", async () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={"$$a^2 + b^2 = c^2$$\n\n<script>alert(1)</script>"}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert(1)");
  });

  it("contains invalid TeX instead of throwing", async () => {
    const { container } = render(
      <MarkdownPreview content={"Broken: $$\\frac{1}{$$ keeps rendering."} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex-error")).not.toBeNull(),
    );
    expect(container.textContent).toContain("keeps rendering.");
  });

  it("closes a display math block whose `$$` delimiters are glued to the TeX (#1778)", async () => {
    const { container } = render(
      <MarkdownPreview
        content={[
          "Before the formula.",
          "",
          "$$T_{\\text{appearance}\\rightarrow\\text{chunk}}",
          "\\approx73\\text{--}146\\text{ ms}$$",
          "",
          "## Content after the formula",
          "",
          "- This should remain a list item.",
          "- [This should remain a link](https://example.com).",
        ].join("\n")}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    );
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(
      container.querySelector(".katex-display annotation")?.textContent,
    ).toContain("appearance");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Content after the formula",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(
      container.querySelector('a[href="https://example.com"]')?.textContent,
    ).toBe("This should remain a link");
  });
});
