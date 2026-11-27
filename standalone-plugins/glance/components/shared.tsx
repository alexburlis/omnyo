import type { ReactNode } from "react";
import { experimental_Icon as Icon, experimental_useSidebarThreads } from "@omnyo/plugin-sdk/app";
import type { CardPhase, FactTone } from "../contract";
import type { Readiness } from "./readiness";
import type { PresentationStatus } from "./presentation";

export const statusLabels: Record<PresentationStatus, string> = {
  "needs-you": "Needs you",
  blocked: "Blocked",
  working: "Working",
  done: "Done",
  finished: "Finished",
  waiting: "Waiting",
  open: "Open",
  idle: "Idle",
  unknown: "Unknown",
  failed: "Failed",
};

const statusClasses: Record<PresentationStatus, string> = {
  "needs-you": "bg-warning/10 text-warning-text",
  blocked: "bg-destructive/10 text-destructive",
  working: "bg-timeline-accent/10 text-timeline-accent",
  done: "bg-success/10 text-success-foreground",
  finished: "bg-muted text-muted-foreground",
  waiting: "bg-muted text-muted-foreground",
  open: "bg-muted text-muted-foreground",
  idle: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

export const statusDots: Record<PresentationStatus, string> = {
  "needs-you": "bg-warning",
  blocked: "bg-destructive",
  working: "bg-timeline-accent",
  done: "bg-success",
  finished: "bg-muted-foreground",
  waiting: "bg-timeline-accent",
  open: "bg-muted-foreground",
  idle: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
  failed: "bg-destructive",
};

export const toneClasses: Record<FactTone, string> = {
  neutral: "text-foreground",
  positive: "text-success-foreground",
  warning: "text-warning-text",
  negative: "text-destructive",
  info: "text-primary",
  muted: "text-muted-foreground",
};

interface StatusChipProps {
  status: PresentationStatus;
}

export function StatusChip({ status }: StatusChipProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses[status]}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${statusDots[status]}`} />
      {statusLabels[status]}
    </span>
  );
}

export function StaleStatus({ stale }: { stale: boolean }) {
  return stale ? (
    <span className="text-xs text-muted-foreground" role="status">
      Status stale
    </span>
  ) : null;
}

export const phaseLabels: Record<CardPhase, string> = {
  investigate: "Investigate",
  build: "Build",
  test: "Test",
  ship: "Ship",
  done: "Done",
};

const steps: CardPhase[] = ["investigate", "build", "test", "ship"];

interface PhaseLaneProps {
  phase: CardPhase;
  status: PresentationStatus;
  id?: string;
}

export function PhaseLane({ phase, status, id }: PhaseLaneProps) {
  if (phase === "done") return null;

  const current = steps.indexOf(phase);

  return (
    <span
      id={id}
      role="img"
      className="inline-flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs text-muted-foreground"
      aria-label={`Phase: ${phaseLabels[phase]}, step ${current + 1} of ${steps.length}`}
      title={`Phase: ${phaseLabels[phase]}, step ${current + 1} of ${steps.length}`}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
        {steps.map((step, index) => (
          <span
            key={step}
            className={`h-1 w-2.5 rounded-full ${index <= current ? statusDots[status] : "bg-border"}`}
          />
        ))}
      </span>
      <span aria-hidden="true" className="hidden truncate sm:inline">
        {phaseLabels[phase]}
      </span>
    </span>
  );
}

export const readyLabel = "Ready to archive";

export interface NextLine {
  text: string;
  tone: FactTone;
  icon: "Archive" | null;
}

export interface NextSource {
  status: PresentationStatus;
  blocker: string | null;
  next: string | null;
}

const doneLines: Record<Exclude<Readiness, "ready">, NextLine | null> = {
  "not-ready": { text: "Not marked ready to archive yet", tone: "muted", icon: null },
  unavailable: { text: "Archive status unavailable", tone: "muted", icon: null },
  absent: null,
  loading: null,
};

export function nextLines(card: NextSource, readiness: Readiness): NextLine[] {
  if (readiness === "ready") return [{ text: readyLabel, tone: "positive", icon: "Archive" }];

  const lines: NextLine[] = [];

  if (card.status === "blocked" && card.blocker !== null)
    lines.push({ text: card.blocker, tone: "negative", icon: null });

  if (card.next !== null) lines.push({ text: card.next, tone: "neutral", icon: null });
  else if (card.status === "done") {
    const line = doneLines[readiness];

    if (line !== null) lines.push(line);
  }

  return lines;
}

interface RowProps {
  label: string;
  children: ReactNode;
}

export function Row({ label, children }: RowProps) {
  return (
    <>
      <dt className="pt-0.5 text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function GoalRow({ goal }: { goal: string }) {
  return (
    <Row label="Goal">
      <span className="text-muted-foreground">{goal}</span>
    </Row>
  );
}

function ThreadGoalRow({ threadId }: { threadId: string }) {
  const { threads } = experimental_useSidebarThreads();
  const title = threads.find((thread) => thread.id === threadId)?.displayTitle;

  return title === undefined ? null : <GoalRow goal={title} />;
}

interface SummaryRowsProps {
  goal: string | null;
  goalThreadId: string | null;
  headline: string;
  next: NextLine[];
}

export function SummaryRows({ goal, goalThreadId, headline, next }: SummaryRowsProps) {
  return (
    <dl className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5 text-sm">
      {goal !== null ? (
        <GoalRow goal={goal} />
      ) : goalThreadId === null ? null : (
        <ThreadGoalRow threadId={goalThreadId} />
      )}
      <Row label="Now">
        <span className="font-medium">{headline}</span>
      </Row>
      {next.length === 0 ? null : (
        <Row label="Next">
          {next.map((line) => (
            <span
              key={line.text}
              className={`flex min-w-0 items-baseline gap-1.5 ${toneClasses[line.tone]}`}
            >
              {line.icon === null ? null : (
                <Icon
                  name={line.icon}
                  className="size-3.5 shrink-0 translate-y-0.5"
                  aria-hidden="true"
                />
              )}
              <span className="min-w-0">{line.text}</span>
            </span>
          ))}
        </Row>
      )}
    </dl>
  );
}
