import { expect, it } from "vitest";
import { StreamSendWindow } from "./stream-send-window.js";

it("opens for acknowledgements, grows on a clean link and backs off when bytes queue", () => {
  const window = new StreamSendWindow();
  const frameBytes = 64 * 1024;
  const initial = window.window;

  for (let index = 0; index < 4; index += 1) window.recordWrite(frameBytes, 0);
  expect(window.open).toBe(false);
  expect(window.acknowledge(frameBytes + 1, 20)).toBe(false);
  expect(window.open).toBe(false);
  expect(window.acknowledge(frameBytes, 20)).toBe(true);
  const grown = window.window;
  expect(grown).toBeGreaterThan(initial);
  expect(window.open).toBe(true);

  window.recordWrite(frameBytes, 30);
  expect(window.acknowledge(frameBytes, 100)).toBe(true);
  expect(window.window).toBeLessThan(grown);
  window.reset();
  expect(window.open).toBe(true);
  expect(window.acknowledge(frameBytes, 110)).toBe(false);
});
