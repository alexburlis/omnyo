import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  type ExperimentalThreadCompanionPlacement,
  type ExperimentalThreadCompanionProps,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import { NotReadyButton, ArchiveButton, CardAlert, GlanceCard, LastLoaded } from "./card";
import {
  useChatCard,
  useMarkSeen,
  type CardSource,
  type ChatCard,
  type LoadedCard,
} from "./chat-card";
import { LoopBadge, LoopSection, useChatLoop, type LoopSource } from "./loop";
import type { PresentationStatus } from "./presentation";
import {
  readyLabel,
  Row,
  StatusChip,
  StaleStatus,
  statusDots,
  statusLabels,
  toneClasses,
} from "./shared";

export const companionIcon = "glance/card";

export function CompanionIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="6.5" cy="7.5" r="2.5" />
      <circle cx="6.5" cy="16.5" r="2.5" />
      <path d="M12 7.5h8.5M12 16.5h8.5" />
    </svg>
  );
}

type VisibleCard = Exclude<ChatCard, { kind: "hidden" }>;

interface ResultLine {
  text: string;
  success: boolean;
}

interface ChatSummary {
  status: PresentationStatus;
  reason: string | null;
  about: string | null;
  started: string | null;
  toward: string | null;
  result: ResultLine | null;
  updating: boolean;
  stale: boolean;
}

interface SummaryText {
  headline: string;
  summary: string | null;
  blocker: string | null;
}

function resultLine(status: PresentationStatus, text: SummaryText): ResultLine | null {
  switch (status) {
    case "done":
      return { text: text.summary ?? text.headline, success: true };
    case "blocked":
      return { text: text.blocker ?? text.headline, success: false };
    case "failed":
      return { text: text.headline, success: false };
    default:
      return null;
  }
}

const quietStatuses: ReadonlySet<PresentationStatus> = new Set(["finished", "open", "idle"]);

function summaryStatus(card: LoadedCard): PresentationStatus {
  const reported = card.view.card.status;

  if (
    card.view.staleSince === null &&
    quietStatuses.has(card.presentation.status) &&
    (reported === "done" || reported === "blocked")
  )
    return reported;

  return card.presentation.status;
}

interface SummaryFlags {
  reason: string;
  updating: boolean;
  stale: boolean;
}

function summarize(
  status: PresentationStatus,
  thread: PluginSidebarThread | undefined,
  started: string | null,
  text: SummaryText,
  { reason, ...flags }: SummaryFlags,
): ChatSummary {
  const about = thread?.displayTitle ?? null;
  const result = resultLine(status, text);
  const shown = result?.text ?? text.headline;

  return {
    status,
    reason: status === "working" || reason === "" || reason === shown ? null : reason,
    about: about === started ? null : about,
    started,
    toward: result === null ? text.headline : null,
    result,
    ...flags,
  };
}

function loadedSummary(card: LoadedCard): ChatSummary {
  const saved = card.view.card;
  const fresh = card.view.staleSince === null;
  const status = summaryStatus(card);

  return summarize(
    status,
    card.thread,
    saved.goal ?? null,
    {
      headline: fresh && status !== "failed" ? saved.headline : card.presentation.headline,
      summary: fresh ? (saved.sidebarSummary ?? null) : null,
      blocker: fresh ? (saved.blocker ?? card.presentation.blocker) : card.presentation.blocker,
    },
    { reason: card.presentation.headline, updating: card.updating, stale: card.stale },
  );
}

function chatSummary(card: Exclude<VisibleCard, { kind: "failed" }>): ChatSummary {
  if (card.kind === "card") return loadedSummary(card);

  return summarize(
    card.presentation.status,
    card.thread,
    null,
    { headline: card.presentation.headline, summary: null, blocker: null },
    { reason: card.presentation.headline, updating: card.updating, stale: card.stale },
  );
}

interface PillText {
  status: PresentationStatus;
  line: string;
}

function pillText(summary: ChatSummary | null): PillText {
  if (summary === null) return { status: "failed", line: "Glance card unavailable" };

  return {
    status: summary.status,
    line:
      summary.result?.text ??
      summary.reason ??
      summary.toward ??
      summary.about ??
      statusLabels[summary.status],
  };
}

