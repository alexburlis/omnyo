import { describe, expect, it } from "vitest";
import {
  asideFitsBesideChat,
  resolveThreadCompanionPlacement,
} from "./placement";

describe("resolveThreadCompanionPlacement", () => {
  it.each([
    { compact: true, focused: true, asideFits: true, placement: "inline" },
    { compact: true, focused: false, asideFits: false, placement: "inline" },
    { compact: false, focused: true, asideFits: true, placement: "aside" },
    { compact: false, focused: false, asideFits: true, placement: "aside" },
    { compact: false, focused: true, asideFits: false, placement: "toolbar" },
    { compact: false, focused: false, asideFits: false, placement: null },
  ] as const)(
    "compact=$compact focused=$focused fits=$asideFits -> $placement",
    ({ placement, ...input }) => {
      expect(resolveThreadCompanionPlacement(input)).toBe(placement);
    },
  );
});

describe("asideFitsBesideChat", () => {
  it.each([
    { paneWidth: 1200, previouslyFits: false, fits: false },
    { paneWidth: 1488, previouslyFits: false, fits: false },
    { paneWidth: 1511, previouslyFits: false, fits: false },
    { paneWidth: 1512, previouslyFits: false, fits: true },
    { paneWidth: 2000, previouslyFits: false, fits: true },
    { paneWidth: 1488, previouslyFits: true, fits: true },
    { paneWidth: 1464, previouslyFits: true, fits: true },
    { paneWidth: 1463, previouslyFits: true, fits: false },
    { paneWidth: 1200, previouslyFits: true, fits: false },
  ])(
    "width=$paneWidth previouslyFits=$previouslyFits -> $fits",
    ({ paneWidth, previouslyFits, fits }) => {
      expect(asideFitsBesideChat(paneWidth, previouslyFits)).toBe(fits);
    },
  );
});
