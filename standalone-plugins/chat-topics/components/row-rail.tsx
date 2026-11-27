import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { age, createdLabel } from "../lib/feed.ts";
import { useHint } from "./hint.tsx";

const MINUTE = 60_000;

const listeners = new Set<() => void>();

let now = Date.now();

let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);

  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();

      for (const notify of listeners) notify();
    }, MINUTE);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function useMinute() {
  return useSyncExternalStore(subscribe, () => now);
}

export function RowAge({ at, verb }: { at: number; verb: string }) {
  const current = useMinute();

  return (
    <time
      className="ct-age"
      dateTime={new Date(at).toISOString()}
      title={`${verb} ${createdLabel(current, at)}`}
    >
      {age(current, at)}
    </time>
  );
}

interface SubChatToggleProps {
  count: number;
  fresh: number;
  expanded: boolean;
  title: string;
  onToggle: () => void;
}

export type RowChipTone = "neutral" | "attention";

interface RowChipProps {
  icon: string;
  label?: string;
  description: string;
  tone?: RowChipTone;
  focusable?: boolean;
}

export function RowChip({
  icon,
  label,
  description,
  tone = "neutral",
  focusable = true,
}: RowChipProps) {
  const { ref, trigger, hint } = useHint<HTMLSpanElement>(description);

  return (
    <span
      ref={ref}
      {...trigger}
      className="ct-meta"
      data-tone={tone}
      data-icon-only={label === undefined ? "" : undefined}
      data-ct-trailing=""
      role="img"
      aria-label={description}
      tabIndex={focusable ? 0 : undefined}
    >
      <Icon name={icon} className="ct-meta-icon" aria-hidden />
      {label === undefined ? null : <span aria-hidden>{label}</span>}
      {hint}
    </span>
  );
}

export function subchatHint(count: number, fresh: number, expanded: boolean): string {
  const noun = count === 1 ? "subchat" : "subchats";
  const news = fresh === 0 ? "" : ` · ${fresh} with new replies`;

  return `${expanded ? "Hide" : "Show"} ${count} ${noun}${news}`;
}

export function SubChatToggle({ count, fresh, expanded, title, onToggle }: SubChatToggleProps) {
  const noun = count === 1 ? "subchat" : "subchats";
  const { ref, trigger, hint } = useHint<HTMLButtonElement>(subchatHint(count, fresh, expanded));

  return (
    <button
      ref={ref}
      {...trigger}
      type="button"
      className="ct-kids ct-meta"
      data-fresh={fresh > 0}
      aria-label={`${expanded ? "Hide" : "Show"} ${count} ${noun} of ${title}${fresh > 0 ? `, ${fresh} with new replies` : ""}`}
      aria-expanded={expanded}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="Layers" className="ct-meta-icon" aria-hidden />
      <span className="ct-kids-count">{count}</span>
      {fresh > 0 ? <span className="ct-kids-fresh" aria-hidden /> : null}
      {hint}
    </button>
  );
}

export function RowAgeSlot({ at, verb }: { at: number; verb: string }) {
  return (
    <span className="ct-age-slot">
      <RowAge at={at} verb={verb} />
    </span>
  );
}

interface RowRailProps {
  meta?: ReactNode;
  kids: ReactNode;
  menu: ReactNode;
}

export function RowRail({ meta = null, kids, menu }: RowRailProps) {
  return (
    <div className="ct-rail" data-kids={kids !== null}>
      {kids === null && meta === null ? null : (
        <span className="ct-rail-kids" data-ct-trailing="">
          {meta}
          {kids}
        </span>
      )}
      <span className="ct-rail-end">{menu}</span>
    </div>
  );
}
