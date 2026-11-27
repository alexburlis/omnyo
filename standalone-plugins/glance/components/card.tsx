import { useId, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useThreadActions,
  Markdown,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import type { Card, CardChange, CardDiff, CardView, ProofLink } from "../contract";
import { useChatCard, useMarkSeen, type LoadedCard, type WorkCard } from "./chat-card";
import { type CardPresentation } from "./presentation";
import type { Readiness } from "./readiness";
import {
  nextLines,
  PhaseLane,
  readyLabel,
  StatusChip,
  StaleStatus,
  SummaryRows,
  toneClasses,
} from "./shared";
import { ProjectImagePreview } from "./project-image";
import { Button, buttonClass } from "./ui/button";
import { StatusBadge, type StatusTone } from "./ui/status-row";
import { readGlanceExpansion, writeGlanceExpansion } from "../lib/expansion-storage";
import { useCompactViewport } from "./viewport";

interface ChangeListProps {
  diff: CardDiff;
}

function hasChanges(diff: CardDiff | null): diff is CardDiff {
  return diff !== null && (diff.changes.length > 0 || diff.newReplies > 0 || diff.moreActivity);
}

function ChangeHistory({ diff }: ChangeListProps) {
  if (!hasChanges(diff)) return null;

  return (
    <section className="space-y-1.5" aria-label="Since you last looked">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        Since you last looked
      </h3>
      {diff.newReplies === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {diff.newReplies} new {diff.newReplies === 1 ? "reply" : "replies"}
        </p>
      )}
      {diff.moreActivity ? (
        <p className="text-xs text-muted-foreground">More activity available</p>
      ) : null}
      <dl className="space-y-1.5 text-sm">
        {diff.changes.map((change: CardChange) => (
          <div key={`${change.field}:${change.label}`}>
            <dt className="text-xs text-muted-foreground">{change.label}</dt>
            <dd className="break-words">
              {change.before === null ? (
                <>New: {change.after}</>
              ) : change.after === null ? (
                <span className="text-muted-foreground">Removed: {change.before}</span>
              ) : (
                <>
                  <span className="text-muted-foreground">{change.before}</span>
                  <span aria-label="changed to"> → </span>
                  <span>{change.after}</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface ProofRowProps {
  entry: Card["proof"][number];
  link: ProofLink | undefined;
}

const proofKinds = {
  reproduced: { label: "Reproduced", tone: "success", explain: "Seen directly by running it" },
  inspected: { label: "Inspected", tone: "neutral", explain: "Established by reading the code" },
  hypothesis: { label: "Hypothesis", tone: "warning", explain: "Not proven yet" },
} satisfies Record<
  Card["proof"][number]["kind"],
  { label: string; tone: StatusTone; explain: string }
>;

function ProofRow({ entry, link }: ProofRowProps) {
  const kind = proofKinds[entry.kind];

  return (
    <details className="group rounded-lg border border-border text-sm open:bg-surface-recessed">
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-state-hover [&::-webkit-details-marker]:hidden">
        <Icon
          name="ChevronRight"
          className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <span title={kind.explain} className="shrink-0">
          <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>
        </span>{" "}
        <span className="min-w-0 break-words">{entry.claim}</span>
      </summary>
      <div className="space-y-2 px-2.5 pb-2.5 pl-8">
        {link?.linked ? (
          <>
            <p
              className={
                link.exitCode !== null && link.exitCode !== 0
                  ? "text-xs text-destructive-text"
                  : "text-xs text-muted-foreground"
              }
            >
              Event {link.eventSeq}
              {link.status === null ? "" : ` · ${link.status}`}
              {link.exitCode === null ? "" : ` · Exit ${link.exitCode}`}
            </p>
            {link.command === null ? null : (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised-solid px-2 py-1.5 font-mono text-xs">
                {link.command}
              </pre>
            )}
            {link.cwd === null ? null : (
              <p className="break-all text-xs text-muted-foreground">{link.cwd}</p>
            )}
            {link.excerptUnavailable ? (
              <p className="text-xs text-muted-foreground">Output excerpt unavailable.</p>
            ) : link.excerpt === null || link.excerpt === "" ? (
              <p className="text-xs text-muted-foreground">No text output.</p>
            ) : (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised-solid px-2 py-1.5 font-mono text-xs">
                {link.excerpt}
              </pre>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Not linked</p>
            {entry.command === undefined ? null : (
              <pre className="whitespace-pre-wrap break-words text-xs">{entry.command}</pre>
            )}
          </>
        )}
        {entry.ref === undefined ? null : (
          <p className="break-words text-xs text-muted-foreground">{entry.ref}</p>
        )}
      </div>
    </details>
  );
}

function escapeLinkTitle(title: string) {
  return title.replace(/[\\[\]]/gu, "\\$&");
}

function CardFacts({ card }: { card: Card }) {
  if (card.facts.length === 0) return null;

  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2" aria-label="Facts">
      {card.facts.map((fact) => (
        <div key={fact.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{fact.label}</dt>
          <dd className={`break-words ${toneClasses[fact.tone]}`}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CardDeliverables({ card }: { card: Card }) {
  if (card.deliverables.length === 0) return null;

  return (
    <section className="space-y-1.5" aria-label="Deliverables">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        Deliverables
      </h3>
      {card.deliverables.map((deliverable) => (
        <div
          key={`${deliverable.title}:${deliverable.href}`}
          className="min-w-0 break-words text-sm"
        >
          <Markdown content={`[${escapeLinkTitle(deliverable.title)}](<${deliverable.href}>)`} />
          {deliverable.meta === undefined ? null : (
            <p className="text-xs text-muted-foreground">{deliverable.meta}</p>
          )}
          {deliverable.preview === undefined ? null : (
            <ProjectImagePreview
              key={`${deliverable.preview.projectId}:${deliverable.preview.path}`}
              image={deliverable.preview}
              title={deliverable.title}
            />
          )}
        </div>
      ))}
    </section>
  );
}

function CardEvidence({ view }: { view: CardView }) {
  if (view.card.proof.length === 0) return null;

  return (
    <section className="space-y-1.5" aria-label="Evidence">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        Evidence
      </h3>
      {view.card.proof.map((entry, index) => (
        <ProofRow
          key={index}
          entry={entry}
          link={view.proofs.find((link) => link.index === index)}
        />
      ))}
    </section>
  );
}

function detailCounts(card: Card) {
  return [
    { label: "Facts", count: card.facts.length },
    { label: "Files", count: card.deliverables.length },
    { label: "Evidence", count: card.proof.length },
  ].filter((part) => part.count > 0);
}

interface CardDetailsProps {
  view: CardView;
  diff: CardDiff | null;
  changed: boolean;
  presentation: CardPresentation;
}

export function CardDetails({ view, diff, changed, presentation }: CardDetailsProps) {
  const card = view.card;
  const detailsId = useId();
  const [details, setDetails] = useState(false);
  const counts = detailCounts(card);
  const changes = hasChanges(diff);
  const previousUpdate = presentation.lastReported !== null;

  if (counts.length === 0 && !changes && !previousUpdate) return null;

  return (
    <>
      <button
        type="button"
        aria-expanded={details}
        aria-controls={detailsId}
        className="-mx-1 mt-2 flex min-h-6 cursor-pointer flex-wrap items-center gap-x-1.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        onClick={() => setDetails(!details)}
      >
        <Icon
          name={details ? "ChevronDown" : "ChevronRight"}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="font-medium">Details</span>
        {counts.map((part) => (
          <span key={part.label} className="whitespace-nowrap text-subtle-foreground">
            · {part.label} {part.count}
          </span>
        ))}
        {changes && changed ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-primary">
            <span aria-hidden="true">·</span>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            Changed
          </span>
        ) : null}
      </button>
      <div id={detailsId} hidden={!details}>
        {details ? (
          <div className="mt-2 space-y-3 border-t border-border pt-2.5">
            {previousUpdate ? (
              <section aria-label="Last reported" className="space-y-1.5 text-sm">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
                  Last reported
                </h3>
                <p className="break-words text-muted-foreground">
                  {presentation.lastReported?.headline}
                </p>
                {presentation.lastReported?.next ? (
                  <p className="break-words text-muted-foreground">
                    {presentation.lastReported.next}
                  </p>
                ) : null}
              </section>
            ) : null}
            <CardFacts card={card} />
            <CardDeliverables card={card} />
            <CardEvidence view={view} />
            {diff === null ? null : <ChangeHistory diff={diff} />}
          </div>
        ) : null}
      </div>
    </>
  );
}

interface CardBodyProps {
  view: CardView;
  diff: CardDiff | null;
  readiness: Readiness;
  changed: boolean;
  presentation: CardPresentation;
  complete: boolean;
}

function CardBody({ view, diff, readiness, changed, presentation, complete }: CardBodyProps) {
  return (
    <div className="max-h-[45vh] overflow-y-auto px-3 pb-2.5 pt-2">
      <SummaryRows
        goal={view.card.goal ?? null}
        goalThreadId={view.threadId}
        headline={presentation.headline}
        next={complete ? [] : nextLines(presentation, readiness)}
      />
      <CardDetails view={view} diff={diff} changed={changed} presentation={presentation} />
    </div>
  );
}

function isAttention(card: CardPresentation) {
  return card.status === "needs-you" || card.status === "blocked";
}

interface FreshnessProps {
  card: LoadedCard;
  current: boolean;
  loading: boolean;
  id?: string;
}

export function Freshness({ card, current, loading, id }: FreshnessProps) {
  return (
    <span
      id={id}
      className={`inline-flex shrink-0 items-center gap-1 ${card.changed ? "text-primary" : "text-muted-foreground"}`}
      title={card.freshness}
    >
      {card.changed ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
      ) : null}
      <span aria-hidden="true">
        {!current ? (
          loading ? (
            "Checking…"
          ) : (
            "Update unavailable"
          )
        ) : card.view.staleSince === null ? (
          <>
            <span className="hidden sm:inline">Updated </span>
            {card.age}
          </>
        ) : (
          "Chat moved on"
        )}
      </span>
      <span className="sr-only">
        {card.changed ? "Updated since you last looked. " : ""}
        {card.freshness}
      </span>
    </span>
  );
}

export function LastLoaded({ current, loading }: { current: boolean; loading: boolean }) {
  if (current) return null;

  return (
    <p role="status" className="sr-only">
      {loading
        ? "Last loaded card · checking for updates…"
        : "Last loaded card · latest version unavailable"}
    </p>
  );
}

interface CardAlertProps {
  error: string | null;
  seenError: boolean;
  refresh: () => void;
  className: string;
}

export function CardAlert({ error, seenError, refresh, className }: CardAlertProps) {
  if (error === null && !seenError) return null;

  return (
    <div
      role="alert"
      className={`flex min-w-0 items-center gap-2 text-xs text-destructive-text ${className}`}
    >
      <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{error ?? "Glance could not save your read position."}</span>
      <Button onClick={refresh}>Retry</Button>
    </div>
  );
}

export function NotReadyButton({
  thread,
  compact = false,
  quiet = false,
}: {
  thread: PluginSidebarThread;
  compact?: boolean;
  quiet?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action = experimental_useThreadActions(
    {
      ...thread,
      shelvedAt: thread.experimental_shelvedAt,
      environment: thread.environment?.id
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
    },
    { keys: ["glance/not-ready"] },
  )[0]?.action;

  if (action === undefined) return null;

  return (
    <span className="inline-flex min-w-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label="Not ready to archive"
        title={
          compact || quiet
            ? "Not ready: hide this suggestion until the chat gets new input"
            : undefined
        }
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);

          try {
            await action.run();
          } catch {
            setError("Could not dismiss archive suggestion. Try again.");
          } finally {
            setBusy(false);
          }
        }}
        className={
          quiet
            ? buttonClass("ghost", "xs")
            : "inline-flex min-h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        }
      >
        {quiet ? (
          "Not ready"
        ) : compact ? (
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        ) : (
          "Not ready to archive"
        )}
      </button>
      {error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

export function ArchiveButton({
  thread,
  compact = false,
  quiet = false,
}: {
  thread: PluginSidebarThread;
  compact?: boolean;
  quiet?: boolean;
}) {
  const pending = useRef(false);

  const archive = experimental_useThreadActions(
    {
      ...thread,
      shelvedAt: thread.experimental_shelvedAt,
      environment: thread.environment?.id
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
    },
    { keys: ["omnyo--core/archive"] },
  )[0]?.action;

  return (
    <button
      type="button"
      disabled={archive === undefined}
      aria-label="Archive"
      title={
        compact ? "Archive" : quiet ? "Archive this chat. You can unarchive it later." : undefined
      }
      onClick={() => {
        if (archive === undefined || pending.current) return;
        pending.current = true;
        void archive.run();
      }}
      className={
        quiet
          ? buttonClass("soft", "xs")
          : "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
      }
    >
      <Icon name="Archive" className="size-3.5" aria-hidden="true" />
      {compact && !quiet ? null : "Archive"}
    </button>
  );
}

function NextHint({ next }: { next: string }) {
  return (
    <span
      className="hidden max-w-[35%] shrink-0 truncate text-muted-foreground sm:inline"
      title={`Next: ${next}`}
    >
      Next: {next}
    </span>
  );
}

function WorkStrip({ card, showArchiveAction }: { card: WorkCard; showArchiveAction: boolean }) {
  const { work, thread, ready, presentation, stale } = card;
  const next = presentation.next ?? "";
  const readyToArchive = ready && showArchiveAction;
  const archivable = readyToArchive && thread !== undefined && !thread.isArchived;

  return (
    <section
      data-glance-work={work.primary.label}
      aria-label="Chat status"
      className="flex min-h-8 min-w-0 grow basis-64 items-center gap-2 rounded-lg border border-border bg-surface-raised-solid py-1.5 pr-2 pl-3 text-xs"
    >
      <StatusChip status={presentation.status} />
      <StaleStatus stale={stale} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={presentation.headline}>
        {presentation.headline}
      </span>
      {readyToArchive || next === "" ? null : <NextHint next={next} />}
      {archivable ? (
        <span className="shrink-0" role="group" aria-label={readyLabel}>
          <NotReadyButton thread={thread} />
          <ArchiveButton thread={thread} />
        </span>
      ) : null}
    </section>
  );
}

interface GlanceCardProps {
  threadId: string;
  showArchiveAction?: boolean;
}

export function GlanceCard({ threadId, showArchiveAction = true }: GlanceCardProps) {
  const pluginId = experimental_usePluginId();

  const [expansion, setExpansion] = useState(() =>
    readGlanceExpansion(sessionStorage, pluginId, threadId),
  );

  const { source, card } = useChatCard(threadId);
  const seenError = useMarkSeen(threadId, source, true);
  const { diff, error, refresh, current, loading } = source;
  const bodyId = useId();
  const lineId = useId();
  const readyId = useId();
  const phaseId = useId();
  const freshnessId = useId();
  const compact = useCompactViewport();

  if (card.kind === "hidden") return null;

  if (card.kind === "work") return <WorkStrip card={card} showArchiveAction={showArchiveAction} />;

  if (card.kind === "failed")
    return (
      <div
        className="flex min-h-8 grow basis-64 items-center gap-2 rounded-lg border border-border bg-surface-raised-solid py-1 pr-1 pl-3 text-xs text-destructive-text"
        role="alert"
      >
        <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{card.error}</span>
        <Button onClick={refresh}>Retry</Button>
      </div>
    );

  const { view, presentation, readiness, archive, changed, line, freshness } = card;
  const ready = readiness === "ready";
  const complete = archive !== null;
  const attention = isAttention(presentation);

  const open =
    expansion !== null && (!attention || expansion.revision === view.revision)
      ? expansion.open
      : attention;

  const setOpen = (next: boolean) => {
    const saved = writeGlanceExpansion(sessionStorage, pluginId, threadId, {
      revision: view.revision,
      open: next,
    });

    setExpansion(saved);
  };

  return (
    <section
      data-glance-card=""
      data-glance-complete={complete || undefined}
      className={`min-w-0 overflow-hidden rounded-lg border border-border bg-surface-raised-solid ${open ? "basis-full" : "grow basis-64"}`}
    >
      <LastLoaded current={current} loading={loading} />
      <StaleStatus stale={card.stale} />
      {archive !== null ? (
        <div className="flex min-w-0 items-center gap-3 py-2 pr-2 pl-3">
          <button
            type="button"
            aria-label="Chat card"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-describedby={`${lineId} ${readyId} ${freshnessId}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setOpen(!open)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-background">
              <Icon name="Check" className="size-3" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                id={lineId}
                className="block whitespace-normal break-words text-sm font-medium max-md:truncate"
                title={line}
              >
                {line}
              </span>
              {open || compact || presentation.headline === line ? null : (
                <span
                  className="block whitespace-normal break-words text-xs text-muted-foreground"
                  title={presentation.headline}
                >
                  {presentation.headline}
                </span>
              )}
            </span>
            <span id={readyId} className="sr-only">
              {readyLabel}
            </span>
            <span id={freshnessId} className="sr-only">
              {freshness}
            </span>
          </button>

          {showArchiveAction ? (
            <>
              <NotReadyButton thread={archive} compact={compact} />
              <ArchiveButton thread={archive} compact={compact} />
            </>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          aria-label="Chat card"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={
            open
              ? `${phaseId} ${freshnessId}`
              : `${lineId}${ready ? ` ${readyId}` : ""} ${freshnessId}`
          }
          className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-state-hover focus-visible:bg-state-hover"
          onClick={() => setOpen(!open)}
        >
          <StatusChip status={presentation.status} />

          {open ? (
            <span className="flex min-w-0 flex-1 overflow-hidden">
              <PhaseLane id={phaseId} phase={view.card.phase} status={presentation.status} />
            </span>
          ) : (
            <>
              <span
                id={lineId}
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={line}
              >
                {line}
              </span>
              {ready || presentation.next === null ? null : <NextHint next={presentation.next} />}
              {ready ? (
                <span
                  id={readyId}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 font-medium text-success-foreground"
                >
                  <Icon name="Archive" className="size-3" aria-hidden="true" />
                  <span className="hidden sm:inline">{readyLabel}</span>
                  <span className="sr-only sm:hidden">{readyLabel}</span>
                </span>
              ) : null}
            </>
          )}
          <Freshness id={freshnessId} card={card} current={current} loading={loading} />
          <Icon
            name={open ? "ChevronUp" : "ChevronDown"}
            className="size-3.5 shrink-0 text-subtle-foreground"
            aria-hidden="true"
          />
        </button>
      )}
      <CardAlert error={error} seenError={seenError} refresh={refresh} className="px-3 pb-2" />
      <div id={bodyId} hidden={!open} className="border-t border-border">
        {open ? (
          <CardBody
            view={view}
            diff={diff}
            readiness={readiness}
            changed={changed}
            presentation={presentation}
            complete={complete}
          />
        ) : null}
      </div>
    </section>
  );
}
