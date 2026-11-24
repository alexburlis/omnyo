import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { experimental_copyToClipboard } from "@omnyo/plugin-sdk/app";
import { InertDraftText } from "./workflow-draft-text.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  countWords,
  formatDraftDay,
  formatWeekRange,
  type WorkflowDraft,
  type WorkflowReview,
} from "./lib/workflow-week.js";

const REVIEW_LABEL: Record<WorkflowReview["outcome"], string> = {
  accepted: "Passed review",
  revise: "Revised after review",
  rejected: "Rejected in review",
};

function draftLabel(draft: WorkflowDraft, index: number) {
  if (draft.date !== null) return formatDraftDay(draft.date).full;

  return draft.name === "output.md" ? "Output" : `Draft ${index + 1}`;
}

function stepLabel(draft: WorkflowDraft | null, fallback: string) {
  return draft?.date ? formatDraftDay(draft.date).weekday : fallback;
}

function DayTab({
  draft,
  index,
  selected,
  panelId,
  tabId,
  onSelect,
  onKeyDown,
  buttonRef,
}: {
  draft: WorkflowDraft;
  index: number;
  selected: boolean;
  panelId: string;
  tabId: string;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const day = draft.date === null ? null : formatDraftDay(draft.date);

  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={selected}
      aria-controls={panelId}
      aria-label={`${draftLabel(draft, index)}${draft.title ? `: ${draft.title}` : ""}`}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-14 shrink-0 snap-start flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-0 sm:flex-1",
        selected
          ? "bg-state-active text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      <span className="text-2xs font-medium uppercase tracking-wide">
        {day?.weekdayShort ?? (draft.name === "output.md" ? "Out" : "Draft")}
      </span>
      <span className="text-lead font-semibold tabular-nums">
        {day?.day ?? index + 1}
      </span>
      <span
        aria-hidden
        className={cn(
          "size-1 rounded-full",
          draft.review === null
            ? "bg-transparent"
            : draft.review.outcome === "rejected"
              ? "bg-destructive"
              : "bg-success",
        )}
      />
    </button>
  );
}

function CopyDraftButton({ draft }: { draft: WorkflowDraft }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setState("idle");
  }, [draft.name]);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);

    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => {
        void experimental_copyToClipboard({ text: draft.content }).then(
          (copied) => setState(copied ? "copied" : "failed"),
        );
      }}
    >
      <Icon
        name={state === "copied" ? "Check" : "Copy"}
        className="size-3.5"
        aria-hidden
      />
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : "Copy draft"}
    </Button>
  );
}

