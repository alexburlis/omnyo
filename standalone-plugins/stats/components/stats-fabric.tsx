import type { Dimension, Report } from "../contract";
import { compact, dimensionLabels, label, number, rate } from "./stats-format";

interface StatsFabricProps {
  report: Report | null;
  disabled?: boolean;
  onSelect?: (dimension: Dimension, key: string, label: string) => void;
}

const facetOrder: Dimension[] = ["model", "provider", "machine", "effort", "chatRole", "agentRole"];

const facetDescriptions: Partial<Record<Dimension, string>> = {
  model: "Models",
  provider: "Providers",
  machine: "Machines",
  effort: "Thinking levels",
  chatRole: "Chat ownership",
  agentRole: "Execution role",
};

export function StatsFabric({ report, disabled = false, onSelect }: StatsFabricProps) {
  return (
    <section data-testid="stats-fabric" className="stats-fabric stats-surface">
      <div className="stats-section-heading stats-fabric-heading">
        <div className="min-w-0">
          <p className="stats-eyebrow">Work distribution</p>
          <h2>Execution fabric</h2>
        </div>
        <div className="stats-fabric-source">
          <span className="stats-source-dot" aria-hidden="true" />
          <div>
            <span>Selected output</span>
            <strong title={report ? number(report.counters.output) : undefined}>
              {report ? compact(report.counters.output) : "—"}
              <small> tokens</small>
            </strong>
          </div>
        </div>
      </div>
      <div className="stats-fabric-trunk" aria-hidden="true">
        <svg viewBox="0 0 1200 24" preserveAspectRatio="none">
          <path d="M 600 0 V 12 M 100 24 V 12 H 1100 V 24 M 300 12 V 24 M 500 12 V 24 M 700 12 V 24 M 900 12 V 24" />
          {[100, 300, 500, 700, 900, 1100].map((x) => (
            <circle key={x} cx={x} cy="12" r="2.5" />
          ))}
        </svg>
      </div>
      <div className="stats-facet-grid">
        {facetOrder.map((dimension, index) => {
          const facet = report?.facets.find((candidate) => candidate.dimension === dimension);

          return (
            <div
              key={dimension}
              className="stats-facet"
              data-tone={index % 3}
              data-dimension={dimension}
            >
              <div className="stats-facet-heading">
                <span className="stats-facet-glyph" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{facetDescriptions[dimension] ?? dimensionLabels[dimension]}</h3>
              </div>
              <div className="stats-facet-rows">
                {Array.from({ length: 6 }, (_, slot) => {
                  const group = facet?.groups[slot];

                  const share =
                    group && facet && facet.totalOutput > 0 ? group.output / facet.totalOutput : 0;

                  if (!group)
                    return (
                      <div key={slot} className="stats-facet-empty" aria-hidden="true">
                        {!report && <span className="stats-skeleton-line" />}
                      </div>
                    );

                  return (
                    <button
                      key={group.key}
                      type="button"
                      disabled={disabled || group.key === "__other" || !onSelect}
                      className="stats-facet-node"
                      aria-label={`Filter ${dimensionLabels[dimension]} ${group.label}`}
                      title={`${group.label} · ${number(group.output)} output tokens · ${rate(share * 100)}% · ${number(group.active)} running`}
                      onClick={() => onSelect?.(dimension, group.key, group.label)}
                    >
                      <span className="stats-facet-node-name">
                        {group.key === "__other" ? "Other" : label(group.label)}
                      </span>
                      <span className="stats-facet-node-share">
                        {rate(share * 100)}
                        <small>%</small>
                      </span>
                      <span className="stats-facet-node-rail" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
                      </span>
                      {group.active > 0 && (
                        <span
                          className="stats-facet-node-live"
                          aria-label={`${number(group.active)} running`}
                        >
                          {number(group.active)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="stats-facet-footer">
                {facet ? `${number(facet.totalGroups)} groups` : "—"}
                <span>output share</span>
              </p>
            </div>
          );
        })}
      </div>
      <p className="stats-fabric-caption">
        Independent breakdowns of the full filtered range. Select a node to explore; unknown
        attribution stays visible.
      </p>
    </section>
  );
}
