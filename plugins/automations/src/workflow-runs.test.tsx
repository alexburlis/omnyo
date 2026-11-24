// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import { WorkflowDraftReader } from "../workflow-draft-reader.js";
import { WorkflowRunHistory } from "../workflow-run-history.js";
import {
  parseWorkflowRunResult,
  readWorkflowWeek,
} from "../lib/workflow-week.js";
import type { AutomationRunResponse } from "./rpc-types.js";
import { FIXTURE_FILES } from "./workflow-week-fixture.js";

installTestPluginRuntime();

afterEach(cleanup);

function run(overrides: Partial<AutomationRunResponse>): AutomationRunResponse {
  return {
    id: "run_1",
    automationId: "auto_1",
    runMode: "workflow",
    threadId: null,
    status: "succeeded",
    trigger: "manual",
    skipReason: null,
    error: null,
    output: null,
    exitCode: null,
    scheduledFor: Date.UTC(2026, 10, 22, 9),
    startedAt: Date.UTC(2026, 10, 22, 9),
    finishedAt: null,
    ...overrides,
  };
}

describe("readWorkflowWeek", () => {
  it("orders drafts by their calendar date, not file order", () => {
    const shuffled = [...FIXTURE_FILES].reverse();
    const week = readWorkflowWeek(shuffled);

    expect(week.drafts.map((draft) => draft.date)).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
    ]);
    expect(week.drafts[0].title).toBe("Your seed list, ready before the swap");
    expect(week.drafts[0].body.startsWith("#")).toBe(false);
    expect(week.timezone).toBe("Europe/Berlin");
    expect(week.calendarProblem).toBeNull();
  });

  it("reports an unreadable calendar instead of inventing dates", () => {
    const files = FIXTURE_FILES.map((file) =>
      file.name === "calendar.json" ? { ...file, content: "{" } : file,
    );

    const week = readWorkflowWeek(files);

    expect(week.calendarProblem).toBe("calendar.json is not valid JSON.");
    expect(week.drafts.every((draft) => draft.date === null)).toBe(true);
  });

  it("treats non-JSON run output as unreadable rather than throwing", () => {
    expect(parseWorkflowRunResult("not json")).toBeNull();
    expect(parseWorkflowRunResult('{"contentStatus":"complete"}')).toEqual({
      contentStatus: "complete",
    });
  });
});

