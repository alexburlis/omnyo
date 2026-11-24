import {
  OMNYO_DESKTOP_MAX_ZOOM_PERCENT,
  OMNYO_DESKTOP_MIN_ZOOM_PERCENT,
  type OmnyoDesktopZoomCommand,
} from "@omnyo/desktop-contract";

const ZOOM_STEP_PERCENT = 10;

export function nextZoomFactor(
  zoomFactor: number,
  command: OmnyoDesktopZoomCommand,
): number {
  if (command === "reset") {
    return 1;
  }

  const step = command === "in" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT;

  const percent =
    Math.round((zoomFactor * 100 + step) / ZOOM_STEP_PERCENT) *
    ZOOM_STEP_PERCENT;

  return (
    Math.min(
      OMNYO_DESKTOP_MAX_ZOOM_PERCENT,
      Math.max(OMNYO_DESKTOP_MIN_ZOOM_PERCENT, percent),
    ) / 100
  );
}
