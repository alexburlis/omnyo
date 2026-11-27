import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type { CanvasNode } from "../contract";
import { HtmlFrame } from "../components/html-frame";
import { NodeCard } from "../components/node";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("mounts an inactive view's document right away and keeps its frame across activation", () => {
  const props = {
    html: "<input value=original>",
    title: "Inactive view",
    canvasNavigation: true,
  };

  const { container, rerender } = render(<HtmlFrame {...props} active={false} />);
  const frame = screen.getByTitle("Inactive view");

  expect(container.querySelector(".cnv-frame-placeholder")).toBeNull();
  expect(frame.getAttribute("srcdoc")).toContain("<input value=original>");
  rerender(<HtmlFrame {...props} active />);
  expect(screen.getByTitle("Inactive view")).toBe(frame);
  rerender(<HtmlFrame {...props} active={false} />);
  expect(screen.getByTitle("Inactive view")).toBe(frame);
});

function moduleNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "module",
    kind: "html",
    order: 0,
    section: "Work",
    title: "Module",
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<p>Module</p>",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 1,
    updatedAt: 0,
    ...overrides,
  };
}

function captureObservers() {
  const observed: Element[] = [];

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {}
    },
  );

  return observed;
}

const cardProps = {
  change: null,
  selected: false,
  workspace: { hostId: null, environmentId: null },
  actions: { choose: async () => {} },
  estimatedHeight: 333,
  onSelect: () => {},
  onMeasure: () => {},
} as const;

it("holds a card while its data loads, then measures what it shows after a second", () => {
  vi.useFakeTimers();
  const observed = captureObservers();

  try {
    const { container } = render(
      <NodeCard {...cardProps} node={moduleNode({ kind: "note", html: null })} measureKey={null} />,
    );

    const card = container.querySelector<HTMLElement>('[data-node-id="module"]');

    if (!card) throw new Error("Missing card");
    expect(card.style.height).toBe("333px");
    expect(observed).not.toContain(card);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(card.style.height).toBe("");
    expect(observed).toContain(card);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a remembered card at its remembered height for as long as its data is loading", () => {
  vi.useFakeTimers();
  const observed = captureObservers();

  try {
    const { container } = render(
      <NodeCard
        {...cardProps}
        node={moduleNode({ kind: "note", html: null })}
        measureKey={null}
        remembered
      />,
    );

    const card = container.querySelector<HTMLElement>('[data-node-id="module"]');

    if (!card) throw new Error("Missing card");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(card.style.height).toBe("333px");
    expect(observed).not.toContain(card);
  } finally {
    vi.useRealTimers();
  }
});

it("holds a settled framed card again when its content changes, until the new content settles", () => {
  vi.useFakeTimers();

  try {
    const { container, rerender } = render(
      <NodeCard {...cardProps} node={moduleNode()} measureKey="revision-1" />,
    );

    const card = container.querySelector<HTMLElement>('[data-node-id="module"]');
    const first = screen.getByTitle("Module");

    if (!card || !(first instanceof HTMLIFrameElement)) throw new Error("Missing card");

    const post = (frame: HTMLIFrameElement, height: number) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { canvasFrameHeight: height },
            source: frame.contentWindow,
          }),
        );
      });

    post(first, 400);
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(card.style.height).toBe("");

    rerender(
      <NodeCard
        {...cardProps}
        node={moduleNode({ updatedRevision: 2, html: "<p>Changed</p>" })}
        measureKey="revision-2"
      />,
    );

    const second = screen.getByTitle("Module");

    if (!(second instanceof HTMLIFrameElement)) throw new Error("Missing new frame");
    expect(second).not.toBe(first);
    expect(card.style.height).toBe("333px");
    post(first, 410);
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(card.style.height).toBe("333px");
    post(second, 500);
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(card.style.height).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

it("holds a video card until its metadata gives it a size", () => {
  renderSlot(
    { component: NodeCard },
    {
      ...cardProps,
      node: moduleNode({ kind: "video", html: null, assetId: "clip" }),
      measureKey: "revision-1",
    },
    { pluginId: "canvas" },
  );

  const card = document.querySelector<HTMLElement>('[data-node-id="module"]');
  const video = document.querySelector("video");

  if (!card || !video) throw new Error("Missing video card");
  expect(card.style.height).toBe("333px");
  fireEvent.loadedMetadata(video);
  expect(card.style.height).toBe("");
});

