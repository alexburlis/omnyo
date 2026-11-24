import { useMemo } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { INSET_FOCUS_RING_CLASS } from "@omnyo/shared-ui/focus-ring";
import { useMinuteNow } from "@omnyo/shared-ui/hooks/use-minute-now";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { SECTION_COUNT_CLASS } from "@omnyo/shared-ui/section-header";
import { StatusDot } from "@omnyo/shared-ui/status-row";
import { useProjectRailCatalog } from "@/components/sidebar/project-rail-catalog";
import { formatRelativeTime } from "@/lib/relative-time";
import { useOpenThreadInLayout } from "@/views/thread-detail/useOpenThreadInLayout";
import {
  HOME_CARD_KIND_DESCRIPTION,
  HOME_CARD_KIND_LABEL,
  homeCountsLine,
  homeGreetingText,
  homeQuietCountsLine,
  type HomeNeedsRow,
  type HomeRowKind,
} from "./home-orientation";
import {
  useCurrentHour,
  useHomeOrientationCounts,
  useHomeOwnerFirstName,
  useOpenInboxSidebar,
} from "./useHomeOrientation";

export type HomeGreetingLayout = "stage" | "compact";

const HOME_STATUS_HEADING_ID = "home-status-heading";

const HOME_STATUS_RESERVE_CLASS = "mt-3 min-h-22";

const HOME_STATUS_PANEL_CLASS =
  "mt-3 overflow-hidden rounded-[12px] bg-(--material-raised) shadow-(--material-shadow-raised)";

const HOME_STATUS_HOVER_CLASS = cn(
  INSET_FOCUS_RING_CLASS,
  CONTROL_HOVER_TRANSITION,
  "hover:bg-[color-mix(in_oklab,var(--material-raised),var(--ink)_5%)]",
);

const HOME_STATUS_ROW_CLASS = cn(
  "flex w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-2.5 text-left",
  HOME_STATUS_HOVER_CLASS,
);

const HOME_STATUS_KIND_CLASS =
  "inline-flex h-5 w-26 shrink-0 items-center justify-center truncate rounded-full px-2 text-2xs font-medium";

const HOME_KIND_TONE_CLASS: Record<HomeRowKind, string> = {
  question: "bg-surface-attention text-foreground",
  result: "bg-success/12 text-success-foreground",
  returned: "bg-state-hover text-muted-foreground",
  problem: "bg-warning/15 text-warning-text",
  runs: "bg-state-hover text-muted-foreground",
  chain: "bg-state-hover text-muted-foreground",
  failed: "bg-destructive/10 text-destructive-text",
};

const HOME_STATUS_MORE_CLASS = cn(
  "flex w-full cursor-pointer items-center gap-3 border-t border-border-hairline px-4 py-2 text-left text-xs text-muted-foreground tabular-nums hover:text-foreground",
  HOME_STATUS_HOVER_CLASS,
);

export function HomeGreeting({ layout }: { layout: HomeGreetingLayout }) {
  const hour = useCurrentHour();
  const { firstName, isSettled } = useHomeOwnerFirstName();
  const counts = useHomeOrientationCounts();
  const greeting = homeGreetingText(hour, firstName);

  if (layout === "stage") {
    return (
      <div data-testid="home-greeting" className="mb-6 text-center">
        <h1
          className={cn(
            "text-display font-semibold tracking-tight text-foreground",
            !isSettled && "invisible",
          )}
        >
          {greeting}
        </h1>
      </div>
    );
  }

  return (
    <div data-testid="home-greeting" className="mb-3 text-center">
      <h1
        className={cn(
          "text-xl font-semibold tracking-tight text-foreground",
          !isSettled && "invisible",
        )}
      >
        {greeting}
      </h1>
      <p className="mt-1 min-h-5 text-xs text-muted-foreground tabular-nums">
        {homeCountsLine(counts)}
      </p>
    </div>
  );
}

