// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  finishTypeAhead,
  startTypeAheadCapture,
  stopTypeAheadCapture,
  takeTypeAhead,
} from "./typed-ahead";

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });

  document.body.dispatchEvent(event);

  return event;
}

afterEach(() => {
  stopTypeAheadCapture();
  takeTypeAhead();
  document.body.innerHTML = "";
});

describe("type-ahead capture", () => {
  it("keeps printable keys typed while nothing is focused, with backspace", () => {
    startTypeAheadCapture();

    for (const key of ["o", "k", "x", "Backspace", "?"]) press(key);

    expect(takeTypeAhead()).toBe("ok?");
    expect(takeTypeAhead()).toBe("");
  });

  it("leaves shortcuts and keys aimed at a focused element alone", () => {
    startTypeAheadCapture();
    const input = document.createElement("input");
    document.body.append(input);

    expect(press("n", { metaKey: true }).defaultPrevented).toBe(false);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(takeTypeAhead()).toBe("");
  });

  it("stops capturing once the live composer has taken the text", () => {
    startTypeAheadCapture();
    press("a");

    expect(finishTypeAhead()).toBe("a");
    expect(press("b").defaultPrevented).toBe(false);
    expect(takeTypeAhead()).toBe("");
  });
});
