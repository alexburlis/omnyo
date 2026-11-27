import { useState } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  experimental_useAppNavigate,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import { useIndex } from "./data";
import { useReadinessMap } from "./readiness";
import { nextLines, PhaseLane, readyLabel, statusDots, statusLabels, SummaryRows } from "./shared";
import { useInboxStates } from "./inbox-views";
import { cardPresentation, type PresentationStatus } from "./presentation";
import { ProjectImagePreview } from "./project-image";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { FOCUS_RING_CLASS } from "./ui/focus-ring";
import { CollapsibleSection } from "./ui/section";

const groups: PresentationStatus[] = [
  "needs-you",
  "blocked",
  "failed",
  "working",
  "waiting",
  "open",
  "idle",
  "unknown",
  "finished",
  "done",
];

const groupDescriptions: Partial<Record<PresentationStatus, string>> = {
  "needs-you": "Waiting for your answer or approval",
  blocked: "Stuck until something outside the chat changes",
  failed: "Stopped with an error",
  working: "An agent is working on these now",
  waiting: "Paused on a wait, a queue or another machine",
  done: "Reported complete or ready to archive",
};

const collapsedSchema = z.array(z.string());

function useCollapsedGroups() {
  const pluginId = experimental_usePluginId();
  const key = `omnyo:${pluginId}:page-collapsed`;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed = collapsedSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "[]"));

      return new Set(parsed.success ? parsed.data : []);
    } catch {
      return new Set();
    }
  });

  const toggle = (status: string, open: boolean) => {
    const next = new Set(collapsed);

    if (open) next.delete(status);
    else next.add(status);
    setCollapsed(next);
    localStorage.setItem(key, JSON.stringify([...next]));
  };

  return { collapsed, toggle };
}

function relativeTime(timestamp: number) {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);

  if (minutes === 0) return "Just now";

  if (minutes < 60) return `${minutes}m ago`;

  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;

  return `${Math.floor(minutes / 1440)}d ago`;
}

