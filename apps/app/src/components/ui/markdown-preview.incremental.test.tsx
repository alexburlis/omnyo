// @vitest-environment jsdom

import { LazyMarkdownHtml } from "./lazy-markdown-html";

import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import {
  Component,
  useEffect,
  type ComponentProps,
  type ReactNode,
} from "react";
import { renderToString } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { RouteNavigationProvider } from "./app-route-anchor";
import { buildMarkdownMessageLinkRouting } from "./markdown-message-link-routing";
import {
  buildMessageDirectiveRegistry,
  MESSAGE_DIRECTIVE_MOUNT_LIMIT,
} from "./markdown-message-directives";
import { MarkdownPreview } from "./markdown-preview";

beforeAll(() => LazyMarkdownHtml.preload());

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();

  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        get: vi.fn(() => new Promise(() => {})),
        resolveMentions: vi.fn(() => new Promise(() => {})),
      },
    },
  };
});

vi.mock("./markdown-mermaid-loader.js", () => ({
  loadMermaid: () => new Promise(() => {}),
}));

const LEGS = ["incremental", "legacy"] as const;

type PreviewLeg = (typeof LEGS)[number];

interface DirectiveCounts {
  attributeEffects: number;
  mounts: number;
  renders: number;
}

const counts: Record<PreviewLeg, DirectiveCounts> = {
  incremental: { attributeEffects: 0, mounts: 0, renders: 0 },
  legacy: { attributeEffects: 0, mounts: 0, renders: 0 },
};

function countingDirective(leg: PreviewLeg) {
  return function InlineVis({
    attributes,
    source,
  }: PluginMessageDirectiveProps) {
    counts[leg].renders += 1;
    useEffect(() => {
      counts[leg].mounts += 1;
    }, []);
    useEffect(() => {
      counts[leg].attributeEffects += 1;
    }, [attributes]);

    return (
      <div data-testid="inline-vis" data-file={attributes.file ?? ""}>
        {source}
      </div>
    );
  };
}

function legMessageDirectives(leg: PreviewLeg) {
  return {
    registry: buildMessageDirectiveRegistry([
      {
        id: "inline-vis",
        pluginId: "demo",
        generation: 1,
        component: countingDirective(leg),
      },
    ]),
    message: {
      id: "msg_stream",
      threadId: "thr_stream",
      turnId: "turn_stream",
      projectId: null,
    },
    openWorkspaceFile: null,
    openThreadPanel: null,
  };
}

const messageDirectives = {
  incremental: legMessageDirectives("incremental"),
  legacy: legMessageDirectives("legacy"),
};

const linkRouting = buildMarkdownMessageLinkRouting({
  onOpenLocalFileLink: () => true,
  threadId: "thr_stream",
  workspaceRootPath: "/workspace",
});

const threadMentions = { mentions: [], preserveSoftBreaks: false };

const sectionNamesById = new Map<string, string>();

const projectNamesById = new Map<string, string>();

const mentionedThread = makeThreadListEntry({
  id: "thr_mentioned",
  title: "Related thread",
});

const threadById = new Map([[mentionedThread.id, mentionedThread]]);

const rawThreadId = "thr_dcwivn5n8w";

interface PreviewTreeArgs {
  allowHtml?: boolean;
  content: string;
  leg: PreviewLeg;
  wrapper: (props: { children: ReactNode }) => ReactNode;
  previewProps?: Partial<ComponentProps<typeof MarkdownPreview>> & {
    streamingTail?: boolean;
    streamingTailOwner?: string;
  };
}

function PreviewTree({
  content,
  leg,
  wrapper: Wrapper,
  allowHtml = false,
  previewProps,
}: PreviewTreeArgs) {
  return (
    <Wrapper>
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={sectionNamesById}
            projectNamesById={projectNamesById}
            threadById={threadById}
          >
            <MarkdownPreview
              content={content}
              allowHtml={allowHtml}
              incrementalBlocks={leg === "incremental"}
              linkRouting={linkRouting}
              messageDirectives={messageDirectives[leg]}
              threadMentions={threadMentions}
              {...previewProps}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </Wrapper>
  );
}

function mutationSignature(record: MutationRecord): string {
  return [
    record.type,
    record.attributeName ?? "",
    record.target.nodeName,
    record.addedNodes.length,
    record.removedNodes.length,
  ].join(":");
}

