import { describe, expect, it } from "vitest";
import { placeChatNotices } from "./chat-notice-placement.js";

const shell = { left: 260, top: 0, width: 1600, height: 900 };

function column(left: number) {
  return { left, top: 48, width: 760, height: 852 };
}

describe("placeChatNotices", () => {
  it("docks two persistent cards beside the sidebar when the gap left of the column fits a card", () => {
    expect(
      placeChatNotices({
        shell,
        column: column(680),
        viewportTop: 48,
        cardWidth: 312,
        compact: false,
      }),
    ).toEqual({ mode: "docked", left: 280, top: 60, width: 312, visible: 2 });
  });

  it("needs the card width plus a 20 px gutter on each side to dock", () => {
    const place = (left: number) =>
      placeChatNotices({
        shell,
        column: column(left),
        viewportTop: 48,
        cardWidth: 312,
        compact: false,
      }).mode;

    expect(place(260 + 352)).toBe("docked");
    expect(place(260 + 351)).toBe("overlay");
  });

  it("overlays one card when it would cover the column", () => {
    expect(
      placeChatNotices({
        shell,
        column: column(460),
        viewportTop: 48,
        cardWidth: 312,
        compact: false,
      }),
    ).toEqual({ mode: "overlay", left: 276, top: 60, width: 312, visible: 1 });
  });

  it("overlays one card below the top of the content shell when no column is on screen", () => {
    expect(
      placeChatNotices({
        shell,
        column: null,
        viewportTop: null,
        cardWidth: 312,
        compact: false,
      }),
    ).toEqual({ mode: "overlay", left: 276, top: 12, width: 312, visible: 1 });
  });

  it("centres one overlay card on compact screens even when the column leaves room", () => {
    expect(
      placeChatNotices({
        shell: { left: 0, top: 0, width: 390, height: 844 },
        column: { left: 360, top: 56, width: 30, height: 788 },
        viewportTop: 56,
        cardWidth: 312,
        compact: true,
      }),
    ).toEqual({ mode: "overlay", left: 39, top: 68, width: 312, visible: 1 });
  });

  it("narrows a compact card to the screen less its insets", () => {
    expect(
      placeChatNotices({
        shell: { left: 0, top: 0, width: 300, height: 640 },
        column: null,
        viewportTop: 56,
        cardWidth: 312,
        compact: true,
      }),
    ).toEqual({ mode: "overlay", left: 12, top: 68, width: 276, visible: 1 });
  });
});
