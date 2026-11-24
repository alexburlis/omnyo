import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import { areThreadRowPropsEqual, type ThreadRowOptions } from "./ThreadRow.js";

const thread = makeSidebarThread({ id: "thr_row" });

const child = makeSidebarThread({ id: "thr_child", parentThreadId: "thr_row" });

const consumeClickSuppression = () => false;

function parentOptions(): Extract<ThreadRowOptions, { kind: "parent" }> {
  return {
    kind: "parent",
    depth: 0,
    isChild: false,
    isCompact: false,
    consumeClickSuppression,
    childCount: 1,
    childActivity: getCollapsedChildActivity([child]),
  };
}

function props(options: ThreadRowOptions) {
  return { thread, crossProjectId: null, isActive: false, options };
}

describe("ThreadRow memoization", () => {
  it("skips a re-render when the list rebuilds equal row options", () => {
    expect(
      areThreadRowPropsEqual(props(parentOptions()), props(parentOptions())),
    ).toBe(true);
  });

  it("re-renders when the row's own data changes", () => {
    const options = parentOptions();

    expect(
      areThreadRowPropsEqual(props(options), {
        ...props(options),
        thread: { ...thread },
      }),
    ).toBe(false);
    expect(
      areThreadRowPropsEqual(props(options), props({ ...options, depth: 1 })),
    ).toBe(false);
    expect(
      areThreadRowPropsEqual(
        props(options),
        props({
          ...options,
          childActivity: getCollapsedChildActivity([{ ...child }, child]),
        }),
      ),
    ).toBe(false);
  });
});
