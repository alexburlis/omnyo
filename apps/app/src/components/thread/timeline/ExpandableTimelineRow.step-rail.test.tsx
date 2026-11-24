// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TimelineTitle } from "@omnyo/thread-view";
import { afterEach, describe, expect, it } from "vitest";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow";
import { TimelineRowFigure } from "./TimelineRowFigure";
import {
  STEP_HEAD_TIME_ROOM_CLASS_NAME,
  TimelineStepRailContext,
  useTimelineStepRail,
  type TimelineStepRail,
} from "./timeline-step-rail";

const TITLE: TimelineTitle = {
  segments: [
    { text: "Ran 3 commands", em: false, shimmer: false, truncate: false },
  ],
  decorations: [],
  tone: "default",
  action: null,
  plain: "Ran 3 commands",
};

const STEP_WORK: TimelineStepRail = {
  role: "work",
  line: "through",
  followsHead: false,
};

function BodyProbe() {
  return <p>body step role: {useTimelineStepRail()?.role ?? "none"}</p>;
}

function renderRow(step: TimelineStepRail | null) {
  return render(
    <TimelineStepRailContext.Provider value={step}>
      <ExpandableTimelineRow
        title={TITLE}
        titleContent={<span>Ran 3 commands</span>}
        ledger={{
          glyph: <span data-timeline-row-glyph="idle" />,
          figure: (
            <TimelineRowFigure
              timing={{ kind: "settled", durationMs: 20_000 }}
            />
          ),
        }}
        renderBody={() => <BodyProbe />}
      />
    </TimelineStepRailContext.Provider>,
  );
}

afterEach(cleanup);

describe("ExpandableTimelineRow on the step rail", () => {
  it("reads as a meta line that still opens on click", () => {
    const { container } = renderRow(STEP_WORK);
    const header = screen.getByRole("button", { name: /Ran 3 commands/u });

    expect(container.querySelector("[data-timeline-row-glyph]")).toBeNull();
    expect(
      header.querySelector("[data-timeline-row-figure]")?.className,
    ).toContain("before:content-['·_']");
    expect(header.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("body step role: none")).toBeTruthy();
  });

  it("leaves room for the message time only on the first work line", () => {
    renderRow({ ...STEP_WORK, followsHead: true });
    const first = screen.getByRole("button", { name: /Ran 3 commands/u });
    expect(first.className).toContain(STEP_HEAD_TIME_ROOM_CLASS_NAME);
    cleanup();

    renderRow(STEP_WORK);
    const later = screen.getByRole("button", { name: /Ran 3 commands/u });
    expect(later.className).not.toContain(STEP_HEAD_TIME_ROOM_CLASS_NAME);
  });

  it("keeps the ledger glyph and trailing time off the rail", () => {
    const { container } = renderRow(null);

    expect(container.querySelector("[data-timeline-row-glyph]")).not.toBeNull();
    expect(
      container.querySelector("[data-timeline-row-figure]")?.className,
    ).toContain("ml-auto");
  });
});
