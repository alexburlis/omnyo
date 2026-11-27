import type { Health, Summary } from "../contract";
import { bytes, label, number, rate, timestamp } from "./stats-format";

interface StatsHealthProps {
  health: Health;
  summary: Summary;
}

export function StatsHealth({ health, summary }: StatsHealthProps) {
  const facts = [
    ["Collection started", timestamp(summary.collectionStart)],
    ["Last ingested usage", timestamp(summary.lastIngestAt)],
    ["Database", bytes(health.databaseBytes)],
    ["Write-ahead log", bytes(health.walBytes)],
    ["Chats retained", number(health.chats)],
    ["Dimension cohorts", number(health.cohorts)],
    ["Minute / daily rows", `${number(health.minuteRows)} / ${number(health.dailyRows)}`],
    [
      "Recent usage / speed rows",
      `${number(health.observationRows)} / ${number(health.speedRows)}`,
    ],
    ["Backfill / event queue", `${number(health.backfillPending)} / ${number(health.queueDepth)}`],
    [
      "Source pages / events read",
      `${number(health.sourcePages)} / ${number(health.sourceEvents)}`,
    ],
    ["Last source page", `${rate(health.lastPageMs)} ms`],
    ["Last maintenance", timestamp(health.lastMaintenanceAt)],
  ];

  return (
    <section data-testid="stats-health" className="stats-health">
      <div className="flex h-10 flex-wrap content-start items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Coverage & storage</h2>
        <span className="h-4 w-24 shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {health.indexing ? "Indexing history" : "Collector ready"}
        </span>
      </div>
      <dl
        data-testid="stats-health-facts"
        className="stats-health-facts stats-surface grid gap-x-8 py-2 sm:grid-cols-2"
      >
        {facts.map(([name, value]) => (
          <div
            key={name}
            className="grid h-14 grid-cols-2 gap-3 border-b border-border py-3 text-xs last:border-0"
          >
            <dt className="min-w-0 line-clamp-2 text-muted-foreground">{name}</dt>
            <dd className="min-w-0 line-clamp-2 text-right font-medium tabular-nums" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div
        data-testid="stats-health-retention"
        className="stats-health-retention stats-surface"
        style={{ scrollbarGutter: "stable" }}
      >
        <h3 className="text-sm font-medium">Retention</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{health.retention}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Usage already collected remains after chat archive or deletion. Concurrency before
          collection is unavailable; older token totals depend on surviving Omnyo history. Input and
          cache semantics differ by provider, and reported reasoning is already included in output.
        </p>
        <p className="mt-3 break-all text-xs text-muted-foreground">
          SQLite: <code>{health.databasePath}</code>
        </p>
      </div>
      <div
        data-testid="stats-health-accounts"
        className="stats-health-accounts stats-surface"
        style={{ scrollbarGutter: "stable" }}
      >
        <h3 className="text-sm font-medium">Account attribution</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{health.accountState}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          A known account roster does not establish which account generated a turn. Unattributed
          usage remains Unknown.
        </p>
        {health.accounts.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 font-medium">
                    Account
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Provider
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.accounts.map((account) => (
                  <tr key={account.id} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 font-normal">
                      {account.label}
                    </th>
                    <td>{label(account.provider)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
