import { experimental_Icon as Icon, experimental_useAppNavigate } from "@omnyo/plugin-sdk/app";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { errorFromCatch, type SmError, useSmClient } from "../data/client.js";
import type { HistoryEntry, HistoryKind, LogPage } from "../data/contract.js";
import { useInstance } from "../data/hooks.js";
import {
  Button,
  Dialog,
  ErrorAlert,
  formatAbsolute,
  formatClock,
  Skeleton,
} from "../primitives.js";

const FILTERS: { id: string; label: string; kinds: HistoryKind[] }[] = [
  { id: "transitions", label: "Transitions", kinds: ["transition", "event"] },
  { id: "steps", label: "Steps", kinds: ["step"] },
  { id: "people", label: "Decisions and controls", kinds: ["decision", "control"] },
  { id: "problems", label: "Problems", kinds: ["problem"] },
];

const ALL_KINDS: HistoryKind[] = ["transition", "event", "step", "control", "decision", "problem"];

const KIND_GLYPH: Record<HistoryKind, string> = {
  transition: "ArrowRight",
  event: "Zap",
  step: "Play",
  control: "SlidersHorizontal",
  decision: "UserRound",
  problem: "AlertTriangle",
};

function dayLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);

  if (date.toDateString() === today.toDateString()) return "Today";

  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function InstanceLog({
  instanceId,
  limit = 50,
  compact = false,
}: {
  instanceId: string;
  limit?: number;
  compact?: boolean;
}) {
  const client = useSmClient();
  const [filters, setFilters] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<SmError | null>(null);
  const [olderError, setOlderError] = useState<SmError | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [outputFor, setOutputFor] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const searchId = useId();

  const kinds = useMemo(() => {
    const selected = FILTERS.filter((filter) => filters.includes(filter.id)).flatMap(
      (filter) => filter.kinds,
    );

    return selected.length === 0 ? ALL_KINDS : selected;
  }, [filters]);

  const loadFirst = useCallback(async () => {
    try {
      const page = await client.call("sm_history_list", { instanceId, before: null, limit, kinds });

      setEntries((previous) => {
        if (previous !== null && previous.length > 0) {
          const newest = previous[0]?.seq ?? 0;
          const fresh = page.entries.filter((entry) => entry.seq > newest).length;
          const scrolled = (listRef.current?.closest(".stm-page-body")?.scrollTop ?? 0) > 80;

          if (scrolled && fresh > 0) setNewCount((count) => count + fresh);
        }

        return page.entries;
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      setError(errorFromCatch(caught instanceof Error ? caught : null));
    }
  }, [client, instanceId, kinds, limit]);

  const loadFirstRef = useRef(loadFirst);

  loadFirstRef.current = loadFirst;

  useEffect(() => {
    setEntries(null);
    void loadFirst();
  }, [loadFirst]);

  const instanceUpdatedAt = useInstance(instanceId).updatedAt;

  useEffect(() => {
    if (instanceUpdatedAt !== null) void loadFirstRef.current();
  }, [instanceUpdatedAt]);

  const loadOlder = async () => {
    if (nextCursor === null) return;

    setLoadingOlder(true);

    try {
      const page = await client.call("sm_history_list", {
        instanceId,
        before: nextCursor,
        limit,
        kinds,
      });

      setEntries((previous) => [...(previous ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
      setOlderError(null);
    } catch (caught) {
      setOlderError(errorFromCatch(caught instanceof Error ? caught : null));
    } finally {
      setLoadingOlder(false);
    }
  };

  const visible = (entries ?? []).filter(
    (entry) =>
      search.trim().length === 0 ||
      `${entry.text} ${entry.detail.map((item) => item.value).join(" ")}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );

  const now = Date.now();
  let lastDay = "";

  return (
    <div className="stm-log">
      {compact ? null : (
        <div className="stm-log-filters">
          <div className="stm-toggle-group" role="group" aria-label="Filter events">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className="stm-toggle"
                aria-pressed={filters.includes(filter.id)}
                onClick={() =>
                  setFilters((current) =>
                    current.includes(filter.id)
                      ? current.filter((id) => id !== filter.id)
                      : [...current, filter.id],
                  )
                }
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="stm-sr-only" htmlFor={searchId}>
            Search loaded events
          </label>
          <input
            id={searchId}
            className="stm-input stm-log-search"
            placeholder="Search loaded events"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            icon="ArrowReloadHorizontal"
            ariaLabel="Refresh log"
            onClick={() => void loadFirst()}
          />
        </div>
      )}
      {newCount > 0 ? (
        <button
          type="button"
          className="stm-new-events"
          onClick={() => {
            setNewCount(0);
            listRef.current?.closest(".stm-page-body")?.scrollTo({ top: 0 });
          }}
        >
          {newCount} new event{newCount === 1 ? "" : "s"}
        </button>
      ) : null}
      {error !== null ? <ErrorAlert error={error} onRetry={() => void loadFirst()} /> : null}
      {entries === null && error === null ? <Skeleton rows={compact ? 3 : 8} height={22} /> : null}
      {entries !== null && visible.length === 0 ? (
        <p className="stm-text-sm stm-text-muted">No events yet.</p>
      ) : null}
      <ol ref={listRef} className="stm-log-list">
        {visible.map((entry) => {
          const day = dayLabel(entry.at, now);
          const header = day !== lastDay && !compact ? day : null;

          lastDay = day;

          return <LogRow key={entry.seq} entry={entry} header={header} onOutput={setOutputFor} />;
        })}
      </ol>
      {olderError !== null ? (
        <p className="stm-text-sm">
          Couldn't load older events.{" "}
          <button type="button" className="stm-link" onClick={() => void loadOlder()}>
            Try again
          </button>
        </p>
      ) : null}
      {!compact && nextCursor !== null && olderError === null ? (
        <Button pending={loadingOlder} onClick={() => void loadOlder()}>
          Load older
        </Button>
      ) : null}
      {outputFor === null ? null : (
        <OutputDialog invocationId={outputFor} onClose={() => setOutputFor(null)} />
      )}
    </div>
  );
}

function LogRow({
  entry,
  header,
  onOutput,
}: {
  entry: HistoryEntry;
  header: string | null;
  onOutput(invocationId: string): void;
}) {
  const navigate = experimental_useAppNavigate();
  const [open, setOpen] = useState(entry.problem);
  const detailId = useId();
  const hasDetail = entry.detail.length > 0 || entry.invocationId !== null;

  return (
    <li className={`stm-log-row${entry.problem ? " stm-log-row--problem" : ""}`}>
      {header === null ? null : <div className="stm-log-day">{header}</div>}
      <div className="stm-log-line">
        <time
          className="stm-log-time stm-mono"
          dateTime={formatAbsolute(entry.at)}
          title={formatAbsolute(entry.at)}
        >
          {formatClock(entry.at)}
        </time>
        <Icon
          name={KIND_GLYPH[entry.kind]}
          fallback="Circle"
          aria-hidden
          className="stm-log-glyph"
        />
        <span className="stm-log-text">
          {entry.text}
          {entry.coalescedCount > 1 ? (
            <span className="stm-text-muted"> · {entry.coalescedCount} checks coalesced</span>
          ) : null}
          {entry.disposition === null ? null : (
            <span className="stm-text-muted"> · {entry.disposition}</span>
          )}
        </span>
        <span className="stm-log-actor stm-text-muted">
          {entry.actor.kind === "system"
            ? "system"
            : entry.actor.kind === "client"
              ? "Omnyo client"
              : null}
          {entry.actor.kind === "agent" ? (
            <button
              type="button"
              className="stm-link"
              onClick={() =>
                entry.actor.kind === "agent" &&
                navigate.toThread(entry.actor.threadId, { split: true })
              }
            >
              {entry.actor.title}
            </button>
          ) : null}
        </span>
        {hasDetail ? (
          <button
            type="button"
            className="stm-tool"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "ChevronUp" : "ChevronDown"} aria-hidden />
          </button>
        ) : null}
      </div>
      {open && hasDetail ? (
        <div id={detailId} className="stm-log-detail">
          <dl className="stm-kv">
            {entry.detail.map((item) => (
              <div key={item.label} className="stm-kv-row">
                <dt className="stm-text-muted">{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {entry.invocationId !== null && entry.kind === "step" ? (
            <Button
              icon="FileText"
              onClick={() => entry.invocationId !== null && onOutput(entry.invocationId)}
            >
              Output
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function OutputDialog({ invocationId, onClose }: { invocationId: string; onClose(): void }) {
  const client = useSmClient();
  const [pages, setPages] = useState<LogPage[]>([]);
  const [error, setError] = useState<SmError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (cursor: number) => {
      setLoading(true);

      try {
        const page = await client.call("sm_log_read", { invocationId, cursor, limit: 32768 });

        setPages((previous) => [...previous, page]);
        setError(null);
      } catch (caught) {
        setError(errorFromCatch(caught instanceof Error ? caught : null));
      } finally {
        setLoading(false);
      }
    },
    [client, invocationId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const last = pages.at(-1);
  const text = pages.map((page) => page.text).join("");

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Step output"
      wide
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error === null ? null : (
        <ErrorAlert error={error} onRetry={() => void load(last?.nextCursor ?? 0)} />
      )}
      {pages.length === 0 && loading ? <Skeleton rows={6} height={14} /> : null}
      {pages.length > 0 ? (
        <pre className="stm-output stm-mono">{text.length > 0 ? text : "No output."}</pre>
      ) : null}
      {pages.some((page) => page.truncated) ? (
        <p className="stm-text-sm stm-text-muted">
          Output reached the 1 MiB cap and was truncated.
        </p>
      ) : null}
      {last?.nextCursor != null ? (
        <Button pending={loading} onClick={() => void load(last.nextCursor ?? 0)}>
          Load more
        </Button>
      ) : null}
    </Dialog>
  );
}