export function ArchiveRow({
  thread,
  className = "mt-3",
  reason,
}: {
  thread: PluginSidebarThread;
  className?: string;
  reason?: string;
}) {
  return (
    <div
      role="group"
      aria-label={readyLabel}
      className={`${className} grid min-w-0 grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-xl bg-surface-recessed py-3 pr-2.5 pl-3.5`}
    >
      <span className="grid h-5 place-items-center text-success" aria-hidden="true">
        <Icon name="CircleCheck" className="size-[15px]" />
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-5 font-semibold text-foreground">{readyLabel}</p>
        {reason ? (
          <p className="mt-px whitespace-normal break-words text-sm leading-5 text-muted-foreground">
            {reason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <NotReadyButton thread={thread} quiet />
        <ArchiveButton thread={thread} quiet />
      </div>
    </div>
  );
}

function SummaryHeader({ summary, source }: { summary: ChatSummary; source: CardSource | null }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <StatusChip status={summary.status} />
      <StaleStatus stale={summary.stale} />
      {source === null ? null : <LastLoaded current={source.current} loading={source.loading} />}
      {summary.reason === null ? null : (
        <p className="w-full min-w-0 break-words text-xs text-muted-foreground">{summary.reason}</p>
      )}
    </div>
  );
}

function ResultValue({ result }: { result: ResultLine }) {
  return (
    <span
      className={`flex min-w-0 items-baseline gap-1.5 font-medium ${toneClasses[result.success ? "positive" : "negative"]}`}
    >
      <Icon
        name={result.success ? "CircleCheck" : "CircleX"}
        className="size-3.5 shrink-0 translate-y-0.5"
        aria-hidden="true"
      />
      <span className="min-w-0">{result.text}</span>
    </span>
  );
}

function SummaryContent({ summary, source }: { summary: ChatSummary; source: CardSource | null }) {
  return (
    <>
      <SummaryHeader summary={summary} source={source} />
      <dl className="mt-3 grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5 text-sm">
        {summary.about === null ? null : (
          <Row label="About">
            <span className="text-muted-foreground">{summary.about}</span>
          </Row>
        )}
        {summary.started === null ? null : (
          <Row label="Started">
            <span className="text-muted-foreground">{summary.started}</span>
          </Row>
        )}
        {summary.toward === null ? null : (
          <Row label="Toward">
            <span className="font-medium">{summary.toward}</span>
          </Row>
        )}
        {summary.result === null ? null : (
          <Row label="Result">
            <ResultValue result={summary.result} />
          </Row>
        )}
      </dl>
    </>
  );
}

interface CompanionContentProps {
  card: VisibleCard;
  source: CardSource;
  seenError: boolean;
  loop: LoopSource;
}

function CompanionContent({ loop, ...props }: CompanionContentProps) {
  return (
    <>
      <CardContent {...props} />
      <LoopSection source={loop} />
    </>
  );
}

function CardContent({ card, source, seenError }: Omit<CompanionContentProps, "loop">) {
  switch (card.kind) {
    case "card":
      return (
        <>
          <SummaryContent summary={loadedSummary(card)} source={source} />
          <CardAlert
            error={source.error}
            seenError={seenError}
            refresh={source.refresh}
            className="mt-2"
          />
        </>
      );
    case "work":
      return <SummaryContent summary={chatSummary(card)} source={null} />;
    case "failed":
      return (
        <CardAlert error={card.error} seenError={false} refresh={source.refresh} className="" />
      );
  }
}

interface PlacementProps {
  threadId: string;
}

function AsideCard({ threadId }: PlacementProps) {
  const { source, card } = useChatCard(threadId);
  const loop = useChatLoop(threadId);
  const seenError = useMarkSeen(threadId, source, card.kind === "card");

  if (card.kind === "hidden") return null;

  return (
    <section
      aria-label="Chat card"
      data-glance-companion="aside"
      className="max-h-[calc(100dvh-9rem)] min-h-0 w-full overflow-y-auto overscroll-contain rounded-2xl bg-(--material-raised) p-4 text-sm shadow-(--material-shadow-raised)"
    >
      <CompanionContent card={card} source={source} seenError={seenError} loop={loop} />
    </section>
  );
}

interface PanelPosition {
  left: number;
  top: number;
  maxHeight: number;
}

const panelWidth = 320;

function panelPosition(pill: DOMRect): PanelPosition {
  const width = Math.min(panelWidth, window.innerWidth - 24);
  const top = pill.bottom + 8;

  return {
    left: Math.max(
      12,
      Math.min(pill.left + pill.width / 2 - width / 2, window.innerWidth - width - 12),
    ),
    top,
    maxHeight: Math.max(120, window.innerHeight - top - 12),
  };
}

function ToolbarCard({ threadId }: PlacementProps) {
  const pluginId = experimental_usePluginId();
  const { source, card } = useChatCard(threadId);
  const loop = useChatLoop(threadId);
  const [panel, setPanel] = useState<PanelPosition | null>(null);
  const open = panel !== null;
  const seenError = useMarkSeen(threadId, source, open && card.kind === "card");
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const statusId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (
        target instanceof Node &&
        !pillRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      )
        setPanel(null);
    };

    const onResize = () => {
      const pill = pillRef.current?.getBoundingClientRect();
      setPanel(pill === undefined ? null : panelPosition(pill));
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (card.kind === "hidden") return null;

  const summary = card.kind === "failed" ? null : chatSummary(card);
  const { status, line } = pillText(summary);
  const updating = summary?.updating ?? false;

  const toggle = () => {
    const pill = pillRef.current?.getBoundingClientRect();

    if (!open) void loop.refresh();
    setPanel(open || pill === undefined ? null : panelPosition(pill));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setPanel(null);
    pillRef.current?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;

    if (
      next instanceof Node &&
      !panelRef.current?.contains(next) &&
      !pillRef.current?.contains(next)
    )
      setPanel(null);
  };

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        aria-label="Chat card"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={statusId}
        title={line}
        data-glance-companion="toolbar"
        className="inline-flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full bg-surface-recessed pr-3 pl-2.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-state-active"
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        {updating ? (
          <span
            aria-hidden="true"
            data-glance-update-progress=""
            className="h-0.75 w-11 shrink-0 overflow-hidden rounded-full bg-surface-recessed"
          >
            <span className="block h-full w-1/3 animate-indeterminate-progress rounded-full bg-timeline-accent" />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${statusDots[status]}`}
          />
        )}
        <span className="max-w-[360px] min-w-0 truncate">{line}</span>
        <StaleStatus stale={summary?.stale ?? false} />
        {loop.loop === null ? null : <LoopBadge loop={loop.loop} now={loop.now} />}
        <span id={statusId} className="sr-only">
          {`${statusLabels[status]}. ${line}.${loop.loop === null ? "" : " Loop running."}`}
        </span>
      </button>
      {panel === null
        ? null
        : createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Chat card"
              tabIndex={-1}
              data-omnyo-portaled-overlay=""
              data-omnyo-plugin-root=""
              data-omnyo-plugin={pluginId}
              data-glance-companion="popover"
              style={{ left: panel.left, top: panel.top, maxHeight: panel.maxHeight }}
              className="fixed z-50 w-80 max-w-[calc(100vw-24px)] origin-top overflow-y-auto overscroll-contain rounded-2xl bg-(--material-raised) p-4 backdrop-blur-xl text-sm text-foreground shadow-(--material-shadow-float) outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
              onKeyDown={onKeyDown}
              onBlur={onBlur}
            >
              <CompanionContent card={card} source={source} seenError={seenError} loop={loop} />
            </div>,
            document.body,
          )}
    </>
  );
}

function InlineCard({ threadId }: PlacementProps) {
  return <GlanceCard threadId={threadId} />;
}

const placements: Record<ExperimentalThreadCompanionPlacement, ComponentType<PlacementProps>> = {
  aside: AsideCard,
  toolbar: ToolbarCard,
  inline: InlineCard,
};

export function GlanceCompanion({ threadId, placement }: ExperimentalThreadCompanionProps) {
  const Placement = placements[placement];

  return <Placement key={threadId} threadId={threadId} />;
}