function HomeNeedsRowButton({
  row,
  projectName,
  now,
  onOpen,
  failed = false,
}: {
  failed?: boolean;
  row: HomeNeedsRow;
  projectName: string | null;
  now: number;
  onOpen: (row: HomeNeedsRow) => void;
}) {
  const age = formatRelativeTime({ timestamp: row.at, now });
  const kind = failed ? "failed" : row.kind;

  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${row.title}`}
        aria-description={
          kind === null ? undefined : HOME_CARD_KIND_DESCRIPTION[kind]
        }
        onClick={() => onOpen(row)}
        className={HOME_STATUS_ROW_CLASS}
      >
        {kind === null ? null : (
          <span
            title={HOME_CARD_KIND_DESCRIPTION[kind]}
            className={cn(HOME_STATUS_KIND_CLASS, HOME_KIND_TONE_CLASS[kind])}
          >
            {kind === "failed" ? "Failed" : HOME_CARD_KIND_LABEL[kind]}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {row.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {projectName === null ? age : `${projectName} · ${age}`}
        </span>
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
      </button>
    </li>
  );
}

function HomeStatusGroupHeading({
  id,
  title,
  count,
  countLabel,
  tone,
  level,
}: {
  id?: string;
  title: string;
  count: number | null;
  countLabel: string;
  tone: "attention" | "error" | "quiet";
  level: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";

  return (
    <Heading
      id={id}
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm font-medium tabular-nums",
        tone === "error" ? "text-destructive-text" : "text-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "attention" &&
            "bg-attention ring-[3px] ring-[color-mix(in_oklab,var(--attention)_22%,transparent)]",
          tone === "error" && "bg-destructive ring-[3px] ring-destructive/20",
          tone === "quiet" && "bg-subtle-foreground",
        )}
      />
      <span className="truncate">{title}</span>
      {count === null ? null : " "}
      {count === null ? null : (
        <span
          className={cn(
            SECTION_COUNT_CLASS,
            "shrink-0",
            tone === "error" && "bg-destructive/10 text-destructive-text",
            tone === "attention" && "bg-surface-attention text-foreground",
          )}
        >
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">{countLabel}</span>
        </span>
      )}
    </Heading>
  );
}

function chatCountLabel(count: number): string {
  return `${count} ${count === 1 ? "chat" : "chats"}`;
}

export interface HomeStatusPanelProps {
  needs: number;
  needsRows: readonly HomeNeedsRow[];
  failed: number;
  failedRows: readonly HomeNeedsRow[];
  running: number;
  ready: number;
  projectNames: ReadonlyMap<string, string>;
  now: number;
  onOpenRow: (row: HomeNeedsRow) => void;
  onOpenInbox: () => void;
}

export function HomeStatusPanel({
  needs,
  needsRows,
  failed,
  failedRows,
  running,
  ready,
  projectNames,
  now,
  onOpenRow,
  onOpenInbox,
}: HomeStatusPanelProps) {
  const quietCounts = homeQuietCountsLine({ running, ready });
  const hiddenNeeds = needs - needsRows.length;
  const hiddenFailed = failed - failedRows.length;
  const hiddenNeedsText = `${hiddenNeeds} more ${hiddenNeeds === 1 ? "chat needs" : "need"} you`;
  const hiddenFailedText = `${hiddenFailed} more failed`;

  return (
    <section
      data-testid="home-status-cards"
      aria-labelledby={HOME_STATUS_HEADING_ID}
      className={HOME_STATUS_PANEL_CLASS}
    >
      <div className="flex min-h-11 items-center gap-3 py-1.5 pr-2 pl-4">
        <HomeStatusGroupHeading
          id={HOME_STATUS_HEADING_ID}
          level={2}
          title={needs > 0 ? "Needs you" : "Nothing needs you"}
          count={needs > 0 ? needs : null}
          countLabel={chatCountLabel(needs)}
          tone={needs > 0 ? "attention" : "quiet"}
        />
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {quietCounts === null ? null : (
            <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground tabular-nums sm:flex">
              {running > 0 ? <StatusDot tone="active" /> : null}
              <span className="truncate">{quietCounts}</span>
            </span>
          )}
          <Button
            type="button"
            variant="soft"
            size="xs"
            className="shrink-0"
            onClick={onOpenInbox}
          >
            Open Inbox
            <Icon name="ChevronRight" aria-hidden />
          </Button>
        </span>
      </div>
      {needsRows.length === 0 ? null : (
        <ul className="divide-y divide-border-hairline border-t border-border-hairline">
          {needsRows.map((row) => (
            <HomeNeedsRowButton
              key={row.threadId}
              row={row}
              projectName={projectNames.get(row.projectId) ?? null}
              now={now}
              onOpen={onOpenRow}
            />
          ))}
        </ul>
      )}
      {hiddenNeeds > 0 ? (
        <button
          type="button"
          aria-label={`${hiddenNeedsText}, see all in Inbox`}
          onClick={onOpenInbox}
          className={HOME_STATUS_MORE_CLASS}
        >
          <span className="min-w-0 truncate">{hiddenNeedsText}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-subtle-foreground">
            See all in Inbox
            <Icon name="ChevronRight" aria-hidden className="size-3.5" />
          </span>
        </button>
      ) : null}
      {failed > 0 ? (
        <>
          <div className="flex min-h-10 items-center border-t border-border-hairline px-4">
            <HomeStatusGroupHeading
              level={3}
              title="Failed"
              count={failed}
              countLabel={chatCountLabel(failed)}
              tone="error"
            />
            <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
              Stopped before finishing
            </span>
          </div>
          <ul className="divide-y divide-border-hairline border-t border-border-hairline">
            {failedRows.map((row) => (
              <HomeNeedsRowButton
                key={row.threadId}
                row={row}
                failed
                projectName={projectNames.get(row.projectId) ?? null}
                now={now}
                onOpen={onOpenRow}
              />
            ))}
          </ul>
          {hiddenFailed > 0 ? (
            <button
              type="button"
              aria-label={`${hiddenFailedText}, see all in Inbox`}
              onClick={onOpenInbox}
              className={HOME_STATUS_MORE_CLASS}
            >
              <span className="min-w-0 truncate">{hiddenFailedText}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-subtle-foreground">
                See all in Inbox
                <Icon name="ChevronRight" aria-hidden className="size-3.5" />
              </span>
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function HomeStatusCards() {
  const { needs, needsRows, failed, failedRows, running, ready, isLoaded } =
    useHomeOrientationCounts();

  const catalog = useProjectRailCatalog();
  const openInbox = useOpenInboxSidebar();
  const openThread = useOpenThreadInLayout({ userInitiated: true });
  const now = useMinuteNow();

  const openStatusChat = ({ projectId, threadId }: HomeNeedsRow) => {
    openThread({ projectId, threadId }, "replace");
  };

  const projectNames = useMemo(
    () =>
      new Map(catalog.entries.map(({ project }) => [project.id, project.name])),
    [catalog],
  );

  if (!isLoaded) {
    return (
      <div
        aria-hidden="true"
        data-testid="home-status-cards-reserve"
        className={HOME_STATUS_RESERVE_CLASS}
      />
    );
  }

  if (needs === 0 && failed === 0 && running === 0 && ready === 0) return null;

  return (
    <HomeStatusPanel
      needs={needs}
      needsRows={needsRows}
      failed={failed}
      failedRows={failedRows}
      running={running}
      ready={ready}
      projectNames={projectNames}
      now={now}
      onOpenRow={openStatusChat}
      onOpenInbox={openInbox}
    />
  );
}