function createDifferentialLegs(initialContent = "") {
  const { queryClient, wrapper } = createQueryClientTestHarness();

  const views = {
    incremental: render(
      <PreviewTree
        content={initialContent}
        leg="incremental"
        wrapper={wrapper}
      />,
    ),
    legacy: render(
      <PreviewTree content={initialContent} leg="legacy" wrapper={wrapper} />,
    ),
  };

  const observers = {
    incremental: new MutationObserver(() => {}),
    legacy: new MutationObserver(() => {}),
  };

  for (const leg of LEGS) {
    observers[leg].observe(views[leg].container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  return {
    incremental: views.incremental.container,
    queryClient,
    update(content: string) {
      for (const leg of LEGS) {
        views[leg].rerender(
          <PreviewTree content={content} leg={leg} wrapper={wrapper} />,
        );
      }

      expect(
        views.incremental.container.innerHTML,
        JSON.stringify(content),
      ).toBe(views.legacy.container.innerHTML);

      return {
        incrementalMutations: observers.incremental
          .takeRecords()
          .map(mutationSignature),
        legacyMutations: observers.legacy.takeRecords().map(mutationSignature),
      };
    },
  };
}

function lineSteps(document: string): string[] {
  const steps: string[] = [];
  let lineStart = 0;

  while (lineStart < document.length) {
    const newline = document.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? document.length : newline + 1;
    const middle = lineStart + Math.floor((lineEnd - lineStart) / 2);

    if (middle > lineStart) {
      steps.push(document.slice(0, middle));
    }

    steps.push(document.slice(0, lineEnd));
    lineStart = lineEnd;
  }

  return steps;
}

const CURATED_DOCUMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "lists",
    "- a\nlazy\n\n- b\n\n\n- c\n\n  continued\n\n1. Step\n\n   ```bash\n   run\n\n   more\n   ```\n\n2. Next\n\nAfter.",
  ],
  [
    "code and html flow",
    "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n<pre>\nline\n\nmore\n</pre>\n\n<!-- note\n\nstill -->\n\n    indented\n\n> - quoted\n\nDone.",
  ],
  [
    "math, mermaid, and tables",
    "Before the formula.\n\n$$T_{a}\n\\approx73$$\n\n## After\n\n```mermaid\ngraph TD\nA-->B\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nRun `echo $$` now.\n\n$$\n\nAfter the stray line.",
  ],
  [
    "directives, mentions, and links",
    'Intro.\n\n::inline-vis{file="a.html"}\n\n> quoted **bold**\n\nSee thr_mentioned and @thread:thr_mentioned.\n\n[My file](</workspace/My File.ts:12>) and ![img](/workspace/a.png)\n\n:::note\nbox\n\n::inline-vis{file="b.html"}\n:::\n\nTail.',
  ],
  [
    "glued directives and attribute formatting",
    'Intro.\n\n::inline-vis{file="my*report*.html"}Next **bold** [docs].\n::inline-vis{file="second.html"}\n\n> ::inline-vis{file="quote.html"}Quoted *tail*.\n\n\\::inline-vis{file="literal.html"}Literal.\n\n[docs]: https://example.com\n',
  ],
  [
    "prefixed directives with formatted prose and multiple mounts",
    'Omnyo didnt **format this** ::inline-vis{file="first.html"} Next [docs](https://example.com) ::inline-vis{file="second.html"} *tail*.\n\n> Quoted ::inline-vis{file="quote.html"} suffix.\n\nLiteral `::inline-vis{file="code.html"}`.',
  ],
  [
    "frontmatter and late references",
    "---\ntitle: Plan\nowner: me\n---\n\nUse [the docs] and a note[^1].\n\nMiddle.\n\n[the docs]: https://example.com\n\n[^1]: The note.\n\nAfter.",
  ],
];

beforeAll(async () => {
  const view = render(<MarkdownPreview content={"$$\nx\n$$"} />);
  await waitFor(() =>
    expect(view.container.querySelector(".katex-display")).not.toBeNull(),
  );
  view.unmount();
});

