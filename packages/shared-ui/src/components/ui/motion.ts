import { useState, type CSSProperties } from "react";
import {
  getMediaQuerySnapshot,
  REDUCED_MOTION_QUERY,
  usePrefersReducedMotion,
} from "./hooks/use-media-query";

export { usePrefersReducedMotion };

export const MOTION_EASE = {
  standard: "var(--motion-ease-standard)",
  inOut: "var(--motion-ease-in-out)",
  in: "var(--motion-ease-in)",
  out: "var(--motion-ease-out)",
  sheet: "var(--motion-ease-sheet)",
  smooth: "var(--motion-ease-smooth)",
  snappy: "var(--motion-ease-snappy)",
} as const;

export type MotionEaseName = keyof typeof MOTION_EASE;

export const MOTION_DURATION_MS = {
  fast: 150,
  base: 250,
  slow: 350,
  sheet: 400,
  sidebar: 60,
  panel: 90,
  drawer: 267,
  stagger: 30,
} as const;

export const TRANSITION_FALLBACK_SLACK_MS = 50;

export const CONTROL_HOVER_TRANSITION =
  "transition-colors duration-(--motion-duration-fast)";

export const CONTROL_PRESS_TRANSITION =
  "transition-[color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,scale] [transition-duration:var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-fast),var(--motion-duration-base)] [transition-timing-function:var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-snappy)] active:[transition-duration:var(--motion-duration-fast)]";

export const CONTROL_PRESS_FEEDBACK =
  "motion-safe:active:not-data-[state=open]:scale-[0.97]";

export const LIST_HOVER_TRANSITION =
  "transition-none motion-safe:active:not-data-[state=open]:scale-100";

export const SEGMENTED_INDICATOR_TRANSITION =
  "transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none";

export const REVEALED_CONTENT_MOTION =
  "animate-in fade-in-0 duration-(--motion-duration-base)";

export const STAGGER_ITEM_CLASS = "omnyo-stagger-item";

export const CARD_LIFT_CLASS = "omnyo-card-lift";

export const SUCCESS_CHECK_DRAW_CLASS = "omnyo-check-draw";

export const SUCCESS_CHECK_BADGE_CLASS = "omnyo-check-badge";

export const STEP_ENTER_CLASS = "omnyo-step-enter";

export const STEP_EXIT_CLASS = "omnyo-step-exit";

export const PROGRESS_FILL_TRANSITION =
  "transition-transform duration-(--motion-duration-slow) ease-(--motion-ease-smooth) motion-reduce:transition-none";

export interface StaggerItemStyle extends CSSProperties {
  "--omnyo-stagger-index": string;
  "--omnyo-stagger-count": string;
}

export function getStaggerItemStyle(
  index: number,
  count: number,
): StaggerItemStyle {
  return {
    "--omnyo-stagger-index": String(Math.max(0, index)),
    "--omnyo-stagger-count": String(Math.max(1, count)),
  };
}

export function getStaggerDelayMs(index: number, count: number): number {
  if (count <= 1 || index <= 0) return 0;

  const step = Math.min(
    MOTION_DURATION_MS.stagger,
    MOTION_DURATION_MS.fast / (count - 1),
  );

  return Math.round(Math.min(index, count - 1) * step);
}

export function getStaggerItemProps(
  index: number,
  count: number,
  enabled: boolean,
): { className?: string; style?: StaggerItemStyle } {
  if (!enabled) return {};

  return {
    className: STAGGER_ITEM_CLASS,
    style: getStaggerItemStyle(index, count),
  };
}

export function useChangedSinceMount<T>(value: T): boolean {
  const [initial] = useState(value);
  const [changed, setChanged] = useState(false);
  const differs = !Object.is(value, initial);

  if (differs && !changed) setChanged(true);

  return changed || differs;
}

export const DISCLOSURE_CHEVRON_TRANSITION =
  "transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none";

export function getDisclosureDurationMs(expanding: boolean): number {
  return expanding ? MOTION_DURATION_MS.slow : MOTION_DURATION_MS.base;
}

export function getDisclosureDurationClass(expanding: boolean): string {
  return expanding
    ? "duration-(--motion-duration-slow)"
    : "duration-(--motion-duration-base)";
}

export function getDisclosureRevealClass(expanded: boolean): string {
  const base =
    "grid transition-[grid-template-rows,opacity] ease-(--motion-ease-smooth) motion-reduce:transition-[opacity] motion-reduce:duration-(--motion-duration-fast)";

  return expanded
    ? `${base} grid-rows-[1fr] opacity-100 duration-(--motion-duration-slow)`
    : `${base} pointer-events-none grid-rows-[0fr] opacity-0 duration-(--motion-duration-base)`;
}

export const FLOATING_MENU_MOTION =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-(--motion-duration-fast) data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export const FLOATING_POPOVER_MOTION =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

export const FLOATING_FADE_MOTION =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--motion-duration-fast) data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export const TOOLTIP_MOTION =
  "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-97 data-[state=delayed-open]:duration-(--motion-duration-fast) data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export const MODAL_OVERLAY_MOTION =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export const MODAL_CONTENT_MOTION =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

export const COLLAPSIBLE_CONTENT_MOTION =
  "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up";

export const SORTABLE_TRANSITION = {
  duration: MOTION_DURATION_MS.base,
  easing: MOTION_EASE.smooth,
} as const;

export function getSortableTransition(
  reducedMotion: boolean,
): typeof SORTABLE_TRANSITION | null {
  return reducedMotion ? null : SORTABLE_TRANSITION;
}

export function getSortableDropAnimation(
  reducedMotion: boolean,
): { duration: number; easing: string } | null {
  if (reducedMotion) return null;

  const easing = resolveMotionEase("smooth");

  return easing === "" ? null : { duration: MOTION_DURATION_MS.base, easing };
}

export function prefersReducedMotion(): boolean {
  return getMediaQuerySnapshot(REDUCED_MOTION_QUERY);
}

export function getDragSettleMs(
  remainingFraction: number,
  reducedMotion: boolean,
  maxMs: number = MOTION_DURATION_MS.sheet,
): number {
  if (reducedMotion) return 0;

  const remaining = Math.min(1, Math.max(0, remainingFraction));

  return Math.round(
    Math.min(maxMs, Math.max(MOTION_DURATION_MS.fast, maxMs * remaining)),
  );
}

export function dragSettleTransition(
  properties: readonly string[],
  ms: number,
): string {
  if (ms <= 0) return "none";

  return properties
    .map((property) => `${property} ${ms}ms ${MOTION_EASE.sheet}`)
    .join(", ");
}

export function resolveMotionEase(
  name: MotionEaseName,
  element: Element = document.documentElement,
): string {
  const token = MOTION_EASE[name].slice("var(".length, -1);

  return getComputedStyle(element).getPropertyValue(token).trim();
}
