import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  definePluginApp,
  experimental_usePluginId,
  experimental_useAppNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import {
  CHANGED,
  dimensionSchema,
  dimensions,
  type Dimension,
  type Filters,
  type Group,
  type Report,
  type ReportInput,
  type SpeedGroup,
  type Summary,
  type rpcContract,
} from "./contract";
import { Button } from "./components/ui/button";
import { StatsSummary } from "./components/stats-summary";
import { StatsOverview } from "./components/stats-overview";
import { StatsSpeed } from "./components/stats-speed";
import { StatsHealth } from "./components/stats-health";
import { StatsSkeleton } from "./components/stats-skeleton";
import { waitForStatsStyles } from "./components/stats-styles";
import { dimensionLabels, downloadReport, groupLabel, timestamp } from "./components/stats-format";
import "./app.css";

interface StatsPanelProps {
  subPath: string;
}

interface ReportState {
  key: string;
  report: Report;
  groupBy: Dimension;
  offset: number;
}

interface RangeOption {
  key: ReportInput["range"];
  label: string;
}

const ranges: RangeOption[] = [
  { key: "hour", label: "Last hour" },
  { key: "day", label: "24 hours" },
  { key: "week", label: "7 days" },
  { key: "month", label: "30 days" },
  { key: "year", label: "1 year" },
  { key: "all", label: "All time" },
];

const signalSchema = z.object({ live: z.boolean(), data: z.boolean() });

const shortcuts: Dimension[] = ["model", "chatRole", "agentRole", "effort", "provider", "machine"];