beforeEach(() => {
  for (const leg of LEGS) {
    counts[leg] = { attributeEffects: 0, mounts: 0, renders: 0 };
  }

  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MarkdownPreview incremental blocks", () => {
  it("preserves directives and thread mentions alongside sanitized HTML video", () => {
    const { container } = render(
      <PreviewTree
        allowHtml
        leg="legacy"
        wrapper={({ children }) => <div>{children}</div>}
        content={
          '<video src="https://example.com/clip.mp4" controls></video>\n\n::inline-vis{file="a.html"}\n\n@thread:thr_mentioned'
        }
      />,
    );

    expect(container.querySelector("video")).not.toBeNull();
    expect(
      within(container).getByTestId("inline-vis").getAttribute("data-file"),
    ).toBe("a.html");
    expect(container.textContent).toContain("Related thread");
  });

  it.each(CURATED_DOCUMENTS)(
    "renders the same DOM as a single document at every line step: %s",
    (_label, document) => {
      const legs = createDifferentialLegs();

      for (const step of lineSteps(document)) {
        legs.update(step);
      }
    },
    60_000,
  );

  it.each(["", "Next **bold** tail."])(
    "keeps settled code and directive DOM connected across advances and a late definition: %s",
    (tail) => {
      const initial =
        'Intro.\n\n```ts\nconst a = 1;\n```\n\n::inline-vis{file="a.html"}' +
        tail +
        "\n\nUse [docs].\n\n";

      const legs = createDifferentialLegs(initial);
      const line = legs.incremental.querySelector("pre code span.sh__line");
      const directive = within(legs.incremental).getByTestId("inline-vis");

      if (line === null) {
        throw new Error("Expected a highlighted settled code block");
      }

      const advanced = `${initial}More.\n\n`;
      legs.update(advanced);
      expect(line.isConnected).toBe(true);
      expect(directive.isConnected).toBe(true);

      legs.update(`${advanced}[docs]: https://example.com\n\n`);
      expect(
        within(legs.incremental)
          .getByRole("link", { name: "docs" })
          .getAttribute("href"),
      ).toBe("https://example.com");
      expect(line.isConnected).toBe(true);
      expect(directive.isConnected).toBe(true);
      expect(counts.incremental.mounts).toBe(1);
    },
  );

  it("mounts the first 32 of 34 directives across pieces like a single document", () => {
    const content = Array.from(
      { length: MESSAGE_DIRECTIVE_MOUNT_LIMIT + 2 },
      (_, index) =>
        `Paragraph ${index}.\n\n::inline-vis{file="f${index}.html"}`,
    ).join("\n\n");

    const legs = createDifferentialLegs();

    legs.update(content);

    const incremental = within(legs.incremental);
    expect(
      incremental
        .getAllByTestId("inline-vis")
        .map((node) => node.getAttribute("data-file")),
    ).toEqual(
      Array.from(
        { length: MESSAGE_DIRECTIVE_MOUNT_LIMIT },
        (_, index) => `f${index}.html`,
      ),
    );
    expect(incremental.getByText('::inline-vis{file="f33.html"}').tagName).toBe(
      "P",
    );
  });

  it("re-reads cached raw thread titles in settled pieces on every new body like a single document", async () => {
    const first = `Continue in ${rawThreadId} when ready.\n\nSee [${rawThreadId}](https://example.com/x) here.\n\n`;
    const legs = createDifferentialLegs(first);
    await act(async () => {
      legs.queryClient.setQueryData(
        threadQueryKey(rawThreadId),
        makeThreadResponse({
          id: rawThreadId,
          title: "Rebuild comments",
          titleFallback: "Rebuild comments",
        }),
      );
    });

    legs.update(`${first}Second paragraph.\n\n`);
    expect(legs.incremental.textContent).toContain(
      "Continue in Rebuild comments when ready.",
    );
    legs.update(`${first}Second paragraph.\n\nThird.`);
  });

  it("shows a raw thread title as soon as the thread reaches the cache", async () => {
    const legs = createDifferentialLegs(`Continue in ${rawThreadId}.\n\n`);
    await act(async () => {
      legs.queryClient.setQueryData(
        threadQueryKey(rawThreadId),
        makeThreadResponse({
          id: rawThreadId,
          title: "Rebuild comments",
          titleFallback: "Rebuild comments",
        }),
      );
    });

    expect(legs.incremental.textContent).toContain(
      "Continue in Rebuild comments.",
    );
  });

  it("re-renders plugin directives with fresh attributes on every new body like a single document", () => {
    const first = 'Intro.\n\n::inline-vis{file="a.html"}\n\n';
    const legs = createDifferentialLegs(first);

    const steps = [
      `${first}Second paragraph.\n\n`,
      `${first}Second paragraph.\n\nThird paragraph.\n\n`,
      `${first}Second paragraph.\n\nThird paragraph.\n\nFourth.`,
    ];

    for (const step of steps) {
      legs.update(step);
      expect(counts.incremental).toEqual(counts.legacy);
    }

    expect(counts.legacy.attributeEffects).toBe(steps.length + 1);
  });

  it("commits the same DOM mutations as a single document while settled content grows", () => {
    const blocks = [
      "# Plan\n\n",
      "See [the docs](https://example.com/docs) and [a file](</workspace/src/a.ts:12>).\n\n",
      "```ts\nconst a = 1;\n```\n\n",
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n",
      '::inline-vis{file="a.html"}\n\n',
      "- one\n- two with `code`\n\n",
      `> Quoted ${rawThreadId} and @thread:thr_mentioned.\n\n`,
      "1. First\n2. Second\n\n",
      "Closing paragraph with **bold** and ![img](/workspace/a.png).",
    ];

    let body = blocks[0] ?? "";
    const legs = createDifferentialLegs(body);

    for (const block of blocks.slice(1)) {
      body += block;
      const { incrementalMutations, legacyMutations } = legs.update(body);
      expect(incrementalMutations, body).toEqual(legacyMutations);
    }
  });
});

