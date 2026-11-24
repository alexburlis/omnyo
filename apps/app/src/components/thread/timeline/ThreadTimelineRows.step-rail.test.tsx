// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

function renderRows(rows: TimelineRow[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={rows}
          threadRuntimeDisplayStatus="active"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function message(id: string, seq: number, text: string): TimelineRow {
  return conversationRow({ id, role: "assistant", text, sourceSeqStart: seq });
}

function command(
  id: string,
  seq: number,
  output: string,
  status: "completed" | "error" = "completed",
): TimelineRow {
  return commandRow({
    id,
    command: `run ${id}`,
    output,
    status,
    exitCode: status === "error" ? 1 : 0,
    sourceSeqStart: seq,
  });
}

afterEach(cleanup);

describe("timeline step rail", () => {
  const rows = [
    conversationRow({ id: "ask", role: "user", text: "Go", sourceSeqStart: 1 }),
    message("plan", 2, "Updating the policy."),
    command("set-a", 3, "output of set-a"),
    command("set-b", 4, "output of set-b"),
    message("verify", 5, "Saved. Verifying it stuck."),
    command("check", 6, "output of check", "error"),
    message("done", 7, "Checked."),
  ];

  it("hangs each message's work beneath it as a meta line on the rail", () => {
    const { container } = renderRows(rows);

    const steps = [...container.querySelectorAll("[data-timeline-step]")].map(
      (element) => element.getAttribute("data-timeline-step"),
    );

    expect(steps).toEqual(["head", "work", "head", "work", "head"]);

    for (const work of container.querySelectorAll(
      '[data-timeline-step="work"]',
    )) {
      expect(work.querySelector("[data-timeline-row-glyph]")).toBeNull();
      expect(
        work.querySelector("button[aria-expanded] [data-timeline-row-figure]"),
      ).not.toBeNull();
    }

    const heads = container.querySelectorAll('[data-timeline-step="head"]');
    expect(heads[0]?.className).toContain("after:bg-subtle-foreground");
    expect(heads[1]?.className).toContain("after:bg-destructive-text");
  });

  it("opens every work line on click", async () => {
    const { container } = renderRows(rows);

    const headers = [
      ...container.querySelectorAll(
        '[data-timeline-step="work"] button[aria-expanded]',
      ),
    ];

    expect(headers).toHaveLength(2);

    for (const header of headers) {
      if (header.getAttribute("aria-expanded") === "false") {
        fireEvent.click(header);
      }

      expect(header.getAttribute("aria-expanded")).toBe("true");
    }

    await waitFor(() =>
      expect(container.textContent).toContain("output of check"),
    );
  });
});
