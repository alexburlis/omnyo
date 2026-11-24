import { describe, expect, it } from "vitest";
import { experimental_threadIndicatorCases } from "../testing/thread-indicator-cases.js";
import { experimental_threadIndicators } from "../app.js";

describe("shared SDK indicator contract", () => {
  it.each(experimental_threadIndicatorCases)("$name", ({ state, expected }) => {
    expect(experimental_threadIndicators.resolve(state)).toBe(expected);
  });
});
