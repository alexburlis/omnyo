// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  buildStickyUserMessageIndex,
  findRowCrossingTop,
} from "./StickyUserMessage";

function rowElement(id: string, top: number, bottom: number): HTMLElement {
  const element = document.createElement("div");
  element.dataset.timelineRowId = id;
  element.getBoundingClientRect = () => new DOMRect(0, top, 100, bottom - top);

  return element;
}

describe("buildStickyUserMessageIndex", () => {
  it("pins the latest user message above each response row until the next user message", () => {
    const index = buildStickyUserMessageIndex([
      conversationRow({ id: "u1", role: "user", text: "first\n  question" }),
      conversationRow({ id: "a1", text: "answer one" }),
      commandRow({ id: "c1", command: "ls" }),
      conversationRow({ id: "u2", role: "user", text: "second" }),
      conversationRow({ id: "a2", text: "answer two" }),
    ]);

    expect(index.get("u1")).toBeNull();
    expect(index.get("a1")).toEqual({ id: "u1", label: "first question" });
    expect(index.get("c1")).toEqual({ id: "u1", label: "first question" });
    expect(index.get("u2")).toBeNull();
    expect(index.get("a2")).toEqual({ id: "u2", label: "second" });
  });

  it("shows nothing before the first user message", () => {
    const index = buildStickyUserMessageIndex([
      conversationRow({ id: "a0", text: "greeting" }),
    ]);

    expect(index.get("a0")).toBeNull();
  });

  it("keeps the human prompt pinned across generated inputs", () => {
    const generatedRows = [
      conversationRow({
        id: "script",
        role: "user",
        text: "Result ready",
        systemMessageKind: "external-message",
        systemMessageSubject: {
          kind: "message-source",
          source: { kind: "script", label: "Nightly check" },
        },
      }),
      conversationRow({
        id: "agent",
        role: "user",
        initiator: "agent",
        text: "Agent result",
      }),
      conversationRow({
        id: "system",
        role: "user",
        initiator: "system",
        text: "System result",
      }),
      conversationRow({
        id: "envelope",
        role: "user",
        text: "[Omnyo message from thread:thr_source] Result ready",
      }),
      conversationRow({
        id: "automation",
        role: "user",
        text: "[bb automation due:auto_nightly] Check again",
      }),
    ];

    const index = buildStickyUserMessageIndex([
      conversationRow({ id: "human", role: "user", text: "My question" }),
      ...generatedRows,
      conversationRow({ id: "reply", text: "Result" }),
    ]);

    for (const row of [...generatedRows, { id: "reply" }]) {
      expect(index.get(row.id)).toEqual({ id: "human", label: "My question" });
    }
  });
});

describe("findRowCrossingTop", () => {
  const rows = [
    rowElement("u1", -300, -200),
    rowElement("a1", -192, 40),
    rowElement("u2", 48, 100),
  ];

  it("returns the first row still visible below the viewport top", () => {
    expect(findRowCrossingTop(rows, 0)).toBe("a1");
    expect(findRowCrossingTop(rows, 44)).toBe("u2");
    expect(findRowCrossingTop(rows, -250)).toBe("u1");
  });

  it("returns null when every row is above the viewport", () => {
    expect(findRowCrossingTop(rows, 200)).toBeNull();
  });
});