it("holds a framed card until its frame settles and measures only the settled card", () => {
  vi.useFakeTimers();
  let intersect: (() => void) | undefined;

  const observed: {
    target: Element;
    callback: ResizeObserverCallback;
    observer: ResizeObserver;
  }[] = [];

  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push({ target, callback: this.callback, observer: this });
      }
      unobserve() {}
      disconnect() {}
    },
  );

  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];

      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        intersect = () =>
          this.callback(
            [
              {
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: new DOMRect(),
                intersectionRect: new DOMRect(),
                rootBounds: null,
                time: 0,
              },
            ],
            this,
          );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );

  const node: CanvasNode = {
    id: "module",
    kind: "html",
    order: 0,
    section: "Work",
    title: "Module",
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<p>Module</p>",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 1,
    updatedAt: 0,
  };

  const measured: [string, number, string][] = [];

  try {
    const { container } = render(
      <NodeCard
        node={node}
        change={null}
        selected={false}
        workspace={{ hostId: null, environmentId: null }}
        actions={{ choose: async () => {} }}
        estimatedHeight={333}
        measureKey="revision-1"
        onSelect={() => {}}
        onMeasure={(id, height, key) => measured.push([id, height, key])}
      />,
    );

    const card = container.querySelector<HTMLElement>('[data-node-id="module"]');

    if (!card) throw new Error("Missing card");
    expect(card.style.height).toBe("333px");
    expect(card.style.overflow).toBe("clip");
    act(() => intersect?.());
    const frame = screen.getByTitle("Module");

    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing frame");

    const post = (height: number) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { canvasFrameHeight: height },
            source: frame.contentWindow,
          }),
        );
      });

    expect(card.hasAttribute("data-content-deferred")).toBe(false);
    post(1);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    post(520);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(card.style.height).toBe("333px");
    expect(card.style.overflow).toBe("clip");
    expect(observed.some((entry) => entry.target === card)).toBe(false);

    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(card.style.height).toBe("");
    expect(card.style.overflow).toBe("");

    const watch = observed.find((entry) => entry.target === card);

    if (!watch) throw new Error("The settled card is not observed");
    act(() =>
      watch.callback(
        [
          {
            target: card,
            contentRect: new DOMRect(),
            borderBoxSize: [{ blockSize: 600, inlineSize: 0 }],
            contentBoxSize: [{ blockSize: 600, inlineSize: 0 }],
            devicePixelContentBoxSize: [{ blockSize: 600, inlineSize: 0 }],
          },
        ],
        watch.observer,
      ),
    );
    expect(measured).toEqual([["module", 600, "revision-1"]]);
  } finally {
    vi.useRealTimers();
  }
});

it("releases a framed card's hold after its frame loads without ever reporting a height", async () => {
  vi.useFakeTimers();

  const node: CanvasNode = {
    id: "silent",
    kind: "html",
    order: 0,
    section: "Work",
    title: "Silent",
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<!--",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 1,
    updatedAt: 0,
  };

  try {
    const { container } = render(
      <NodeCard
        node={node}
        change={null}
        selected={false}
        workspace={{ hostId: null, environmentId: null }}
        actions={{ choose: async () => {} }}
        estimatedHeight={333}
        onSelect={() => {}}
      />,
    );

    const card = container.querySelector<HTMLElement>('[data-node-id="silent"]');
    const frame = screen.getByTitle("Silent");

    if (!card) throw new Error("Missing card");
    expect(card.style.height).toBe("333px");
    fireEvent.load(frame);
    expect(card.style.height).toBe("333px");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(card.style.height).toBe("");
    expect(card.style.overflow).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

it("stops holding a video card after a second when its metadata never arrives", () => {
  vi.useFakeTimers();

  try {
    renderSlot(
      { component: NodeCard },
      {
        ...cardProps,
        node: moduleNode({ kind: "video", html: null, assetId: "stalled" }),
        measureKey: "revision-1",
      },
      { pluginId: "canvas" },
    );

    const card = document.querySelector<HTMLElement>('[data-node-id="module"]');

    if (!card) throw new Error("Missing video card");
    expect(card.style.height).toBe("333px");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(card.style.height).toBe("");
  } finally {
    vi.useRealTimers();
  }
});
