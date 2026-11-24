import { describe, expect, it } from "vitest";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { historyRowSpacerHeight } from "./useHistoryRowWindow";

describe("deep history prepend", () => {
  const row = conversationRow({
    id: "message",
    role: "user",
    seq: 15,
    text: "An older message",
  });

  it("keeps both reading edges ready while reserving space for an unseen page interior", () => {
    const unseen = new Map<string, number | null>();
    expect(historyRowSpacerHeight(row, 0, 37, unseen)).toBeNull();
    expect(historyRowSpacerHeight(row, 15, 37, unseen)).toBeGreaterThan(0);
    expect(historyRowSpacerHeight(row, 36, 37, unseen)).toBeNull();
    expect(historyRowSpacerHeight(row, 37, 37, unseen)).toBeNull();
  });

  it("restores visible rows, keeps measured heights offscreen and mounts live appends immediately", () => {
    expect(historyRowSpacerHeight(row, 15, 0, new Map([[row.id, 187]]))).toBe(
      187,
    );
    expect(
      historyRowSpacerHeight(row, 15, 0, new Map([[row.id, null]])),
    ).toBeNull();
    expect(historyRowSpacerHeight(row, 85, 0, new Map())).toBeNull();
  });
});
