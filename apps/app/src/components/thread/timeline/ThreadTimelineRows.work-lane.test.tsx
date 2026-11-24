// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  buildTimelineRowTitle,
  buildTimelineViewRows,
} from "@omnyo/thread-view";
import {
  commandRow,
  conversationRow,
  fileChangeRow,
  toolRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

function rowsView(
  rows: TimelineRow[],
  status: ThreadRuntimeDisplayStatus = "idle",
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={rows}
          threadRuntimeDisplayStatus={status}
          workspaceRootPath={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderRows(
  rows: TimelineRow[],
  status: ThreadRuntimeDisplayStatus = "idle",
) {
  return render(rowsView(rows, status));
}

afterEach(cleanup);

describe("timeline ledger summaries", () => {
  it("reads folded work as one sentence with a plain failure note", () => {
    const rows = [
      commandRow({
        id: "test",
        command: "pnpm test",
        status: "error",
        exitCode: 1,
        sourceSeqStart: 1,
      }),
      fileChangeRow({ id: "file", sourceSeqStart: 2 }),
      commandRow({ id: "ship", command: "git push", sourceSeqStart: 3 }),
      conversationRow({
        id: "answer",
        role: "assistant",
        text: "Done",
        sourceSeqStart: 4,
      }),
    ];

    const summary = buildTimelineViewRows(rows)[0];

    if (summary === undefined) throw new Error("expected a summary");

    const title = buildTimelineRowTitle(summary, {
      summaryStyle: "background",
      workStyle: "default",
    });

    const { container } = renderRows(rows);
    const sentence = title.plain.replace(/ \(.*\)$/u, "");
    const button = screen.getByRole("button", { name: new RegExp(sentence) });

    expect(container.querySelector("[data-timeline-work-lane]")).toBeNull();
    expect(button.textContent).toContain(sentence);

    const note = button.querySelector("[data-timeline-work-summary-note]");

    expect(note?.textContent).toBe("1 failed");
    expect(note?.className).toContain("text-destructive-text");
    expect(note?.className).not.toMatch(/(?:^| )(?:border|bg-)/u);
    expect(
      button
        .querySelector("[data-timeline-row-glyph]")
        ?.getAttribute("data-timeline-row-glyph"),
    ).toBe("failed");
    expect(button.closest(".opacity-40")).toBeNull();
  });

  it("puts the summed step duration in the figure column", () => {
    const rows = [
      commandRow({ id: "test-1", command: "pnpm test", sourceSeqStart: 1 }),
      commandRow({ id: "test-2", command: "pnpm lint", sourceSeqStart: 2 }),
    ];

    const { container } = renderRows(rows, "active");

    const figure = container.querySelector(
      '[data-timeline-row-kind$="summary"] [data-timeline-row-figure]',
    );

    expect(figure?.textContent).toBe("4.6s");
  });
});

describe("timeline ledger rows", () => {
  it("shows a command's duration, plain test result and no chip or activity border", () => {
    const { container } = renderRows([
      commandRow({
        id: "tests",
        command: "pnpm test",
        output: " Tests  6 passed (6)",
        exitCode: 0,
        durationMs: 450,
      }),
    ]);

    const row = container.querySelector('[data-timeline-row-id="tests"]');
    const result = row?.querySelector("[data-timeline-work-result]");

    expect(result?.textContent).toBe("6 passed");
    expect(result?.className).not.toMatch(/(?:^| )(?:border|bg-)/u);
    expect(row?.querySelector("[data-timeline-row-figure]")?.textContent).toBe(
      "0.5s",
    );
    expect(row?.querySelector(".border-l-2")).toBeNull();
    expect(screen.getByText("pnpm test").className).toContain("font-mono");
  });

  it("keeps a failed command open until the owner collapses it", () => {
    const { container } = renderRows([
      commandRow({
        id: "broken",
        command: "pnpm build",
        output: "boom",
        status: "error",
        exitCode: 2,
      }),
    ]);

    const header = container.querySelector<HTMLButtonElement>(
      '[data-timeline-row-id="broken"] button[aria-expanded]',
    );

    if (header === null) throw new Error("expected the command header");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toContain("exit 2");

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("runs a rail through consecutive work rows and stops at the reply", async () => {
    const { container } = renderRows([
      commandRow({ id: "one", command: "echo one", sourceSeqStart: 1 }),
      fileChangeRow({ id: "two", sourceSeqStart: 2 }),
      commandRow({ id: "three", command: "echo three", sourceSeqStart: 3 }),
      conversationRow({
        id: "reply",
        role: "assistant",
        text: "Done",
        sourceSeqStart: 4,
      }),
    ]);

    const summary = container.querySelector<HTMLButtonElement>(
      '[data-timeline-row-kind$="summary"] button[aria-expanded]',
    );

    if (summary === null) throw new Error("expected the work summary");
    fireEvent.click(summary);

    const rail = (id: string) =>
      container
        .querySelector(`[data-timeline-row-id="${id}"]`)
        ?.getAttribute("data-timeline-rail") ?? null;

    await waitFor(() => expect(rail("one")).toBe("first"));
    expect([rail("two"), rail("three"), rail("reply")]).toEqual([
      "middle",
      "last",
      null,
    ]);
  });
});

describe("live work details", () => {
  it.each([
    commandRow({
      id: "live-work",
      command: "pnpm test",
      status: "pending",
      output: "First streaming result",
      sourceSeqStart: 2,
    }),
    toolRow({
      id: "live-work",
      toolName: "test_runner",
      status: "pending",
      output: "First streaming result",
      sourceSeqStart: 2,
    }),
  ])(
    "shows live $workKind output and folds it before the turn finishes",
    async (liveRow) => {
      const previousWork = commandRow({
        id: "previous-work",
        command: "pnpm lint",
        sourceSeqStart: 1,
      });

      const rows = [previousWork, liveRow];

      const view = renderRows(rows, "active");

      await waitFor(() =>
        expect(screen.getByText("First streaming result")).toBeTruthy(),
      );

      const reply = conversationRow({
        id: "draft-answer",
        role: "assistant",
        text: "Here is the result",
        sourceSeqStart: 3,
      });

      if (reply.role !== "assistant")
        throw new Error("Expected an assistant reply");

      const completedRows: TimelineRow[] = [
        previousWork,
        { ...liveRow, status: "completed", output: "Final tool result" },
      ];

      view.rerender(rowsView(completedRows, "active"));
      expect(
        view.container.querySelector(
          '[data-timeline-row-id="live-work"] button[aria-expanded="true"]',
        ),
      ).toBeNull();

      view.rerender(
        rowsView(
          [
            ...completedRows,
            {
              ...reply,
              status: "streaming",
            },
          ],
          "active",
        ),
      );
      expect(
        view.container.querySelector('[data-timeline-row-id="draft-answer"]')
          ?.textContent,
      ).toContain("Here is the result");

      const summary = view.container.querySelector(
        '[data-timeline-row-kind$="summary"] button[aria-expanded]',
      );

      if (!summary) throw new Error("Expected an expandable work summary");
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("true");

      view.rerender(
        rowsView([
          turnRow({ id: "finished-work", children: rows, status: "completed" }),
          conversationRow({
            id: "final-answer",
            role: "assistant",
            text: "The final answer",
            sourceSeqStart: 5,
          }),
        ]),
      );
      expect(
        screen
          .getByRole("button", { name: /^Worked/u })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      expect(screen.queryByText("Final tool result")).toBeNull();
      expect(screen.getByText("The final answer")).toBeTruthy();
    },
  );
});
