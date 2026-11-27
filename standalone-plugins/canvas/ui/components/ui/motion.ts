export const CONTROL_HOVER_TRANSITION = "transition-colors duration-(--motion-duration-fast)";

export const CONTROL_PRESS_TRANSITION =
  "transition-[color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,scale] duration-(--motion-duration-fast) ease-(--motion-ease-spring)";

export const CONTROL_PRESS_FEEDBACK = "motion-safe:active:not-data-[state=open]:scale-[0.97]";

export const LIST_HOVER_TRANSITION = "transition-none";

export const MOTION_EASE = {
  standard: "var(--motion-ease-standard)",
  inOut: "var(--motion-ease-in-out)",
  in: "var(--motion-ease-in)",
  out: "var(--motion-ease-out)",
  sheet: "var(--motion-ease-sheet)",
  panel: "var(--motion-ease-panel)",
} as const;

export const MOTION_DURATION_MS = {
  fast: 150,
  base: 250,
  slow: 350,
  sheet: 400,
  sidebar: 60,
  panel: 90,
  drawer: 267,
} as const;