describe("WorkflowDraftReader", () => {
  it("shows retrieved keyword research only on its associated draft", () => {
    const retrievedAt = "2026-11-21T10:00:00Z";

    const files = [
      { name: "candidate-1.md", content: "# Seed List" },
      { name: "candidate-2.md", content: "# Swap Table" },
      {
        name: "reviews.json",
        content: JSON.stringify([
          {
            candidateId: "candidate-1",
            draftDigest: "a".repeat(64),
            outcome: "accepted",
            reason: "",
            research: {
              kind: "openseo",
              keyword: "seed swap calendar",
              site: "example.com",
              retrievedAt,
            },
          },
          {
            candidateId: "candidate-2",
            outcome: "accepted",
            reason: "Matches the supplied brief.",
          },
        ]),
      },
    ];

    render(
      <WorkflowDraftReader
        drafts={readWorkflowWeek(files).drafts}
        heading="Your week is ready"
        subject="Weekly Content Feed"
        timezone={null}
        calendarProblem={null}
        onDownload={() => {}}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "Draft research" }).textContent,
    ).toContain("example.com · Retrieved into Omnyo 2026-11-21 UTC");
    expect(screen.getByText("seed swap calendar")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(
      screen.queryByRole("complementary", { name: "Draft research" }),
    ).toBeNull();
    expect(screen.getByText("Matches the supplied brief.")).toBeTruthy();
  });

  it("labels days with real weekdays and moves between them by keyboard", () => {
    const week = readWorkflowWeek(FIXTURE_FILES);

    render(
      <WorkflowDraftReader
        drafts={week.drafts}
        heading="Your week is ready"
        subject="Weekly Content Feed · Mosslight Workshop"
        timezone={week.timezone}
        calendarProblem={null}
        onDownload={() => {}}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(7);
    expect(tabs[0].getAttribute("aria-label")).toMatch(/^Monday, November 23/);
    expect(tabs[6].getAttribute("aria-label")).toMatch(/^Sunday, November 29/);

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("heading", {
        name: "Plan the date, then plan the table",
      }),
    ).toBeTruthy();

    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[6]);
    expect(
      screen
        .getByRole("button", { name: "Next draft" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.keyDown(tabs[6], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("downloads the selected draft", () => {
    const onDownload = vi.fn();
    const week = readWorkflowWeek(FIXTURE_FILES);

    render(
      <WorkflowDraftReader
        drafts={week.drafts}
        heading="Your week is ready"
        subject="Weekly Content Feed"
        timezone={null}
        calendarProblem={null}
        onDownload={onDownload}
      />,
    );

    fireEvent.click(screen.getAllByRole("tab")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith(week.drafts[2]);
  });
});

describe("inert draft rendering", () => {
  const HOSTILE = [
    "# Launch notes",
    "",
    'Intro <img src="https://tracker.example/pixel.png" onerror="alert(1)"> text.',
    "",
    "![tracking pixel](https://tracker.example/remote.png)",
    "",
    "- See [our site](https://tracker.example/page) for **details**",
    "",
    '<iframe src="https://tracker.example/frame"></iframe><script>alert(2)</script>',
  ].join("\n");

  it("renders HTML, images and links as text without remote elements", async () => {
    const week = readWorkflowWeek([{ name: "cand_x.md", content: HOSTILE }]);

    const { container, experimental_clipboardWrites } = renderSlot(
      { component: WorkflowDraftReader },
      {
        drafts: week.drafts,
        heading: "Your reviewed drafts",
        subject: "Weekly Content Feed",
        timezone: null,
        calendarProblem: null,
        onDownload: () => {},
      },
    );

    const body = container.querySelector("[data-inert-draft]") as HTMLElement;

    expect(
      container.querySelectorAll(
        "img, a, iframe, script, source, video, audio, object, embed",
      ),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll("[src], [href], [srcset], [style]"),
    ).toHaveLength(0);
    expect(body.textContent).toContain(
      '<img src="https://tracker.example/pixel.png" onerror="alert(1)">',
    );
    expect(body.textContent).toContain("<script>alert(2)</script>");
    expect(body.textContent).toContain("tracking pixel");
    expect(body.textContent).toContain("See our site for details");
    expect(body.textContent).not.toContain(
      "https://tracker.example/remote.png",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    });
    expect(experimental_clipboardWrites).toEqual([{ text: HOSTILE }]);
  });
});

describe("WorkflowRunHistory", () => {
  it("explains a partial week and offers artifacts only for complete runs", () => {
    render(
      <WorkflowRunHistory
        hasAutomation
        showingRunId={null}
        loadingRunId={null}
        onLoad={() => {}}
        onRefresh={() => {}}
        runs={[
          run({
            id: "run_partial",
            output: JSON.stringify({
              contentStatus: "partial",
              contentError: "Candidate budget exhausted: 5/7 drafts accepted",
            }),
          }),
          run({
            id: "run_complete",
            output: JSON.stringify({ contentStatus: "complete" }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("This week is incomplete")).toBeTruthy();
    expect(
      screen.getByText(/has used its candidate limit for the week/),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open drafts" })).toHaveLength(
      1,
    );
  });

  it("shows an empty state before the first run", () => {
    render(
      <WorkflowRunHistory
        hasAutomation={false}
        runs={undefined}
        showingRunId={null}
        loadingRunId={null}
        onLoad={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText(/No runs yet/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Refresh runs" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
