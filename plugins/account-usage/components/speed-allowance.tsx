import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@omnyo/shared-ui/collapsible";
import {
  CONTROL_HOVER_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { DisclosureGlyph } from "./glyphs.tsx";
import { ROW_ACTION_CLASS } from "./action-classes.ts";
import type { rpcContract } from "../contract.ts";
import type { TelemetryReport } from "../lib/telemetry-contract.ts";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const multiplier = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const fasterTiers = ["fast", "ultrafast"];

const disclosureClass = `flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sidebar-ring ${CONTROL_HOVER_TRANSITION}`;

function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <DisclosureGlyph
      className={`size-2.5 shrink-0 ${DISCLOSURE_CHEVRON_TRANSITION} ${open ? "rotate-90" : ""}`}
    />
  );
}

const tokens = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function tierLabel(value: string): string {
  if (value === "default") return "Standard";

  if (value === "fast") return "Fast";

  if (value === "ultrafast") return "Ultrafast";

  return value;
}

export function SpeedAllowance({
  accounts,
  fetchedAt,
}: {
  accounts: readonly { id: string; name: string }[];
  fetchedAt: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
      <section
        aria-label="Codex speed and allowance"
        className="border-t border-sidebar-border"
      >
        <CollapsibleTrigger className={disclosureClass}>
          <DisclosureChevron open={expanded} />
          <span className="font-medium">Codex speed</span>
          <span className="ml-auto text-2xs text-subtle-foreground">
            Last 30 days
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SpeedAllowanceDetails accounts={accounts} fetchedAt={fetchedAt} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function SpeedAllowanceDetails({
  accounts,
  fetchedAt,
}: {
  accounts: readonly { id: string; name: string }[];
  fetchedAt: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [allowanceExpanded, setAllowanceExpanded] = useState(false);
  const [effort, setEffort] = useState("high");
  const [report, setReport] = useState<TelemetryReport | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setReport(null);
    setError(false);
    void rpc.call("telemetry", { accountId }).then(
      (next) => {
        if (active) setReport(next);
      },
      () => {
        if (active) setError(true);
      },
    );

    return () => {
      active = false;
    };
  }, [rpc, accountId, fetchedAt, revision]);

  const speedRows = report?.speedRows ?? [];
  const availableEfforts = new Set(speedRows.map((row) => row.effort ?? ""));

  const knownEfforts = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];

  const efforts = [
    ...knownEfforts.filter((value) => availableEfforts.has(value)),
    ...[...availableEfforts].filter((value) => !knownEfforts.includes(value)),
  ];

  const selectedEffort = availableEfforts.has(effort)
    ? effort
    : (efforts[0] ?? "");

  const rows = speedRows.filter((row) => (row.effort ?? "") === selectedEffort);

  const models = new Map<
    string,
    Map<string | null, TelemetryReport["speedRows"][number]>
  >();

  const tiers: (string | null)[] = ["default", ...fasterTiers];

  for (const row of rows) {
    const samples = models.get(row.model) ?? new Map();
    samples.set(row.requestedTier, row);
    models.set(row.model, samples);

    if (!tiers.includes(row.requestedTier)) tiers.push(row.requestedTier);
  }

  const comparisons = [...models].flatMap(([model, samples]) => {
    const standard = samples.get("default")?.medianTps;

    if (standard === undefined || standard <= 0) return [];

    const factors = fasterTiers.map((tier) => {
      const speed = samples.get(tier)?.medianTps;
      const factor = speed === undefined ? null : speed / standard;

      return { tier, factor };
    });

    return factors.some(({ factor }) => factor !== null)
      ? [{ model, factors }]
      : [];
  });

  const comparison =
    comparisons.find(({ factors }) =>
      factors.every(({ factor }) => factor !== null),
    ) ?? comparisons[0];

  return (
    <div className="px-2 pb-2">
      {error ? (
        <p
          role="status"
          className="mb-0 flex items-center gap-2 text-2xs text-destructive-text"
        >
          <span className="min-w-0 flex-1">
            Couldn’t load speed measurements.
          </span>
          <button type="button" className={ROW_ACTION_CLASS} onClick={retry}>
            Retry
          </button>
        </p>
      ) : report === null ? (
        <p role="status" className="mb-0 text-2xs text-subtle-foreground">
          Loading measurements…
        </p>
      ) : (
        <>
          {report.speedRows.length === 0 ? (
            <p role="status" className="mb-0 text-2xs text-subtle-foreground">
              No measured speed yet.
            </p>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                {comparison ? (
                  <span className="break-words text-2xs text-subtle-foreground">
                    {comparison.model} vs Standard
                  </span>
                ) : null}
                <label className="ml-auto flex items-center gap-1 text-2xs text-subtle-foreground">
                  <span>Thinking</span>
                  <select
                    aria-label="Thinking effort"
                    className="min-w-0 rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                    value={selectedEffort}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {efforts.map((value) => (
                      <option key={value} value={value}>
                        {value === "xhigh"
                          ? "Extra high"
                          : value === ""
                            ? "Unreported"
                            : value.charAt(0).toUpperCase() + value.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {comparison ? (
                <section
                  aria-label={`${comparison.model} vs Standard`}
                  className="mt-1"
                >
                  <dl className="m-0 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    {comparison.factors.map(({ tier, factor }) => (
                      <div
                        key={tier}
                        className="flex flex-row-reverse items-baseline gap-1.5"
                      >
                        <dt className="text-2xs text-subtle-foreground">
                          {tierLabel(tier)}
                        </dt>
                        <dd
                          className="m-0 text-lg leading-tight font-semibold tabular-nums"
                          title={
                            factor === null
                              ? "No comparable measurement"
                              : undefined
                          }
                        >
                          {factor === null
                            ? "—"
                            : `${multiplier.format(factor)}×`}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
              <div className="mt-1 overflow-x-auto">
                <table className="w-full table-fixed text-xs tabular-nums">
                  <caption className="sr-only">
                    Median tokens per second across Codex chats, by model and
                    requested speed tier
                  </caption>
                  <colgroup>
                    <col className="w-1/3" />
                    {tiers.map((tier) => (
                      <col key={JSON.stringify(tier)} />
                    ))}
                  </colgroup>
                  <thead className="text-subtle-foreground">
                    <tr>
                      <th
                        scope="col"
                        aria-label="Model"
                        className="py-1.5 pr-1 text-left text-2xs font-normal"
                      >
                        Median tokens/s
                      </th>
                      {tiers.map((tier) => (
                        <th
                          key={JSON.stringify(tier)}
                          scope="col"
                          className="px-1 py-1.5 text-right text-2xs font-normal"
                        >
                          {tier === null ? "Unreported" : tierLabel(tier)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...models].map(([model, samples]) => (
                      <tr
                        key={model}
                        className="border-t border-sidebar-border"
                      >
                        <th
                          scope="row"
                          className="break-words py-1 pr-2 text-left align-top font-normal"
                        >
                          {model}
                        </th>
                        {tiers.map((tier) => {
                          const sample = samples.get(tier);

                          return (
                            <td
                              key={JSON.stringify(tier)}
                              className="px-1 py-1 text-right align-top"
                              title={sample ? undefined : "No measured speed"}
                            >
                              <div
                                className={
                                  sample
                                    ? "font-medium"
                                    : "text-subtle-foreground"
                                }
                              >
                                {sample ? number.format(sample.medianTps) : "—"}
                              </div>
                              {sample?.measuredTurns != null ? (
                                <div className="text-2xs text-subtle-foreground">
                                  {tokens.format(sample.measuredTurns)}{" "}
                                  {sample.measuredTurns === 1
                                    ? "turn"
                                    : "turns"}
                                </div>
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <Collapsible
            open={allowanceExpanded}
            onOpenChange={setAllowanceExpanded}
            className="mt-1 border-t border-sidebar-border pt-1"
          >
            <CollapsibleTrigger
              className={`${disclosureClass} text-subtle-foreground`}
            >
              <DisclosureChevron open={allowanceExpanded} />
              Allowance details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-2 pb-1">
                <label className="flex items-center gap-2 text-2xs">
                  <span>Account</span>
                  <select
                    aria-label="Allowance account"
                    className="min-w-0 flex-1 rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                    value={accountId ?? ""}
                    onChange={(event) =>
                      setAccountId(event.target.value || null)
                    }
                  >
                    <option value="">All accounts</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                {report.collectionErrors > 0 ? (
                  <p role="status" className="my-1 text-2xs text-warning-text">
                    Allowance data is incomplete.
                  </p>
                ) : null}
                <QuotaObservations report={report} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}

function QuotaObservations({ report }: { report: TelemetryReport }) {
  const measured = report.windows.filter(
    (window) =>
      window.attribution === "observed-account" &&
      window.deltaPercent !== null &&
      window.deltaPercent > 0,
  );

  return (
    <div className="mt-2 text-2xs">
      {measured.length === 0 ? (
        <p className="my-1 text-subtle-foreground">
          No allowance changes measured yet.
        </p>
      ) : (
        <ul className="my-1 list-none space-y-1 p-0">
          {measured.slice(-5).map((window, index) => (
            <li
              key={`${window.accountId}-${window.slot}-${window.to}-${index}`}
            >
              {window.model} ·{" "}
              {tierLabel(
                window.servedTier ?? window.requestedTier ?? "unknown",
              )}{" "}
              · {window.effort ?? "effort unknown"}:{" "}
              {window.windowMinutes === null
                ? window.slot
                : `${number.format(window.windowMinutes / 60)}h window`}
              : {number.format(window.deltaPercent!)} percentage points across{" "}
              {window.requests} requests
              {window.outputTokens === null
                ? ""
                : ` · ${tokens.format(window.outputTokens)} output tokens${window.outputTokens > 0 ? ` · ${number.format((window.deltaPercent! * 1_000_000) / window.outputTokens)} pp/M output` : ""}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