function StatsStyledPanel(props: StatsPanelProps) {
  const pluginId = experimental_usePluginId();

  const [styles, setStyles] = useState<{
    pluginId: string;
    ready: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadStyles() {
      try {
        await waitForStatsStyles(pluginId, controller.signal);

        if (!controller.signal.aborted) setStyles({ pluginId, ready: true, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setStyles({
            pluginId,
            ready: false,
            error: error instanceof Error ? error : new Error("Stats stylesheet could not load."),
          });
      }
    }

    void loadStyles();

    return () => controller.abort();
  }, [pluginId]);

  if (styles?.pluginId === pluginId && styles.error) throw styles.error;

  if (styles?.pluginId !== pluginId || !styles.ready)
    return (
      <div
        data-testid="stats-style-pending"
        aria-label="Stats"
        aria-busy="true"
        style={{
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflowY: "auto",
          scrollbarGutter: "stable",
        }}
      />
    );

  return <StatsPanel {...props} />;
}

function StatsPanel({ subPath }: StatsPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = experimental_useAppNavigate();
  const connection = useRealtimeConnectionState();
  const [range, setRange] = useState<ReportInput["range"]>("day");
  const [groupBy, setGroupBy] = useState<Dimension>("model");
  const [filters, setFilters] = useState<Filters>({});
  const [filterLabels, setFilterLabels] = useState<Filters>({});
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<ReportState | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const sequence = useRef(0);
  const liveSequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReport = useRef(false);
  const previousConnection = useRef(connection);

  const input = useMemo<ReportInput>(
    () => ({ range, groupBy, filters, offset, limit: 50, search }),
    [range, groupBy, filters, offset, search],
  );

  const key = JSON.stringify(input);
  const report = state?.report ?? null;
  const current = state?.key === key;
  const view = subPath === "speed" ? "speed" : subPath === "coverage" ? "coverage" : "overview";

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);

    try {
      const result = await rpc.call("report", input);

      if (request !== sequence.current) return;
      setState({
        key: JSON.stringify(input),
        report: result,
        groupBy: input.groupBy,
        offset: input.offset,
      });
      setSummary((current) =>
        !current || current.asOf <= result.summary.asOf ? result.summary : current,
      );
      setError(null);
    } catch {
      if (request === sequence.current) setError("Could not load Stats. Refresh to retry.");
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [rpc, input]);

  const loadSummary = useCallback(async () => {
    const request = ++liveSequence.current;

    try {
      const result = await rpc.call("summary", null);

      if (request === liveSequence.current) {
        setSummary((current) => (!current || current.asOf <= result.asOf ? result : current));
        setLiveError(null);
      }
    } catch {
      if (request === liveSequence.current)
        setLiveError("Could not update live Stats. Refresh to retry.");
    }
  }, [rpc]);

  const schedule = useCallback(
    (data: boolean) => {
      pendingReport.current ||= data;

      if (document.hidden || timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const fullReport = pendingReport.current;
        pendingReport.current = false;
        void (fullReport ? load() : loadSummary());
      }, 750);
    },
    [load, loadSummary],
  );

  const scheduleLoad = useCallback(() => schedule(true), [schedule]);

  useEffect(() => {
    const searchTimer = setTimeout(() => {
      setSearch(searchDraft.trim());
      setOffset(0);
    }, 250);

    return () => clearTimeout(searchTimer);
  }, [searchDraft]);

  useEffect(() => {
    void load();

    return () => {
      sequence.current += 1;

      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pendingReport.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (connection === "connected" && previousConnection.current === "reconnecting") scheduleLoad();
    previousConnection.current = connection;
  }, [connection, scheduleLoad]);

  useEffect(() => {
    const visibilityChanged = () => {
      if (!document.hidden) scheduleLoad();
    };

    document.addEventListener("visibilitychange", visibilityChanged);

    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      liveSequence.current += 1;
    };
  }, [scheduleLoad]);

  useRealtime(CHANGED, (payload) => {
    const signal = signalSchema.safeParse(payload);
    schedule(!signal.success || signal.data.data || !signal.data.live);
  });

  const refresh = async () => {
    setRefreshing(true);

    try {
      await rpc.call("refresh", null);
      await load();
      await loadSummary();
    } catch {
      setError("Could not reconcile Stats. Refresh to retry.");
    } finally {
      setRefreshing(false);
    }
  };

  const addFilter = (group: Group) => {
    setFilters((current) => ({ ...current, [groupBy]: group.key }));
    setFilterLabels((current) => ({
      ...current,
      [groupBy]: report ? groupLabel(group, groupBy, report.health) : group.label,
    }));
    setOffset(0);
    setSearchDraft("");
  };

  const removeFilter = (dimension: Dimension) => {
    setFilters((current) => {
      const next = { ...current };
      delete next[dimension];

      return next;
    });
    setFilterLabels((current) => {
      const next = { ...current };
      delete next[dimension];

      return next;
    });
    setOffset(0);
  };

  const inspectSpeed = (group: SpeedGroup) => {
    setFilters((current) => ({
      ...current,
      provider: group.provider,
      model: group.model,
      effort: group.effort,
      mode: group.mode,
    }));
    setFilterLabels((current) => ({
      ...current,
      provider: group.provider,
      model: group.model,
      effort: group.effort,
      mode: group.mode,
    }));
    setGroupBy("model");
    setOffset(0);
    setSearchDraft("");
    navigate.toPluginPanel("stats");
  };

  const inspectFacet = (dimension: Dimension, key: string, label: string) => {
    setFilters((current) => ({ ...current, [dimension]: key }));
    setFilterLabels((current) => ({ ...current, [dimension]: label }));
    setGroupBy(dimension);
    setOffset(0);
    setSearchDraft("");
  };

  const filtered = dimensions.some((dimension) => filters[dimension] !== undefined);

  return (
    <div
      data-testid="stats-panel"
      aria-busy={loading}
      className="stats-page h-full min-h-0 overflow-y-auto"
      style={{ scrollbarGutter: "stable" }}
    >
      <main className="stats-container">
        <header className="stats-masthead">
          <div className="stats-brand">
            <svg className="stats-brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 17V7h6l4 10h6V7M4 12h16"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="4" cy="7" r="2" fill="currentColor" />
              <circle cx="20" cy="17" r="2" fill="currentColor" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
            <div>
              <p className="stats-eyebrow">Agent observatory</p>
              <h1>Stats</h1>
            </div>
          </div>
          <div className="stats-masthead-actions">
            <span
              className="stats-status"
              data-ready={connection === "connected" && summary?.liveReady === true}
            >
              <span className="stats-status-dot" aria-hidden="true" />
              {connection !== "connected"
                ? "Connecting"
                : summary?.liveReady
                  ? "Live telemetry"
                  : "Reconciling"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              className="stats-refresh"
              onClick={() => {
                void refresh();
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M13 6a5 5 0 1 0 .3 3M13 2v4H9"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Refresh
            </Button>
          </div>
        </header>
        <StatsSummary summary={summary} />
        <nav aria-label="Stats views" className="stats-nav">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "overview"}
            onClick={() => navigate.toPluginPanel("stats")}
          >
            Overview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "speed"}
            onClick={() => navigate.toPluginPanel("stats", { subPath: "speed" })}
          >
            Model speed
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "coverage"}
            onClick={() => navigate.toPluginPanel("stats", { subPath: "coverage" })}
          >
            Coverage & storage
          </Button>
        </nav>
        <div className="stats-notice" aria-live="polite">
          {(error || liveError || report?.health.error) && (
            <p role="alert" className="line-clamp-2 text-sm text-destructive">
              {error ?? liveError ?? report?.health.error}
            </p>
          )}
          {!(error || liveError || report?.health.error) && connection !== "connected" && (
            <p role="status" className="text-xs text-muted-foreground">
              Reconnecting…
            </p>
          )}
        </div>
        {view !== "coverage" && (
          <>
            <div className="stats-controls">
              <label className="stats-control-range">
                Range
                <select
                  aria-label="Range"
                  className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  value={range}
                  onChange={(event) => {
                    const next = ranges.find((option) => option.key === event.target.value);

                    if (next) {
                      setRange(next.key);
                      setOffset(0);
                    }
                  }}
                >
                  {ranges.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {view === "overview" && (
                <>
                  <label className="stats-control-group">
                    Group by
                    <select
                      aria-label="Group by"
                      className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      value={groupBy}
                      onChange={(event) => {
                        const next = dimensionSchema.safeParse(event.target.value);

                        if (next.success) {
                          setGroupBy(next.data);
                          setOffset(0);
                          setSearchDraft("");
                        }
                      }}
                    >
                      {dimensions.map((dimension) => (
                        <option key={dimension} value={dimension}>
                          {dimensionLabels[dimension]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="stats-control-search">
                    Search groups
                    <input
                      aria-label="Search groups"
                      type="search"
                      maxLength={200}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      placeholder={`Search ${dimensionLabels[groupBy].toLowerCase()}…`}
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            {view === "overview" && (
              <nav className="stats-dimension-shortcuts" aria-label="Breakdown dimensions">
                <span>Explore</span>
                {shortcuts.map((dimension) => (
                  <button
                    key={dimension}
                    type="button"
                    aria-pressed={groupBy === dimension}
                    onClick={() => {
                      setGroupBy(dimension);
                      setOffset(0);
                      setSearchDraft("");
                    }}
                  >
                    {dimensionLabels[dimension]}
                  </button>
                ))}
              </nav>
            )}
            <div aria-label="Active filters" className="stats-filters">
              {!filtered && (
                <span className="stats-filters-empty">
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M2 3h12L9 8v4l-2 1V8L2 3Z"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinejoin="round"
                    />
                  </svg>
                  All agents · all machines
                </span>
              )}
              {dimensions.map((dimension) =>
                filters[dimension] === undefined ? null : (
                  <Button
                    key={dimension}
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${dimensionLabels[dimension]} filter`}
                    onClick={() => removeFilter(dimension)}
                  >
                    {dimensionLabels[dimension]}: {filterLabels[dimension] ?? filters[dimension]} ×
                  </Button>
                ),
              )}
              {filtered && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilters({});
                    setFilterLabels({});
                    setOffset(0);
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </>
        )}
        {!report && <StatsSkeleton view={view} />}
        {report && (
          <>
            {view === "overview" && (
              <StatsOverview
                report={report}
                groupBy={state?.groupBy ?? groupBy}
                offset={state?.offset ?? offset}
                loading={loading || !current}
                onFilter={addFilter}
                onPage={setOffset}
                onOpenChat={(id) => navigate.toThread(id)}
                onFacet={inspectFacet}
              />
            )}
            {view === "speed" && <StatsSpeed report={report} onInspect={inspectSpeed} />}
            {view === "coverage" && (
              <StatsHealth health={report.health} summary={summary ?? report.summary} />
            )}
          </>
        )}
        <div data-testid="stats-footer" className="stats-footer">
          <p
            className="w-72 truncate text-xs text-muted-foreground"
            title={report ? `Updated ${timestamp(report.asOf)} · Local SQLite` : "Local SQLite"}
          >
            {report ? `Updated ${timestamp(report.asOf)} · Local SQLite` : "Local SQLite"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!report || !current}
              onClick={() => {
                if (report) downloadReport(report, groupBy, "csv");
              }}
            >
              Download page CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!report || !current}
              onClick={() => {
                if (report) downloadReport(report, groupBy, "json");
              }}
            >
              Download page JSON
            </Button>
          </div>
        </div>
        <p className="stats-footer-note">
          Page exports contain the selected range, filters and current breakdown page. Unknown
          attribution stays separate.
        </p>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "styles",
    mount() {},
  });

  app.slots.navPanel({
    id: "stats",
    title: "Stats",
    icon: "ChartColumn",
    path: "stats",
    component: StatsStyledPanel,
  });
});
