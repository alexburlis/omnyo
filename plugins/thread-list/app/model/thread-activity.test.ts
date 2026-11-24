import { experimental_threadIndicatorCases } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { makeSidebarThread, makeSidebarWork } from "./fixtures.js";
import {
  getCollapsedChildActivity,
  resolveThreadListIndicator,
  resolveThreadStatus,
  threadListIndicatorStateForThread,
} from "./thread-activity.js";

describe("shared work summary rendering", () => {
  it.each(["working", "open", "ready-to-archive", "needs-you"] as const)(
    "keeps an optional decision visible for %s work without changing required precedence",
    (label) => {
      const source = makeSidebarWork(label);

      const state = {
        work: {
          ...source,
          optionalInput: [
            {
              id: "decision",
              kind: "question" as const,
              label: "Choose a home",
            },
          ],
        },
        hasUnsubmittedDraft: true,
      };

      expect(resolveThreadListIndicator(state)).toBe(
        label === "needs-you" ? "waiting-for-input" : "input-welcome",
      );
      expect(state.work.primary).toBe(source.primary);
      expect(
        resolveThreadListIndicator({
          ...state,
          work: { ...state.work, optionalInput: [] },
        }),
      ).toBe(
        label === "working"
          ? "working-draft"
          : label === "needs-you"
            ? "waiting-for-input"
            : "draft",
      );
    },
  );
  it("retains an optional decision beside another collapsed child's running work", () => {
    const running = makeSidebarWork("working");

    const optionalInput = [
      { id: "decision", kind: "question" as const, label: "Choose a home" },
    ];

    const decision = { ...makeSidebarWork("open"), optionalInput };

    const activity = getCollapsedChildActivity([
      makeSidebarThread({ id: "running", experimental_work: running }),
      makeSidebarThread({ id: "decision", experimental_work: decision }),
    ]);

    expect(activity.work?.primary).toEqual(running.primary);
    expect(activity.work?.optionalInput).toEqual(optionalInput);
    expect(activity.work?.activity).toEqual(running.activity);
    expect(
      resolveThreadStatus(
        { work: activity.work, hasUnsubmittedDraft: false },
        null,
      ),
    ).toMatchObject({
      indicatorKind: "input-welcome",
      accessibleLabel: "Open decision; work is running",
    });
  });
  it("does not turn an unknown family member into Ready from a completed sibling", () => {
    const ready =
      experimental_threadIndicatorCases.find(
        (entry) => entry.state.work?.primary.label === "ready-to-archive",
      )?.state.work ?? null;

    const activity = getCollapsedChildActivity([
      makeSidebarThread({ id: "unknown", experimental_work: null }),
      makeSidebarThread({ id: "ready", experimental_work: ready }),
    ]);

    expect(activity.work).toBeNull();
    expect(activity.summaries).toEqual([ready]);
  });
  it.each(experimental_threadIndicatorCases)("$name", ({ state, expected }) => {
    const thread = makeSidebarThread({ experimental_work: state.work });
    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(thread, state.hasUnsubmittedDraft),
      ),
    ).toBe(expected);
  });
  it("retains simultaneous work and required input in collapsed groups", () => {
    const work =
      experimental_threadIndicatorCases.find(
        (entry) => entry.state.work?.primary.label === "needs-you",
      )?.state.work ?? null;

    const activity = getCollapsedChildActivity([
      makeSidebarThread({ id: "one", experimental_work: work }),
    ]);

    expect(activity.work).toBe(work);
    expect(activity.summaries).toEqual([work]);
    expect(activity.work?.activity).toHaveLength(1);
    expect(activity.work?.requiredInput).toHaveLength(1);
  });
  it("shows a static Stopping glyph instead of the spinner while a turn stops", () => {
    const state = {
      work: makeSidebarWork("working"),
      hasUnsubmittedDraft: false,
    };

    expect(resolveThreadStatus(state, null, true)).toEqual({
      accessibleLabel: "Stopping",
      indicatorKind: "none",
      rowStatusIsVisible: true,
      rowStatus: { icon: "Square", label: "Stopping", tone: "default" },
    });
    expect(resolveThreadStatus(state, null).indicatorKind).not.toBe("none");
    expect(
      resolveThreadStatus(
        { work: makeSidebarWork("open"), hasUnsubmittedDraft: false },
        null,
        true,
      ).rowStatusIsVisible,
    ).toBe(false);
  });
  it("never lets a plugin row decoration replace required work status", () => {
    const state = experimental_threadIndicatorCases.find(
      (entry) => entry.state.work?.primary.label === "needs-you",
    )?.state;

    if (state === undefined) throw new Error("Required-input fixture missing");
    expect(
      resolveThreadStatus(state, {
        icon: "Loading",
        label: "Plugin running",
        tone: "running",
      }),
    ).toMatchObject({
      indicatorKind: "waiting-for-input",
      rowStatusIsVisible: false,
    });
  });
});
