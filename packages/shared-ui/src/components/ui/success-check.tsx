import { cn } from "../../lib/utils";
import { SUCCESS_CHECK_BADGE_CLASS, SUCCESS_CHECK_DRAW_CLASS } from "./motion";

export function CheckMark({
  animate = false,
  className,
}: {
  animate?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("size-3 shrink-0", className)}
    >
      <path
        d="M3.75 8.25 6.75 11.25 12.25 4.75"
        pathLength={1}
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? SUCCESS_CHECK_DRAW_CLASS : undefined}
      />
    </svg>
  );
}

const SUCCESS_CHECK_SIZE = {
  sm: { badge: "size-4", mark: "size-2.5" },
  md: { badge: "size-5", mark: "size-3" },
  lg: { badge: "size-8", mark: "size-4.5" },
} as const;

export function SuccessCheck({
  animate = false,
  label,
  size = "md",
  className,
}: {
  animate?: boolean;
  label?: string;
  size?: keyof typeof SUCCESS_CHECK_SIZE;
  className?: string;
}) {
  const dimensions = SUCCESS_CHECK_SIZE[size];

  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-success/15 text-success-foreground",
        dimensions.badge,
        animate && SUCCESS_CHECK_BADGE_CLASS,
        className,
      )}
    >
      <CheckMark animate={animate} className={dimensions.mark} />
    </span>
  );
}
