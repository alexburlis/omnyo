import {
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { INSET_FOCUS_RING_CLASS } from "./focus-ring";
import { Icon, type IconName } from "./icon";
import {
  CONTROL_HOVER_TRANSITION,
  SEGMENTED_INDICATOR_TRANSITION,
} from "./motion";

export const SEGMENTED_INDICATOR_BASE_CLASS = cn(
  "pointer-events-none absolute bg-state-active",
  SEGMENTED_INDICATOR_TRANSITION,
);

export const SEGMENTED_SEGMENT_CLASS =
  "relative aria-pressed:bg-transparent aria-pressed:hover:bg-transparent";

export function segmentedIndicatorClass({
  geometry,
  secondSelected,
  secondOffset,
}: {
  geometry: string;
  secondSelected: boolean;
  secondOffset: string;
}): string {
  return cn(
    SEGMENTED_INDICATOR_BASE_CLASS,
    geometry,
    secondSelected && secondOffset,
  );
}

export interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: IconName;
  ariaLabel?: string;
  disabled?: boolean;
}

interface SegmentedTrackStyle extends CSSProperties {
  "--segment-count": string;
  "--segment-index": string;
}

const SEGMENTED_SIZE = {
  sm: { track: "h-7", segment: "px-2.5 text-xs" },
  default: { track: "h-8", segment: "px-3 text-sm" },
} as const;

export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  size = "default",
  fullWidth = false,
  className,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly SegmentedControlOption<Value>[];
  ariaLabel: string;
  size?: keyof typeof SEGMENTED_SIZE;
  fullWidth?: boolean;
  className?: string;
}) {
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const dimensions = SEGMENTED_SIZE[size];

  const style: SegmentedTrackStyle = {
    "--segment-count": String(Math.max(1, options.length)),
    "--segment-index": String(selectedIndex),
  };

  const select = (index: number): boolean => {
    const option = options[index];

    if (option === undefined || option.disabled) return false;
    onValueChange(option.value);
    segmentRefs.current[index]?.focus();

    return true;
  };

  const moveSelection = (direction: 1 | -1) => {
    const count = options.length;

    for (let step = 1; step < count; step += 1) {
      if (select((selectedIndex + direction * step + count) % count)) return;
    }
  };

  const selectEdge = (direction: 1 | -1) => {
    const count = options.length;

    for (let step = 0; step < count; step += 1) {
      if (select(direction === 1 ? step : count - 1 - step)) return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectEdge(1);
    } else if (event.key === "End") {
      event.preventDefault();
      selectEdge(-1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={style}
      className={cn(
        "relative isolate grid auto-cols-fr grid-flow-col items-stretch rounded-lg bg-surface-recessed p-0.5",
        fullWidth ? "w-full" : "w-fit",
        dimensions.track,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          SEGMENTED_INDICATOR_TRANSITION,
          "pointer-events-none absolute inset-y-0.5 left-0.5 -z-10 w-[calc((100%-0.25rem)/var(--segment-count))] translate-x-[calc(var(--segment-index)*100%)] rounded-md bg-surface-thumb shadow-control",
        )}
      />
      {options.map((option, index) => {
        const selected = index === selectedIndex;

        return (
          <button
            key={option.value}
            ref={(element) => {
              segmentRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onValueChange(option.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "flex min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-50 [&_[data-icon-root]]:size-3.5 [&_[data-icon-root]]:shrink-0",
              CONTROL_HOVER_TRANSITION,
              INSET_FOCUS_RING_CLASS,
              dimensions.segment,
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon === undefined ? null : (
              <Icon name={option.icon} aria-hidden="true" />
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
