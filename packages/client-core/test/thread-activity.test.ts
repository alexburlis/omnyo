import { experimental_threadIndicatorCases } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import {
  getCollapsedChildActivity,
  isUnreadThread,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "../src/thread/thread-activity.js";

const working =
  experimental_threadIndicatorCases.find(
    (entry) => entry.state.work?.primary.label === "working",
  )?.state.work ?? null;

const needsYou =
  experimental_threadIndicatorCases.find(
    (entry) => entry.state.work?.primary.label === "needs-you",
  )?.state.work ?? null;

describe("thread work adapters", () => {
  it.each(experimental_threadIndicatorCases)("$name", ({ state, expected }) => {
    expect(resolveThreadListIndicator(state)).toBe(expected);
    const thread = makeThreadListEntry({ work: state.work });
    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(thread, state.hasUnsubmittedDraft),
      ),
    ).toBe(expected);
  });
  it("reading changes neither Working nor required attention", () => {
    for (const work of [working, needsYou]) {
      const unread = makeThreadListEntry({
        work,
        lastReadAt: 0,
        latestAttentionAt: 20,
      });

      expect(threadListIndicatorStateForThread(unread, false)).toEqual(
        threadListIndicatorStateForThread(
          makeThreadListEntry({ ...unread, lastReadAt: 20 }),
          false,
        ),
      );
    }
  });
  it("retains concurrent summaries when collapsed and decorates drafts independently", () => {
    const activity = getCollapsedChildActivity(
      [
        makeThreadListEntry({ id: "working", work: working }),
        makeThreadListEntry({ id: "question", work: needsYou }),
      ],
      new Set(["working"]),
    );

    expect(activity.work).toBe(needsYou);
    expect(activity.summaries).toEqual([working, needsYou]);
    expect(activity.hasUnsubmittedDraft).toBe(true);
  });
  it("does not infer work from raw activity when a legacy summary is unavailable", () => {
    const thread = makeThreadListEntry({
      work: null,
      status: "active",
      activity: {
        activeWorkflowCount: 1,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 0,
        activeGoalCount: 0,
        activeSubagentCount: 0,
      },
    });

    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(thread, false),
      ),
    ).toBe("open");
  });
  it("keeps unread decoration independent of work and child ownership", () => {
    const thread = makeThreadListEntry({
      lastReadAt: 10,
      latestAttentionAt: 20,
      work: needsYou,
    });

    expect(isUnreadThread(thread)).toBe(true);
    expect(isUnreadThread({ ...thread, lastReadAt: 20 })).toBe(false);
    expect(isUnreadThread({ ...thread, parentThreadId: "parent" })).toBe(true);
    expect(isUnreadThread({ ...thread, status: "active" })).toBe(true);
  });
});
