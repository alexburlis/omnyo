import type { Summary } from "../contract";
import { compact, number, rate } from "./stats-format";

interface StatsSummaryProps {
  summary: Summary | null;
}

export function StatsSummary({ summary }: StatsSummaryProps) {
  return (
    <section aria-label="Global live and lifetime totals" className="stats-summary">
      <div className="stats-metric" data-tone="live">
        <h2>
          <span className="stats-metric-kicker">Live now</span>
          <br />
          Agents running · global
        </h2>
        <p data-testid="summary-running" className="stats-metric-value">
          <span>{summary?.liveReady ? number(summary.running) : "—"}</span>
        </p>
        <p className="stats-metric-caption">
          {summary?.liveReady
            ? `${number(summary.activeChats)} active chats · ${number(summary.nestedAgents)} native agents`
            : "Reconciling active agents…"}
        </p>
        <div className="stats-metric-role-line stats-role-counts">
          <span title={summary ? `${number(summary.mainChats)} main chats` : undefined}>
            <b>{summary?.liveReady ? number(summary.mainChats) : "—"}</b> main
          </span>
          <span title={summary ? `${number(summary.subagentChats)} subagent chats` : undefined}>
            <b>{summary?.liveReady ? number(summary.subagentChats) : "—"}</b> subagent
          </span>
          <span
            title={summary ? `${number(summary.unknownChats)} chats with unknown role` : undefined}
          >
            <b>{summary?.liveReady ? number(summary.unknownChats) : "—"}</b> unknown
          </span>
        </div>
      </div>
      <div className="stats-metric" data-tone="speed">
        <h2>
          Output throughput
          <br />
          All agents · 5m average
        </h2>
        <p data-testid="summary-tps" className="stats-metric-value">
          <span title={summary ? rate(summary.tps5m) : undefined}>
            {summary ? rate(summary.tps5m) : "—"}
          </span>
          <small>tok/s</small>
        </p>
        <p className="stats-metric-caption">
          {summary
            ? `${compact(summary.output5m)} output tokens · ${number(Math.min(300, summary.observedSeconds5m))}/300s observed`
            : "Five-minute window · all chats and machines"}
        </p>
        <div className="stats-metric-role-line">
          <span>Wall-clock throughput</span>
        </div>
      </div>
      <div className="stats-metric">
        <h2>
          Generated all time
          <br />
          Output tokens · global
        </h2>
        <p data-testid="summary-generated" className="stats-metric-value">
          <span title={summary ? number(summary.allTime.output) : undefined}>
            {summary ? compact(summary.allTime.output) : "—"}
          </span>
        </p>
        <p className="stats-metric-caption">
          {summary
            ? `${compact(summary.allTime.reasoning)} reasoning tokens included`
            : "Output includes reported reasoning"}
        </p>
        <div className="stats-metric-role-line">
          <span>Retained after chat deletion</span>
        </div>
      </div>
      <div className="stats-metric">
        <h2>
          Input all time
          <br />
          All providers · global
        </h2>
        <p data-testid="summary-input" className="stats-metric-value">
          <span title={summary ? number(summary.allTime.input) : undefined}>
            {summary ? compact(summary.allTime.input) : "—"}
          </span>
        </p>
        <p className="stats-metric-caption">
          {summary
            ? `${compact(summary.allTime.cached)} cached · ${compact(summary.allTime.total)} provider total`
            : "Input and cache follow provider semantics"}
        </p>
        <div className="stats-metric-role-line">
          <span>Local, durable SQLite</span>
        </div>
      </div>
    </section>
  );
}
