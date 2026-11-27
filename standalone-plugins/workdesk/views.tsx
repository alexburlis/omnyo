import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useAppNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { rpcContract, RecordItem } from "./server";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Icon } from "./components/ui/icon";

type Status = "open" | "snoozed" | "done" | "dismissed" | "all";
type Edit = {
  id: string;
  operation: "done" | "dismiss" | "reopen" | "snooze" | "priority" | "seen";
  priority?: number;
  until?: string;
};
const LOCAL_CHANGE = "workdesk:changed";
const OUTCOMES = ["identified", "implemented", "verified", "shipped"] as const;

function useResource<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(() => {
    const id = ++sequence.current;
    setLoading(true);
    return fetcher()
      .then(
        (value) => {
          if (mounted.current && id === sequence.current) {
            setData(value);
            setError("");
          }
        },
        () => {
          if (mounted.current && id === sequence.current)
            setError("Could not load Workdesk. Retry to get current data.");
        },
      )
      .finally(() => {
        if (mounted.current && id === sequence.current) setLoading(false);
      });
  }, [fetcher]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [refresh]);
  useRealtime("changed", refresh);
  useEffect(() => {
    const update = () => void refresh();
    const visible = () => {
      if (document.visibilityState === "visible") update();
    };
    window.addEventListener(LOCAL_CHANGE, update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener(LOCAL_CHANGE, update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { data, error, loading, refresh };
}
function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  return useResource(useCallback(() => rpc.call("overview"), [rpc]));
}
function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function day(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
/** Ages read faster than timestamps when you are scanning a stack. */
function age(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)}d`;
  return day(value);
}
function Chip({
  tone,
  icon,
  children,
}: {
  tone?: "danger" | "warn" | "plain";
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="wd-chip" data-tone={tone}>
      {icon && <Icon name={icon as never} className="size-3" />}
      {children}
    </span>
  );
}
/** identified → implemented → verified → shipped is a real sequence, so show
 *  how far the work got rather than just naming the last step. */
function Outcome({ outcome }: { outcome: RecordItem["outcome"] }) {
  const reached = OUTCOMES.indexOf(outcome);
  return (
    <span className="wd-chip" data-tone="plain">
      <span className="wd-ladder" aria-hidden="true">
        {OUTCOMES.map((step, i) => (
          <span key={step} data-on={i <= reached} />
        ))}
      </span>
      <span className="wd-outcome">{outcome}</span>
    </span>
  );
}
function Select({
  label,
  value,
  quiet,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  quiet?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <span className={`wd-select${quiet ? " wd-select-quiet" : ""}`}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <Icon name="ChevronDown" className="size-3" />
    </span>
  );
}
function SourceLinks({
  item,
  onNavigate,
}: {
  item: RecordItem;
  onNavigate?: () => void;
}) {
  const nav = experimental_useAppNavigate();
  return (
    <div className="wd-sources">
      {item.sources.map((s) =>
        s.deleted ? (
          <span key={s.threadId}>
            <Icon name="Archive" className="size-3" />
            Source deleted <em>{s.title}</em>
          </span>
        ) : (
          <button
            key={s.threadId}
            onClick={() => {
              onNavigate?.();
              nav.toThread(s.threadId);
            }}
          >
            <Icon name="MessageSquare" className="size-3" />
            Open chat <em>{s.title}</em>
            {s.archived ? " · archived" : ""}
            <Icon name="ArrowUpRight" className="size-3" />
          </button>
        ),
      )}
    </div>
  );
}
function BriefNotes({ item }: { item: RecordItem }) {
  const notes = [item.details || item.reason, item.evidence].filter(Boolean);
  const lines = notes.flatMap((note) =>
    note
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean),
  );
  const preview = lines.slice(0, 3).map((line) => {
    if (line.length <= 110) return line;
    const boundary = line.lastIndexOf(" ", 109);
    return line.slice(0, boundary > 60 ? boundary : 109) + "…";
  });
  const expanded = [
    item.reason,
    item.details,
    item.evidence,
    item.resolution?.evidence,
    item.repo,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <ul className="wd-notes">
        {preview.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <details className="wd-full-notes">
        <summary>
          {item.approval ? "Full request & evidence" : "Full notes & evidence"}
        </summary>
        <div className="wd-pre">{expanded}</div>
        {item.resolution && <p>Resolved {when(item.resolution.at)}</p>}
      </details>
    </>
  );
}
function RecordRow({
  item,
  refresh,
  onNavigate,
}: {
  item: RecordItem;
  refresh: () => Promise<void>;
  onNavigate?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [snooze, setSnooze] = useState(false);
  const change = async (edit: Edit) => {
    setPending(true);
    setError("");
    try {
      await rpc.call("edit", edit);
      window.dispatchEvent(new Event(LOCAL_CHANGE));
      await refresh();
    } catch {
      setError("Could not save this change. Try again.");
    } finally {
      setPending(false);
    }
  };
  const decide = async (choice: "approved" | "declined") => {
    setPending(true);
    setError("");
    try {
      await rpc.call("decide", {
        id: item.id,
        revision: item.revision,
        choice,
      });
      window.dispatchEvent(new Event(LOCAL_CHANGE));
      await refresh();
    } catch {
      setError("Could not save. Refresh and review the request.");
    } finally {
      setPending(false);
    }
  };
  const priority = item.userPriority ?? item.priority;
  const isAction = item.kind === "action";
  const overdue = !!item.dueAt && new Date(item.dueAt) < new Date();
  const sleeping =
    !!item.snoozedUntil && new Date(item.snoozedUntil) > new Date();
  return (
    <article
      className={isAction ? "wd-row wd-card" : "wd-row wd-entry"}
      data-priority={isAction ? priority : undefined}
      data-outcome={isAction ? undefined : item.outcome}
      data-important={!isAction && item.important ? "true" : undefined}
      data-resolved={isAction && item.status !== "open" ? "true" : undefined}
    >
      {!isAction && (
        <div className="wd-tick">
          <span className="wd-dot" aria-hidden="true" />
          <time dateTime={item.createdAt}>
            {new Date(item.createdAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </time>
        </div>
      )}
      <div className="wd-body">
        <details>
          <summary>
            <span className="wd-line">
              {isAction && <span className="wd-priority">P{priority}</span>}
              <span className="wd-identity">
                <b>{item.projectName}</b> / {item.area}
              </span>
              <span className="wd-age">{age(item.createdAt)}</span>
            </span>
            <span className="wd-summary">{item.summary}</span>
            <span className="wd-meta">
              {item.approval && <Chip icon="MessageQuestion">Approval</Chip>}
              {!isAction && <Outcome outcome={item.outcome} />}
              {item.important && !item.seenAt && (
                <Chip tone="warn" icon="Star">
                  Important
                </Chip>
              )}
              {item.dueAt && (
                <Chip tone={overdue ? "danger" : undefined} icon="Calendar">
                  {overdue ? "Overdue" : "Due"} {when(item.dueAt)}
                </Chip>
              )}
              {sleeping && (
                <Chip icon="Clock">Snoozed to {when(item.snoozedUntil!)}</Chip>
              )}
              {isAction && item.status !== "open" && (
                <Chip icon={item.status === "done" ? "Check" : "CircleX"}>
                  {item.decision
                    ? item.decision.choice === "approved"
                      ? "Approved"
                      : "Declined"
                    : item.status === "done"
                      ? "Done"
                      : "Dismissed"}
                </Chip>
              )}
              <span className="wd-expand">
                Details
                <Icon name="ChevronDown" className="size-3" />
              </span>
            </span>
          </summary>
          <div className="wd-details">
            <BriefNotes item={item} />
            {item.approval && !item.decision && (
              <p className="wd-decision-help">
                Approve sends to chat. Decline only dismisses.
              </p>
            )}
            <SourceLinks item={item} onNavigate={onNavigate} />
            <span className="wd-timestamps">
              Recorded {when(item.createdAt)}
              {item.updatedAt !== item.createdAt
                ? ` · Updated ${when(item.updatedAt)}`
                : ""}
            </span>
            <div className="wd-controls">
              {isAction && (
                <>
                  <label>
                    Priority
                    <Select
                      label={`Priority for ${item.summary}`}
                      value={priority}
                      disabled={pending}
                      onChange={(value) =>
                        void change({
                          id: item.id,
                          operation: "priority",
                          priority: Number(value),
                        })
                      }
                    >
                      {[0, 1, 2, 3].map((p) => (
                        <option key={p} value={p}>
                          P{p}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {item.status === "open" ? (
                    <>
                      <button
                        className="wd-action"
                        disabled={pending}
                        aria-expanded={snooze}
                        onClick={() => setSnooze(!snooze)}
                      >
                        <Icon name="Clock" className="size-3" />
                        Snooze
                      </button>
                      {!item.approval && (
                        <button
                          className="wd-action"
                          disabled={pending}
                          onClick={() =>
                            void change({ id: item.id, operation: "dismiss" })
                          }
                        >
                          <Icon name="CircleX" className="size-3" />
                          Dismiss
                        </button>
                      )}
                    </>
                  ) : !item.decision ? (
                    <button
                      className="wd-action"
                      disabled={pending}
                      onClick={() =>
                        void change({ id: item.id, operation: "reopen" })
                      }
                    >
                      <Icon name="ArrowTurnBackward" className="size-3" />
                      Reopen
                    </button>
                  ) : null}
                </>
              )}
              {!isAction && item.important && !item.seenAt && (
                <button
                  className="wd-action"
                  disabled={pending}
                  onClick={() =>
                    void change({ id: item.id, operation: "seen" })
                  }
                >
                  <Icon name="Check" className="size-3" />
                  Mark seen
                </button>
              )}
            </div>
            {snooze && (
              <form
                className="wd-snooze"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = new FormData(e.currentTarget).get("until");
                  if (typeof value === "string")
                    void change({
                      id: item.id,
                      operation: "snooze",
                      until: new Date(value).toISOString(),
                    });
                }}
              >
                <label>
                  Snooze until
                  <input
                    required
                    name="until"
                    aria-label="Snooze until"
                    type="datetime-local"
                  />
                </label>
                <Button size="sm" disabled={pending}>
                  Snooze
                </Button>
              </form>
            )}
          </div>
        </details>
        {item.decision?.delivery === "unconfirmed" && (
          <p role="alert" className="wd-error">
            {item.decision.choice === "approved" ? "Approval" : "Decline"}{" "}
            saved; delivery unconfirmed. Check the source chat.
          </p>
        )}
        {error && (
          <p role="alert" className="wd-error">
            {error}
          </p>
        )}
      </div>
      {isAction &&
        item.status === "open" &&
        item.approval &&
        !item.decision && (
          <div className="wd-decisions">
            <button
              className="wd-decision"
              disabled={pending}
              aria-label={`Approve: ${item.summary}`}
              title="Approve this request and resume its chat"
              onClick={() => void decide("approved")}
            >
              <Icon name="Check" className="size-3.5" />
              Approve
            </button>
            <button
              className="wd-decision wd-decline"
              disabled={pending}
              aria-label={`Decline: ${item.summary}`}
              title="Dismiss without messaging or resuming the chat"
              onClick={() => void decide("declined")}
            >
              <Icon name="X" className="size-3.5" />
              Decline
            </button>
          </div>
        )}
      {isAction && item.status === "open" && !item.approval && (
        <button
          className="wd-done"
          aria-label={`Complete: ${item.summary}`}
          title="Mark done"
          disabled={pending}
          onClick={() => void change({ id: item.id, operation: "done" })}
        >
          <Icon name="Check" className="size-3.5" />
        </button>
      )}
    </article>
  );
}
function Records({
  kind,
  project,
  search = "",
  status = "open",
  period = "24",
  from = "",
  to = "",
  importantOnly = false,
  onNavigate,
  refreshKey = 0,
}: {
  kind: "action" | "work";
  project: string;
  search?: string;
  status?: Status;
  period?: string;
  from?: string;
  to?: string;
  importantOnly?: boolean;
  onNavigate?: () => void;
  refreshKey?: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState(0);
  useEffect(
    () => setPage(0),
    [kind, project, search, status, period, from, to, importantOnly],
  );
  const fetcher = useCallback(
    () =>
      rpc.call("list", {
        kind,
        projectId: project,
        search,
        status,
        importantOnly,
        since:
          kind === "work" && !importantOnly
            ? period === "custom"
              ? from
                ? new Date(from).toISOString()
                : null
              : period === "all"
                ? null
                : new Date(Date.now() - Number(period) * 3600000).toISOString()
            : null,
        until: period === "custom" && to ? new Date(to).toISOString() : null,
        offset: page * 50,
        limit: 50,
      }),
    [
      rpc,
      kind,
      project,
      search,
      status,
      period,
      from,
      to,
      importantOnly,
      page,
      refreshKey,
    ],
  );
  const { data, error, loading, refresh } = useResource(fetcher);
  if (error)
    return (
      <div role="alert" className="wd-error">
        {error} <button onClick={() => void refresh()}>Retry</button>
      </div>
    );
  if (!data)
    return (
      <div className="wd-empty" role="status">
        Loading…
      </div>
    );
  const groups: Record<string, RecordItem[]> = {};
  for (const item of data.items) {
    const key =
      kind === "work"
        ? `${item.projectName} · ${new Date(item.createdAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
        : "";
    (groups[key] ??= []).push(item);
  }
  return (
    <div aria-busy={loading}>
      {!data.items.length ? (
        <div className="wd-empty">
          {kind === "action" ? (
            <>
              <b>No actions in this view.</b>
            </>
          ) : (
            <>
              <b>No work recorded in this period.</b>
            </>
          )}
        </div>
      ) : (
        Object.entries(groups).map(([group, items]) => (
          <section key={group}>
            {group && <h3 className="wd-group">{group}</h3>}
            <div className={kind === "action" ? "wd-cards" : "wd-timeline"}>
              {items.map((item) => (
                <RecordRow
                  key={item.id}
                  item={item}
                  refresh={refresh}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </section>
        ))
      )}
      {data.total > 50 && (
        <div className="wd-pagination">
          <Button
            variant="ghost"
            size="sm"
            disabled={!page || loading}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span>
            {page * 50 + 1}–{Math.min((page + 1) * 50, data.total)} of{" "}
            {data.total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={(page + 1) * 50 >= data.total || loading}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
function WorkdeskPage() {
  const { data, error, refresh } = useOverview();
  const nav = experimental_useAppNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [period, setPeriod] = useState("24");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [importantOnly, setImportantOnly] = useState(false);
  const unfiltered = !project && !search && status === "open";
  return (
    <div className="wd-page">
      <div className="wd-container">
        <header className="wd-masthead">
          <div>
            <span className="wd-eyebrow">Workdesk</span>
            <h1 className="wd-title">
              <b>What needs you.</b> <span>What got done.</span>
            </h1>
            <div className="wd-status">
              <span>
                <b>{data?.open ?? "—"}</b> open
              </span>
              <i>·</i>
              <span className={data?.urgent ? "wd-hot" : ""}>
                <b>{data?.urgent ?? "—"}</b> urgent
              </span>
            </div>
          </div>
          <button
            className="wd-refresh"
            onClick={() => {
              setRefreshKey((v) => v + 1);
              void refresh();
            }}
            aria-label="Refresh Workdesk"
          >
            <Icon name="RotateCcw" className="size-4" />
          </button>
        </header>
        {error && (
          <p role="alert" className="wd-error">
            {error}
          </p>
        )}
        <div className="wd-filters">
          <Select label="Project" value={project} onChange={setProject}>
            <option value="">All projects</option>
            {data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <span className="wd-search">
            <Icon name="Search" className="size-3.5" />
            <input
              aria-label="Search actions and work"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </span>
        </div>
        <section className="wd-section">
          <div className="wd-section-head">
            <h2>
              Your actions
              {unfiltered && (
                <span className="wd-count" data-hot={!!data?.urgent}>
                  {data?.open ?? "—"}
                </span>
              )}
            </h2>
            <Select
              label="Action status"
              quiet
              value={status}
              onChange={(value) => setStatus(value as Status)}
            >
              <option value="open">Open</option>
              <option value="snoozed">Snoozed</option>
              <option value="done">Done</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All actions</option>
            </Select>
          </div>
          <Records
            refreshKey={refreshKey}
            kind="action"
            project={project}
            search={search}
            status={status}
          />
        </section>
        <section className="wd-section">
          <div className="wd-section-head">
            <h2>Work ledger</h2>
            <div className="wd-segmented">
              {[
                ["1", "1h"],
                ["24", "24h"],
                ["168", "7d"],
                ["all", "All"],
                ["custom", "Custom"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={period === value && !importantOnly}
                  onClick={() => {
                    setPeriod(value);
                    setImportantOnly(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="wd-lede">
            <span>Outcomes, grouped by project.</span>
            <button
              className="wd-toggle"
              aria-pressed={importantOnly}
              onClick={() => setImportantOnly(!importantOnly)}
            >
              <Icon name="Star" className="size-3" />
              Important
              {data?.important ? (
                <span className="wd-count">{data.important}</span>
              ) : null}
            </button>
          </div>
          {period === "custom" && !importantOnly && (
            <div className="wd-snooze">
              <label>
                From
                <input
                  aria-label="From date"
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  aria-label="To date"
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          )}
          <Records
            refreshKey={refreshKey}
            kind="work"
            project={project}
            search={search}
            period={period}
            from={from}
            to={to}
            importantOnly={importantOnly}
          />
        </section>
        {data && (
          <footer className="wd-footer">
            <span>Since {day(data.startedAt)}</span>
            {data.missing.length > 0 && (
              <details>
                <summary>
                  {data.missing.length}
                  {data.missing.length === 30 ? "+" : ""} chats without a
                  checkpoint
                </summary>
                <ul>
                  {data.missing.map((m) => (
                    <li key={m.threadId}>
                      <button onClick={() => nav.toThread(m.threadId)}>
                        {m.projectName} / {m.title} ↗
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
const OPEN_ACTIONS_EVENT = "workdesk:open-actions";
function SidebarCount() {
  const { data, error } = useOverview();
  return (
    <span
      className={`wd-sidebar-count${data?.urgent ? " wd-urgent-count" : ""}`}
      aria-label={
        error
          ? "Actions unavailable"
          : `${data?.open ?? "Loading"} open actions`
      }
    >
      {error ? "!" : (data?.open ?? "…")}
    </span>
  );
}
function GlobalDrawer() {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const nav = experimental_useAppNavigate();
  useEffect(() => {
    const show = () => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen(true);
    };
    window.addEventListener(OPEN_ACTIONS_EVENT, show);
    return () => window.removeEventListener(OPEN_ACTIONS_EVENT, show);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="wd-drawer"
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogTitle>Your actions</DialogTitle>
        <DialogDescription>
          Only what needs you, across every project.
        </DialogDescription>
        <div className="wd-drawer-list">
          <Records kind="action" project="" onNavigate={() => setOpen(false)} />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setOpen(false);
            nav.toPluginPanel("overview");
          }}
        >
          Open Workdesk <Icon name="ArrowUpRight" className="size-4" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "overview",
    title: "Workdesk",
    icon: "ListTodo",
    path: "overview",
    component: WorkdeskPage,
    experimental_sidebarAccessory: SidebarCount,
  });
  app.slots.sidebarFooterAction({
    id: "actions",
    title: "Your actions",
    icon: "ListTodo",
    run: () => {
      window.dispatchEvent(new Event(OPEN_ACTIONS_EVENT));
    },
  });
  app.slots.experimental_appOverlay({
    id: "actions-drawer",
    component: GlobalDrawer,
  });
});
