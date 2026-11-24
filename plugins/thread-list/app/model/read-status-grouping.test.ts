import { describe, expect, it } from "vitest";
import {
  makeSidebarThread,
  makeSidebarWork,
  type SidebarThreadOverrides,
} from "./fixtures.js";
import {
  buildSectionThreadList,
  compareStandardThreads,
  type ThreadComparator,
} from "./project-thread-groups.js";
import {
  createThreadUnreadPredicate,
  groupComparatorByReadStatus,
} from "./read-status-grouping.js";

const read = { lastReadAt: 10_000 };

function thread(id: string, overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    id,
    title: id,
    latestAttentionAt: 5,
    ...overrides,
  });
}

describe("createThreadUnreadPredicate", () => {
  it.each([false, true])(
    "keeps working chats out of unread grouping with a held unread state=%s",
    (held) => {
      const isUnread = createThreadUnreadPredicate(
        held ? { threadId: "working", isUnread: true } : null,
      );

      const working = thread("working", {
        isUnread: true,
        experimental_work: makeSidebarWork("working"),
      });

      expect(isUnread(working)).toBe(false);
      expect(
        isUnread({ ...working, experimental_work: makeSidebarWork("open") }),
      ).toBe(true);
    },
  );

  it("counts only threads that show an unread dot", () => {
    const isUnread = createThreadUnreadPredicate(null);

    expect(isUnread(thread("root"))).toBe(true);
    expect(isUnread(thread("error", { status: "error" }))).toBe(true);
    expect(isUnread(thread("read", read))).toBe(false);
    expect(isUnread(thread("child", { parentThreadId: "root" }))).toBe(true);
    expect(isUnread(thread("running", { status: "active" }))).toBe(true);
  });
});

describe("groupComparatorByReadStatus", () => {
  it("lists unread threads first and keeps the base order in each group", () => {
    const threads = [
      thread("read-new", { latestAttentionAt: 400, ...read }),
      thread("unread-new", { latestAttentionAt: 300 }),
      thread("read-old", { latestAttentionAt: 200, ...read }),
      thread("unread-old", { latestAttentionAt: 100 }),
    ];

    const compare = groupComparatorByReadStatus(
      compareStandardThreads,
      createThreadUnreadPredicate(null),
    );

    expect(threads.sort(compare).map(({ id }) => id)).toEqual([
      "unread-new",
      "unread-old",
      "read-new",
      "read-old",
    ]);
  });

  it("applies read status before an item comparator", () => {
    const byTitleDescending = ((left, right) =>
      right.displayTitle.localeCompare(left.displayTitle)) as ThreadComparator;

    byTitleDescending.compareItems = (left, right) =>
      left.kind === "thread" && right.kind === "thread"
        ? byTitleDescending(left.node.thread, right.node.thread)
        : 0;

    const items = buildSectionThreadList(
      [thread("alpha"), thread("zulu", read)],
      groupComparatorByReadStatus(
        byTitleDescending,
        createThreadUnreadPredicate(null),
      ),
    );

    expect(
      items.map((item) => (item.kind === "thread" ? item.node.thread.id : "")),
    ).toEqual(["alpha", "zulu"]);
  });
});