export function GlancePage() {
  const { cards, error, refresh } = useIndex();
  const sidebar = experimental_useSidebarThreads();
  const serverViews = useInboxStates();
  const navigate = experimental_useAppNavigate();
  const [zoom, setZoom] = useState<"lines" | "cards">("lines");
  const { collapsed, toggle } = useCollapsedGroups();
  const threads = new Map<string, PluginSidebarThread>();

  for (const thread of sidebar.threads) {
    if (!thread.isArchived && !thread.isHidden) threads.set(thread.id, thread);
  }

  const activeCards = cards?.filter((card) => threads.has(card.threadId)) ?? [];

  const hasCard = new Set(activeCards.map((card) => card.threadId));
  const readinessOf = useReadinessMap(threads);

  const withoutCard = Array.from(threads.keys()).filter(
    (threadId) => !hasCard.has(threadId),
  ).length;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-5">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lead font-semibold">Glance</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Where every open chat stands, grouped by what it needs.
            </p>
          </div>
          <div
            role="group"
            aria-label="Zoom"
            className="flex shrink-0 gap-0.5 rounded-lg bg-surface-recessed p-0.5"
          >
            {(["lines", "cards"] as const).map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={zoom === level}
                onClick={() => setZoom(level)}
                className={cn(
                  "h-7 cursor-pointer rounded-md px-3 text-xs font-medium transition-colors duration-(--motion-duration-fast)",
                  FOCUS_RING_CLASS,
                  zoom === level
                    ? "bg-surface-raised-solid text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {level === "lines" ? "Lines" : "Cards"}
              </button>
            ))}
          </div>
        </div>
        {error !== null || sidebar.status === "error" ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-recessed py-2 pr-2 pl-3 text-sm text-destructive-text"
          >
            <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {error ?? "Chat details are unavailable. Reload the page to retry."}
            </span>
            {error === null ? null : (
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            )}
          </div>
        ) : cards === null || sidebar.status === "loading" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading chat cards…
          </p>
        ) : (
          <>
            {activeCards.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
                <Icon name="Target" className="size-5 text-subtle-foreground" aria-hidden="true" />
                <p className="text-sm font-medium">No chat cards yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  A card appears here once an agent reports where its chat stands.
                </p>
              </div>
            ) : null}
            {groups.map((status) => {
              const entries = activeCards
                .filter(
                  (card) =>
                    cardPresentation(
                      card,
                      threads.get(card.threadId),
                      undefined,
                      serverViews.get(card.threadId) ?? null,
                    ).status === status,
                )
                .toSorted((a, b) => b.updatedAt - a.updatedAt);

              if (entries.length === 0) return null;

              return (
                <CollapsibleSection
                  key={status}
                  title={statusLabels[status]}
                  count={entries.length}
                  countLabel={`${entries.length} ${entries.length === 1 ? "chat" : "chats"}`}
                  description={groupDescriptions[status]}
                  leading={
                    <span
                      aria-hidden="true"
                      className={`size-1.5 shrink-0 rounded-full ${statusDots[status]}`}
                    />
                  }
                  open={!collapsed.has(status)}
                  onOpenChange={(open) => toggle(status, open)}
                >
                  <ul className="space-y-2 pt-1.5 pb-0.5">
                    {entries.map((card) => {
                      const thread = threads.get(card.threadId);

                      if (thread === undefined) return null;

                      const presentation = cardPresentation(
                        card,
                        thread,
                        undefined,
                        serverViews.get(card.threadId) ?? null,
                      );

                      const readiness = readinessOf(card.threadId);

                      const ready =
                        readiness === "ready" &&
                        (serverViews.get(card.threadId)?.archiveReady ?? true);

                      return (
                        <li key={card.threadId}>
                          <a
                            href={thread.href}
                            data-glance-thread={card.threadId}
                            className={cn(
                              "block min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors duration-(--motion-duration-fast) hover:border-input hover:bg-state-hover",
                              FOCUS_RING_CLASS,
                            )}
                            onClick={(event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              )
                                return;
                              event.preventDefault();
                              navigate.toThread(card.threadId);
                            }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {presentation.status === "done" && card.sidebarSummary !== null
                                  ? card.sidebarSummary
                                  : presentation.headline}
                              </span>
                              {ready ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-xs font-medium text-success-foreground">
                                  <Icon name="Archive" className="size-3" aria-hidden="true" />
                                  {readyLabel}
                                </span>
                              ) : (
                                <PhaseLane phase={card.phase} status={presentation.status} />
                              )}
                              {card.unseen ? (
                                <span
                                  role="img"
                                  className="size-2 shrink-0 rounded-full bg-timeline-accent"
                                  aria-label="Changed since you last looked"
                                  title="Changed since you last looked"
                                />
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                              <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
                              {card.stale ? (
                                <span className="text-warning-text">Chat moved on</span>
                              ) : null}
                              <time dateTime={new Date(card.updatedAt).toISOString()}>
                                {relativeTime(card.updatedAt)}
                              </time>
                            </div>
                            {zoom === "lines" ? null : (
                              <div className="mt-2.5 border-t border-border pt-2.5">
                                <SummaryRows
                                  goal={card.goal}
                                  goalThreadId={null}
                                  headline={presentation.headline}
                                  next={nextLines(presentation, readiness)}
                                />
                                {presentation.lastReported === null ? null : (
                                  <section
                                    aria-label="Last reported"
                                    className="mt-2 text-xs text-muted-foreground"
                                  >
                                    <h3>Last reported</h3>
                                    <p>{presentation.lastReported.headline}</p>
                                    {presentation.lastReported.next === null ? null : (
                                      <p>{presentation.lastReported.next}</p>
                                    )}
                                  </section>
                                )}
                              </div>
                            )}
                          </a>
                          {zoom === "cards" && card.visuals.length > 0 ? (
                            <div
                              className="grid gap-3 border-x border-b border-border px-3 py-2 sm:grid-cols-2"
                              aria-label="Visual deliverables"
                            >
                              {card.visuals.map((visual) => (
                                <ProjectImagePreview
                                  key={`${visual.preview.projectId}:${visual.preview.path}`}
                                  image={visual.preview}
                                  title={visual.title}
                                />
                              ))}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleSection>
              );
            })}
            <p className="text-center text-xs text-muted-foreground">
              {withoutCard} active {withoutCard === 1 ? "chat" : "chats"} without a card
            </p>
          </>
        )}
      </div>
    </div>
  );
}