interface WorkerParseRequest {
  id: number;
  source: string;
  directives: boolean;
}

class ControlledMarkdownWorker extends EventTarget {
  static instances: ControlledMarkdownWorker[] = [];
  requests: WorkerParseRequest[] = [];
  terminated = false;

  constructor() {
    super();
    ControlledMarkdownWorker.instances.push(this);
  }

  postMessage(request: WorkerParseRequest) {
    this.requests.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  reply(overrides: Partial<WorkerParseRequest> = {}) {
    const request = this.requests.at(-1);

    if (request === undefined) throw new Error("Expected a parse request");

    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath, { singleDollarTextMath: false });

    if (request.directives) processor.use(remarkDirective);
    const tree = processor.parse(request.source);
    const original = structuredClone(tree);
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { ...request, ...overrides, tree },
      }),
    );

    return { tree, original };
  }
}

interface MarkdownErrorState {
  error: Error | null;
}

class MarkdownErrorBoundary extends Component<
  { children: ReactNode },
  MarkdownErrorState
> {
  state: MarkdownErrorState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <div role="alert">{this.state.error.message}</div>
    );
  }
}

const LARGE_PARAGRAPH =
  "**Selected** ~~removed~~ [safe](https://example.com) " +
  "[blocked](javascript:evil) ![preview](https://example.com/a.png) " +
  "$5 $$x$$ @thread:thr_mentioned " +
  "plain ".repeat(18_000);

function previewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function streamingPreview(
  content: string,
  previewProps: PreviewTreeArgs["previewProps"] = {},
) {
  return (
    <MarkdownErrorBoundary>
      <PreviewTree
        content={content}
        leg="incremental"
        wrapper={previewWrapper}
        previewProps={{ streamingTail: true, ...previewProps }}
      />
    </MarkdownErrorBoundary>
  );
}

function currentWorker() {
  const worker = ControlledMarkdownWorker.instances.at(-1);
  expect(
    worker,
    "Expected the eligible live tail to request a worker",
  ).toBeDefined();

  if (worker === undefined) throw new Error("Expected a Markdown worker");

  return worker;
}

