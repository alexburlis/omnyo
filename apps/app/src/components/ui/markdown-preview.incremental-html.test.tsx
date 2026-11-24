// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

const pipeline = vi.hoisted(() => {
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { held, release, imports: 0 };
});

vi.mock("./markdown-html", async (original) => {
  pipeline.imports += 1;
  await pipeline.held;

  return original();
});

afterEach(cleanup);

it("keeps a message whose '<' is not HTML on incremental pieces", async () => {
  const content = "Use `Array<T>` when a < b.\n\nNext paragraph.";

  const view = render(
    <MarkdownPreview allowHtml incrementalBlocks content={content} />,
  );

  view.rerender(
    <MarkdownPreview
      allowHtml
      incrementalBlocks
      content={`${content}\n\nAnother paragraph.`}
    />,
  );
  await act(async () => {});
  expect(pipeline.imports).toBe(0);
  expect(screen.queryByLabelText("Loading embedded HTML")).toBeNull();
  expect(view.container.querySelector("code")?.textContent).toBe("Array<T>");
  expect(screen.getByText("Another paragraph.")).toBeTruthy();
});

it("keeps real HTML on the sanitized whole-document path", async () => {
  const content = "Press <kbd>Ctrl</kbd> to copy.";

  const view = render(
    <MarkdownPreview allowHtml incrementalBlocks content={content} />,
  );

  view.rerender(
    <MarkdownPreview
      allowHtml
      incrementalBlocks
      content={`${content}\n\nNext paragraph.`}
    />,
  );
  await act(async () => {});
  expect(pipeline.imports).toBe(1);
  await act(async () => pipeline.release());
  await waitFor(() =>
    expect(view.container.querySelector("kbd")?.textContent).toBe("Ctrl"),
  );
  expect(screen.queryByLabelText("Loading embedded HTML")).toBeNull();
});
