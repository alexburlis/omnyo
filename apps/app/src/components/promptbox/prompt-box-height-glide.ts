import {
  MOTION_EASE,
  prefersReducedMotion,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";

export interface PromptBoxHeightGlideOptions {
  durationMs: number;
}

export function glidePromptBoxHeight(
  form: HTMLElement,
  fromHeight: number,
  { durationMs }: PromptBoxHeightGlideOptions,
): () => void {
  if (prefersReducedMotion()) return () => {};

  const previousTransition = form.style.transition;
  const previousWillChange = form.style.willChange;
  const previousOverflow = form.style.overflow;

  form.style.transition = "none";
  form.style.height = "";
  const toHeight = form.getBoundingClientRect().height;

  if (Math.abs(toHeight - fromHeight) < 0.5) {
    form.style.transition = previousTransition;

    return () => {};
  }

  form.style.height = `${fromHeight}px`;
  form.getBoundingClientRect();
  form.style.overflow = "hidden";
  form.style.willChange = "height";
  form.style.transition = `height ${durationMs}ms ${MOTION_EASE.smooth}`;
  form.style.height = `${toHeight}px`;

  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    form.style.transition = previousTransition;
    form.style.willChange = previousWillChange;
    form.style.overflow = previousOverflow;
    form.style.height = "";
    form.removeEventListener("transitionend", handleTransitionEnd);
    window.clearTimeout(fallbackTimeout);
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target !== form || event.propertyName !== "height") return;
    cleanup();
  };

  const fallbackTimeout = window.setTimeout(
    cleanup,
    durationMs + TRANSITION_FALLBACK_SLACK_MS,
  );

  form.addEventListener("transitionend", handleTransitionEnd);

  return cleanup;
}