describe("large live Markdown worker ownership", () => {
  beforeEach(() => {
    ControlledMarkdownWorker.instances = [];
    vi.stubGlobal("Worker", ControlledMarkdownWorker);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("acquires the worker only after mount and preserves rich syntax, safe URLs, mentions, and fresh parsed nodes", async () => {
    renderToString(streamingPreview(LARGE_PARAGRAPH));
    expect(ControlledMarkdownWorker.instances).toHaveLength(0);
    const view = render(streamingPreview(LARGE_PARAGRAPH));
    expect(
      within(view.container).getByRole("status", { hidden: true }),
    ).toBeDefined();
    const worker = currentWorker();
    expect(worker.requests).toHaveLength(1);
    let parsed: ReturnType<ControlledMarkdownWorker["reply"]> | undefined;
    await act(async () => {
      parsed = worker.reply();
    });

    const legacy = render(
      <PreviewTree
        content={LARGE_PARAGRAPH}
        leg="legacy"
        wrapper={previewWrapper}
        previewProps={{ streamingTail: true }}
      />,
    );

    expect(view.container.innerHTML).toBe(legacy.container.innerHTML);
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Selected",
    );
    expect(view.container.querySelector("del")?.textContent).toBe("removed");
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(view.container.textContent).toContain("blocked");
    expect(view.container.querySelector(".katex")).not.toBeNull();
    expect(view.container.textContent).toContain("$5");
    expect(view.container.textContent).toContain("Related thread");
    expect(parsed?.tree).toEqual(parsed?.original);
  });

  it("retains the first resolved children and selection while an append crosses the worker threshold", async () => {
    const small = "**Selected** " + "plain ".repeat(16_000);
    const view = render(streamingPreview(small));
    const selected = view.container.querySelector("strong")?.firstChild;

    if (selected === null || selected === undefined)
      throw new Error("Expected selected text");
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(selected, 1);
    range.setEnd(selected, 5);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const large = small + " appended".repeat(2_000);
    view.rerender(streamingPreview(large));
    expect(view.container.querySelector("strong")?.firstChild).toBe(selected);
    expect(selection?.toString()).toBe("elec");
    expect(view.container.textContent).not.toContain("appended");
    const worker = currentWorker();
    await act(async () => {
      worker.reply();
    });
    expect(view.container.textContent).toContain("appended");
    expect(selected.isConnected).toBe(true);
    expect(selection?.toString()).toBe("elec");
    view.rerender(
      streamingPreview(large + " reconfigured", {
        urlTransform: (url) => url,
      }),
    );
    expect(selected.isConnected).toBe(true);
    expect(selection?.toString()).toBe("elec");
    expect(
      within(view.container).queryByRole("status", { hidden: true }),
    ).toBeNull();
    expect(view.container.textContent).not.toContain("reconfigured");
    await act(async () => {
      currentWorker().reply();
    });
    expect(view.container.textContent).toContain("reconfigured");
    expect(selected.isConnected).toBe(true);
    expect(selection?.toString()).toBe("elec");
  });

  it("never displays prior children for a replacement or changed render configuration", async () => {
    const view = render(streamingPreview(LARGE_PARAGRAPH));
    await act(async () => {
      currentWorker().reply();
    });
    const originalWorker = currentWorker();
    view.rerender(streamingPreview(LARGE_PARAGRAPH + " append"));
    view.rerender(streamingPreview("Replacement " + "new ".repeat(26_000)));
    expect(originalWorker.terminated).toBe(true);
    expect(view.container.textContent).not.toContain("Selected");
    expect(
      within(view.container).getByRole("status", { hidden: true }),
    ).toBeDefined();
    await act(async () => {
      originalWorker.reply();
    });
    expect(view.container.textContent).not.toContain("Selected");
    await act(async () => {
      currentWorker().reply();
    });
    expect(view.container.textContent).toContain("Replacement");

    view.rerender(streamingPreview(LARGE_PARAGRAPH));
    await act(async () => {
      currentWorker().reply();
    });
    expect(view.container.querySelector("img")).not.toBeNull();
    view.rerender(
      streamingPreview(LARGE_PARAGRAPH + " append", {
        imagePolicy: "alt-text",
      }),
    );
    expect(view.container.querySelector("img")).toBeNull();
    await act(async () => {
      currentWorker().reply();
    });
    expect(view.container.textContent).toContain("preview");
  });

  it("rejects retained children and a late result when the mounted preview changes message owner", async () => {
    const view = render(
      streamingPreview(LARGE_PARAGRAPH, { streamingTailOwner: "message-a" }),
    );

    await act(async () => {
      currentWorker().reply();
    });
    view.rerender(
      streamingPreview(LARGE_PARAGRAPH + " pending", {
        streamingTailOwner: "message-a",
      }),
    );
    const previousWorker = currentWorker();
    view.rerender(
      streamingPreview(LARGE_PARAGRAPH + " pending for B", {
        streamingTailOwner: "message-b",
      }),
    );
    expect(previousWorker.terminated).toBe(true);
    expect(view.container.querySelector("strong")).toBeNull();
    expect(
      within(view.container).getByRole("status", { hidden: true }),
    ).toBeDefined();
    await act(async () => {
      previousWorker.reply();
    });
    expect(view.container.querySelector("strong")).toBeNull();
    await act(async () => {
      currentWorker().reply();
    });
    expect(view.container.textContent).toContain("pending for B");
  });

  it("shares one in-flight worker, keeps only the latest queued source, and releases an unmounted owner", async () => {
    const first = render(streamingPreview("First " + LARGE_PARAGRAPH));
    const secondSource = "Second " + LARGE_PARAGRAPH;
    const second = render(streamingPreview(secondSource));
    const worker = currentWorker();
    second.rerender(streamingPreview(secondSource + " obsolete"));
    second.rerender(streamingPreview(secondSource + " latest"));
    expect(ControlledMarkdownWorker.instances).toHaveLength(1);
    expect(worker.requests).toHaveLength(1);
    first.unmount();
    expect(worker.terminated).toBe(true);
    const nextWorker = currentWorker();
    expect(nextWorker).not.toBe(worker);
    expect(nextWorker.requests).toHaveLength(1);
    expect(nextWorker.requests[0]?.source).toBe(secondSource + " latest");
    await act(async () => {
      worker.reply();
    });
    expect(second.container.textContent).not.toContain("First");
    await act(async () => {
      nextWorker.reply();
    });
    expect(second.container.textContent).toContain("latest");
    second.unmount();
    expect(nextWorker.terminated).toBe(true);
  });

  it("rejects a mismatched source or directive flag until the exact result arrives", async () => {
    const view = render(streamingPreview(LARGE_PARAGRAPH));
    const worker = currentWorker();
    await act(async () => {
      worker.reply({ source: "stale" });
      worker.reply({ directives: false });
    });
    expect(
      within(view.container).getByRole("status", { hidden: true }),
    ).toBeDefined();
    expect(view.container.querySelector("strong")).toBeNull();
    await act(async () => {
      worker.reply();
    });
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Selected",
    );
  });

  it.each(["error", "messageerror", "timeout"])(
    "surfaces %s without a parser fallback and lets the next owner run",
    async (failure) => {
      vi.useFakeTimers();
      const view = render(streamingPreview(LARGE_PARAGRAPH));
      const worker = currentWorker();
      view.rerender(streamingPreview(LARGE_PARAGRAPH + " queued append"));
      expect(worker.requests).toHaveLength(1);
      await act(async () => {
        if (failure === "timeout") vi.advanceTimersByTime(2_001);
        else worker.dispatchEvent(new Event(failure));
      });
      expect(worker.terminated).toBe(true);
      expect(
        within(view.container).getByRole("alert", { hidden: true }).textContent,
      ).toMatch(/worker|parse|timed out/iu);
      expect(view.container.querySelector("strong")).toBeNull();
      view.unmount();
      const next = render(streamingPreview("Next " + LARGE_PARAGRAPH));
      expect(currentWorker()).not.toBe(worker);
      await act(async () => {
        currentWorker().reply();
      });
      expect(next.container.textContent).toContain("Next");
    },
  );

  it.each([
    [
      "static HTML",
      "<b>html</b> " + LARGE_PARAGRAPH,
      { streamingTail: false, allowHtml: true },
    ],
    [
      "static glued directive",
      '::inline-vis{file="a.html"}' + LARGE_PARAGRAPH,
      { streamingTail: false },
    ],
    [
      "static prompt mentions",
      LARGE_PARAGRAPH,
      { streamingTail: false, promptMentions: { mentions: [] } },
    ],
    ["HTML", "<b>html</b> " + LARGE_PARAGRAPH, { allowHtml: true }],
    ["prompt mentions", LARGE_PARAGRAPH, { promptMentions: { mentions: [] } }],
    ["piece boundary", "Settled.\n\n" + LARGE_PARAGRAPH, {}],
    ["glued directive", '::inline-vis{file="a.html"}' + LARGE_PARAGRAPH, {}],
  ] as const)(
    "keeps %s on the existing synchronous path",
    (name, source, props) => {
      const view = render(streamingPreview(source, props));
      expect(ControlledMarkdownWorker.instances).toHaveLength(0);
      expect(view.container.querySelector("strong")?.textContent).toBe(
        "Selected",
      );
      expect(within(view.container).queryByRole("status")).toBeNull();

      if (name.includes("directive")) {
        expect(
          view.container.querySelector('[data-file="a.html"]'),
        ).not.toBeNull();
      }

      if (name.includes("HTML")) {
        expect(view.container.querySelector("b")?.textContent).toBe("html");
      }
    },
  );
});
