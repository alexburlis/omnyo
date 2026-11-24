import type { ExperimentalThreadCompanionPlacement } from "@omnyo/plugin-sdk";

export const THREAD_COMPANION_ASIDE_GEOMETRY = {
  chatColumnWidth: 760,
  cardWidth: 288,
  inset: 16,
  edgeReserve: 44,
  hysteresis: 24,
} as const;

const {
  cardWidth: CARD_WIDTH,
  chatColumnWidth: CHAT_COLUMN_WIDTH,
  edgeReserve: EDGE_RESERVE,
  hysteresis: HYSTERESIS,
  inset: INSET,
} = THREAD_COMPANION_ASIDE_GEOMETRY;

const ASIDE_REQUIRED_GUTTER = INSET + CARD_WIDTH + INSET + EDGE_RESERVE;

export function asideFitsBesideChat(
  paneWidth: number,
  previouslyFits: boolean,
): boolean {
  const gutter = (paneWidth - CHAT_COLUMN_WIDTH) / 2;

  return (
    gutter >=
    ASIDE_REQUIRED_GUTTER + (previouslyFits ? -HYSTERESIS : HYSTERESIS) / 2
  );
}

export interface ThreadCompanionPlacementInput {
  compact: boolean;
  focused: boolean;
  asideFits: boolean;
}

const PLACEMENT_RULES: readonly {
  applies: (input: ThreadCompanionPlacementInput) => boolean;
  placement: ExperimentalThreadCompanionPlacement;
}[] = [
  { applies: (input) => input.compact, placement: "inline" },
  { applies: (input) => input.asideFits, placement: "aside" },
  { applies: (input) => input.focused, placement: "toolbar" },
];

export function resolveThreadCompanionPlacement(
  input: ThreadCompanionPlacementInput,
): ExperimentalThreadCompanionPlacement | null {
  return PLACEMENT_RULES.find((rule) => rule.applies(input))?.placement ?? null;
}
