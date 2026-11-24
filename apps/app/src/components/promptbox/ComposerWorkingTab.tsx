import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TimelineRow } from "@omnyo/server-contract";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { useIsOverflowing } from "@/components/thread/timeline/conversation-message-overflow";

export interface ComposerWorkingState {
  label: string;
  detail: string;
  thinking: boolean;
  startedAt: number | null;
}

export function activeTurnStartedAt(
  rows: readonly TimelineRow[],
): number | null {
  const last = rows.at(-1);

  if (last === undefined) return null;

  if (last.turnId === null) {
    return last.kind === "conversation" ? last.startedAt : null;
  }

  if (last.kind === "turn" && last.completedAt !== null) return null;
  let startedAt = last.startedAt;

  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const row = rows[index];

    if (row === undefined || row.turnId !== last.turnId) break;
    startedAt = Math.min(startedAt, row.startedAt);
  }

  return startedAt;
}

interface ComposerWorkingContextValue {
  shown: ComposerWorkingState | null;
  visible: boolean;
  allowQueueHost: boolean;
  queueHostClaimed: boolean;
  claimQueueHost: () => () => void;
}

const ComposerWorkingContext =
  createContext<ComposerWorkingContextValue | null>(null);

export function ComposerWorkingProvider({
  state,
  allowQueueHost,
  children,
}: {
  state: ComposerWorkingState | null;
  allowQueueHost: boolean;
  children: ReactNode;
}) {
  const visible = state !== null;
  const [shown, setShown] = useState(state);
  const [queueHostClaims, setQueueHostClaims] = useState(0);

  if (
    state !== null &&
    (shown === null ||
      shown.label !== state.label ||
      shown.detail !== state.detail ||
      shown.thinking !== state.thinking ||
      shown.startedAt !== state.startedAt)
  ) {
    setShown(state);
  }

  useEffect(() => {
    if (visible) return;

    const timeout = window.setTimeout(
      () => setShown(null),
      MOTION_DURATION_MS.base,
    );

    return () => window.clearTimeout(timeout);
  }, [visible]);

  const claimQueueHost = useCallback(() => {
    setQueueHostClaims((count) => count + 1);

    return () => setQueueHostClaims((count) => count - 1);
  }, []);

  const value = useMemo(
    () => ({
      shown,
      visible,
      allowQueueHost,
      queueHostClaimed: allowQueueHost && queueHostClaims > 0,
      claimQueueHost,
    }),
    [allowQueueHost, claimQueueHost, queueHostClaims, shown, visible],
  );

  return (
    <ComposerWorkingContext.Provider value={value}>
      {children}
    </ComposerWorkingContext.Provider>
  );
}

export function ComposerWorkingDock({ children }: { children: ReactNode }) {
  const working = useContext(ComposerWorkingContext);
  const shown = working?.shown ?? null;
  const visible = working?.visible ?? false;
  const tabOnComposer = shown !== null && !working?.queueHostClaimed;

  return (
    <div
      data-composer-working={
        shown === null ? undefined : visible ? "open" : "closed"
      }
      className={cn(
        "relative transition-[padding-top] duration-(--motion-duration-base) ease-smooth motion-reduce:transition-none",
        visible && tabOnComposer ? "pt-6" : "pt-0",
      )}
    >
      {tabOnComposer ? (
        <ComposerWorkingTab state={shown} visible={visible} />
      ) : null}
      <div className="omnyo-composer-working-frame relative">
        {children}
        {shown === null ? null : (
          <span aria-hidden="true" className="omnyo-composer-working-sweep" />
        )}
      </div>
    </div>
  );
}

export function ComposerWorkingQueueHost({
  active,
  children,
}: {
  active: boolean;
  children: (attachedToComposer: boolean) => ReactNode;
}) {
  const working = useContext(ComposerWorkingContext);
  const claimQueueHost = working?.claimQueueHost;
  const hosting = active && working?.allowQueueHost === true;
  const tabOnComposer = !hosting && working?.visible === true;

  useLayoutEffect(() => {
    if (!hosting || claimQueueHost === undefined) return;

    return claimQueueHost();
  }, [claimQueueHost, hosting]);

  const shown = hosting ? (working?.shown ?? null) : null;
  const visible = working?.visible ?? false;

  return (
    <div
      data-composer-working-queue={shown === null ? undefined : ""}
      className={
        hosting
          ? cn(
              "relative min-w-0 transition-[padding-top] duration-(--motion-duration-base) ease-smooth motion-reduce:transition-none",
              shown !== null && visible ? "pt-6" : "pt-0",
            )
          : "contents"
      }
    >
      {shown === null ? null : (
        <ComposerWorkingTab state={shown} visible={visible} />
      )}
      {children(!tabOnComposer)}
    </div>
  );
}

function trimEllipsis(text: string): string {
  return text.replace(/(?:…|\.{3})$/u, "");
}

function ComposerWorkingTab({
  state,
  visible,
}: {
  state: ComposerWorkingState;
  visible: boolean;
}) {
  const label = trimEllipsis(state.label);
  const detail = trimEllipsis(state.detail);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const expanded = expandedDetail === detail;

  const overflowing = useIsOverflowing({
    elementRef: labelRef,
    enabled: !expanded,
    measurementKey: label,
  });

  const expandable = expanded || overflowing || detail !== label;

  const toggle = () => setExpandedDetail(expanded ? null : detail);

  return (
    <div
      data-state={visible ? "open" : "closed"}
      data-activity={state.thinking ? "thinking" : "working"}
      data-expanded={expanded ? "" : undefined}
      onClick={
        expandable
          ? () => {
              if ((window.getSelection()?.toString() ?? "").length > 0) return;
              toggle();
            }
          : undefined
      }
      className={cn(
        "omnyo-working-tab absolute bottom-[calc(100%-34px)] left-4 flex max-w-[calc(100%-2rem)] items-start rounded-t-[11px] bg-surface-raised-solid px-2.5 pt-1 pb-3.5 text-xs",
        expandable
          ? "pointer-events-auto cursor-pointer has-focus-visible:ring-1 has-focus-visible:ring-ring"
          : "pointer-events-none",
      )}
    >
      <span aria-hidden="true" className="omnyo-working-tab-sheen" />
      <span className="flex min-w-0 items-start gap-1.5">
        <span aria-hidden="true" className="omnyo-working-orb mt-px">
          <span className="omnyo-working-orb-halo" />
          <span className="omnyo-working-orb-ring" />
          <span className="omnyo-working-orb-core" />
        </span>
        <span
          ref={labelRef}
          role="status"
          className={cn(
            "min-w-0 leading-4 font-medium",
            expanded
              ? "max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-all"
              : "animate-shine truncate",
          )}
        >
          {expanded ? detail : label}
        </span>
        {state.startedAt === null ? null : (
          <span
            aria-hidden="true"
            className="shrink-0 leading-4 whitespace-nowrap tabular-nums text-muted-foreground"
          >
            <LiveDurationText startedAt={state.startedAt} />
          </span>
        )}
        {expandable ? (
          <button
            type="button"
            className="sr-only"
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            {expanded ? "Collapse activity" : "Show full activity"}
          </button>
        ) : null}
      </span>
    </div>
  );
}
