import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticHtml } from "../components/semantic";
import { nextSemanticDetail, showsTitleTile } from "../lib/semantic";

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

const props = {
  html: "<p>Full evidence</p>",
  title: "Discovery",
  views: {
    overview: "<p>Discovery grew</p>",
    evidence: "<p>4,899 clicks</p>",
    sources: "<p>Search Console · Oct 3–30</p>",
  },
  zoom: 0.8,
  compact: false,
  canvasNavigation: true,
};

function view(container: HTMLElement, name: string) {
  const element = container.querySelector<HTMLElement>(`[data-view="${name}"]`);

  if (element === null) throw new Error(`Missing ${name} view`);

  return element;
}

describe("authored semantic views", () => {
  it("holds the current detail through zoom threshold noise", () => {
    expect(nextSemanticDetail("evidence", 0.3)).toBe("evidence");
    expect(nextSemanticDetail("evidence", 0.16)).toBe("evidence");
    expect(nextSemanticDetail("evidence", 0.15)).toBe("overview");
    expect(nextSemanticDetail("overview", 0.17)).toBe("overview");
    expect(nextSemanticDetail("overview", 0.18)).toBe("evidence");
    expect(nextSemanticDetail("evidence", 1.15)).toBe("sources");
    expect(nextSemanticDetail("sources", 1.1)).toBe("sources");
    expect(nextSemanticDetail("sources", 1.05)).toBe("evidence");
    expect(nextSemanticDetail("overview", 1.3)).toBe("sources");
    expect(nextSemanticDetail("sources", 0.15)).toBe("overview");
    expect(nextSemanticDetail("overview", 0.12)).toBe("map");
    expect(nextSemanticDetail("map", 0.13)).toBe("map");
    expect(nextSemanticDetail("map", 0.14)).toBe("overview");
    expect(nextSemanticDetail("evidence", 0.1)).toBe("map");
  });

  it("shows title tiles once modules are too small to read", () => {
    expect(showsTitleTile("map", true)).toBe(true);
    expect(showsTitleTile("overview", false)).toBe(true);
    expect(showsTitleTile("overview", true)).toBe(false);
    expect(showsTitleTile("evidence", false)).toBe(false);
  });

  it("mounts every authored view up front so zoom never changes the reserved footprint", () => {
    const { container, rerender } = render(<SemanticHtml {...props} />);
    const evidence = screen.getByTitle("Discovery");
    const overview = screen.getByTitle("Discovery · Overview");
    const sources = screen.getByTitle("Discovery · Sources");
    expect(container.querySelectorAll("iframe")).toHaveLength(3);
    expect(view(container, "overview").getAttribute("aria-hidden")).toBe("true");
    expect(view(container, "sources").hasAttribute("inert")).toBe(true);
    rerender(<SemanticHtml {...props} zoom={0.15} />);
    expect(view(container, "overview").getAttribute("data-active")).toBe("true");
    expect(screen.getByTitle("Discovery")).toBe(evidence);
    rerender(<SemanticHtml {...props} zoom={1.3} />);
    expect(view(container, "sources").getAttribute("data-active")).toBe("true");
    rerender(<SemanticHtml {...props} zoom={0.15} />);
    expect(screen.getByTitle("Discovery")).toBe(evidence);
    expect(screen.getByTitle("Discovery · Overview")).toBe(overview);
    expect(screen.getByTitle("Discovery · Sources")).toBe(sources);
  });

  it("exposes evidence and sources during compact reading", () => {
    const { container } = render(<SemanticHtml {...props} zoom={0.15} compact />);

    expect(view(container, "overview").hasAttribute("inert")).toBe(true);
    expect(view(container, "evidence").getAttribute("data-active")).toBe("true");
    expect(view(container, "sources").getAttribute("data-active")).toBe("true");
    expect(
      Array.from(container.querySelectorAll("iframe")).every(
        (frame) => !frame.srcdoc.includes("canvasFrameWheel"),
      ),
    ).toBe(true);
  });

  it("retains ordinary evidence when alternate views were not authored", () => {
    const { container, rerender } = render(
      <SemanticHtml {...props} views={undefined} zoom={0.15} />,
    );

    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")?.srcdoc).toContain("Full evidence");
    rerender(<SemanticHtml {...props} views={{ sources: "<p>Source</p>" }} zoom={0.15} />);
    expect(view(container, "evidence").getAttribute("data-active")).toBe("true");
    expect(view(container, "sources").getAttribute("data-active")).toBe("false");
  });
});
