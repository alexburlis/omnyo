export const CONTROL_HOVER_TRANSITION =
  "transition-colors duration-(--motion-duration-fast) hover:duration-0";

export const LIST_HOVER_TRANSITION = "transition-none";

export const MOTION_EASE = {
  standard: "var(--motion-ease-standard)",
  inOut: "var(--motion-ease-in-out)",
  in: "var(--motion-ease-in)",
  out: "var(--motion-ease-out)",
  sheet: "var(--motion-ease-sheet)",
} as const;

export const MOTION_DURATION_MS = {
  fast: 150,
  base: 250,
  slow: 350,
  sheet: 400,
  sidebar: 233,
  drawer: 267,
} as const;
