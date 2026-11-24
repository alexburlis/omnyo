import "./onboarding-brand.css";

import { cn } from "@omnyo/shared-ui/lib/utils";

export const ONBOARDING_RING_PATH =
  "M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z";

export function OnboardingMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("omnyo-onboarding-mark", className)}
      viewBox="7 7 50 50"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ONBOARDING_RING_PATH} fill="currentColor" />
      <circle
        className="omnyo-onboarding-mark-dot"
        cx="49.5"
        cy="14.5"
        r="6.5"
      />
    </svg>
  );
}