export function WorkflowDraftReader({
  drafts,
  heading,
  subject,
  timezone,
  calendarProblem,
  onDownload,
}: {
  drafts: readonly WorkflowDraft[];
  heading: string;
  subject: string;
  timezone: string | null;
  calendarProblem: string | null;
  onDownload: (draft: WorkflowDraft) => void;
}) {
  const [picked, setPicked] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const index = Math.min(picked, drafts.length - 1);
  const draft = drafts[index];
  const range = formatWeekRange(drafts);
  const words = countWords(draft.body);
  const minutes = Math.max(1, Math.round(words / 220));
  const panelId = `${baseId}-panel`;
  const tabId = (position: number) => `${baseId}-tab-${position}`;
  const hasDates = drafts.some((item) => item.date !== null);

  function move(next: number) {
    const target = (next + drafts.length) % drafts.length;
    setPicked(target);
    tabs.current[target]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(index + 1),
      ArrowDown: () => move(index + 1),
      ArrowLeft: () => move(index - 1),
      ArrowUp: () => move(index - 1),
      Home: () => move(0),
      End: () => move(drafts.length - 1),
    };

    const handler = keys[event.key];

    if (!handler) return;
    event.preventDefault();
    handler();
  }

  const previous = index > 0 ? drafts[index - 1] : null;
  const next = index < drafts.length - 1 ? drafts[index + 1] : null;

  return (
    <section
      aria-labelledby={`${baseId}-heading`}
      className="@container/reader overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-col gap-1 border-b border-border px-4 pb-3 pt-4 sm:px-6">
        <p className="truncate text-xs text-muted-foreground">{subject}</p>
        <h2
          id={`${baseId}-heading`}
          className="text-lead font-semibold text-foreground"
        >
          {heading}
        </h2>
        <p className="text-xs text-muted-foreground">
          {[
            range,
            `${drafts.length} reviewed ${drafts.length === 1 ? "draft" : "drafts"}`,
            timezone,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {calendarProblem && (
          <p
            role="status"
            className="mt-1 flex items-center gap-1.5 text-xs text-warning-text"
          >
            <Icon name="AlertCircle" className="size-3.5" aria-hidden />
            {calendarProblem} Drafts are shown in file order.
          </p>
        )}
      </header>
      {drafts.length > 1 && (
        <div
          role="tablist"
          aria-label={hasDates ? "Delivery days" : "Drafts"}
          aria-orientation="horizontal"
          className="flex snap-x gap-1 overflow-x-auto border-b border-border px-3 py-2 sm:px-5"
        >
          {drafts.map((item, position) => (
            <DayTab
              key={item.name}
              draft={item}
              index={position}
              selected={position === index}
              panelId={panelId}
              tabId={tabId(position)}
              onSelect={() => setPicked(position)}
              onKeyDown={onKeyDown}
              buttonRef={(element) => {
                tabs.current[position] = element;
              }}
            />
          ))}
        </div>
      )}
      <article
        id={panelId}
        role={drafts.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={drafts.length > 1 ? tabId(index) : undefined}
        className="px-4 py-6 sm:px-6 @[48rem]/reader:px-10"
      >
        <div className="mx-auto max-w-prose">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {draftLabel(draft, index)}
            </p>
            <div className="-mr-2 flex items-center gap-1">
              <CopyDraftButton draft={draft} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onDownload(draft)}
              >
                <Icon name="Download" className="size-3.5" aria-hidden />
                Download
              </Button>
            </div>
          </div>
          {draft.title && (
            <h3 className="mt-2 font-serif text-2xl leading-tight text-foreground text-balance">
              {draft.title}
            </h3>
          )}
          <p className="mt-2 text-xs text-subtle-foreground">
            {words} {words === 1 ? "word" : "words"} · {minutes} min read
          </p>
          {draft.body ? (
            <InertDraftText
              source={draft.body}
              className="mt-5 text-prose text-foreground"
            />
          ) : (
            <p className="mt-5 text-sm text-muted-foreground">
              This draft has no body text.
            </p>
          )}
          {draft.review?.research && (
            <aside aria-label="Draft research" className="mt-8 space-y-1">
              <h4 className="text-sm font-medium">OpenSEO keyword</h4>
              <p className="break-words text-sm">
                {draft.review.research.keyword}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {draft.review.research.site} · Retrieved into Omnyo{" "}
                <time dateTime={draft.review.research.retrievedAt}>
                  {draft.review.research.retrievedAt.slice(0, 10)} UTC
                </time>
              </p>
            </aside>
          )}
          {draft.review && (
            <aside
              aria-label="Reviewer note"
              className="mt-8 rounded-lg border border-border bg-background/60 px-4 py-3"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Icon
                  name={
                    draft.review.outcome === "rejected"
                      ? "CircleX"
                      : "CircleCheck"
                  }
                  className={cn(
                    "size-3.5",
                    draft.review.outcome === "rejected"
                      ? "text-destructive"
                      : "text-success",
                  )}
                  aria-hidden
                />
                {REVIEW_LABEL[draft.review.outcome]}
              </p>
              {draft.review.reason && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {draft.review.reason}
                </p>
              )}
            </aside>
          )}
          {drafts.length > 1 && (
            <nav
              aria-label="Draft navigation"
              className="mt-8 flex items-center justify-between gap-2 border-t border-border pt-4"
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={previous === null}
                aria-label={
                  previous === null
                    ? "Previous draft"
                    : `Previous: ${draftLabel(previous, index - 1)}`
                }
                onClick={() => setPicked(index - 1)}
                className="-ml-3 min-w-0"
              >
                <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
                <span className="truncate">
                  {stepLabel(previous, "Previous")}
                </span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={next === null}
                aria-label={
                  next === null
                    ? "Next draft"
                    : `Next: ${draftLabel(next, index + 1)}`
                }
                onClick={() => setPicked(index + 1)}
                className="-mr-3 min-w-0"
              >
                <span className="truncate">{stepLabel(next, "Next")}</span>
                <Icon name="ChevronRight" className="size-3.5" aria-hidden />
              </Button>
            </nav>
          )}
        </div>
      </article>
    </section>
  );
}
