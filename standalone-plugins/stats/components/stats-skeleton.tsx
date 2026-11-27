import { Button } from "./ui/button";
import { StatsChart } from "./stats-chart";
import { StatsFabric } from "./stats-fabric";

interface StatsSkeletonProps {
  view: "overview" | "speed" | "coverage";
}

function SkeletonBar() {
  return <span aria-hidden="true" className="stats-skeleton-line" />;
}

export function StatsSkeleton({ view }: StatsSkeletonProps) {
  if (view === "speed")
    return (
      <section data-testid="stats-speed" aria-label="Loading local Stats" className="stats-speed">
        <div className="flex h-10 items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Model speed</h2>
        </div>
        <div data-testid="stats-speed-controls" className="stats-speed-controls">
          {["Speed provider", "Speed model", "Speed thinking effort", "Speed mode"].map((name) => (
            <label key={name} className="flex flex-col gap-1.5">
              {name}
              <select aria-label={name} disabled>
                <option>All</option>
              </select>
            </label>
          ))}
        </div>
        <div
          data-testid="stats-speed-totals"
          className="stats-range-totals stats-speed-totals stats-surface"
        >
          {[0, 1, 2].map((item) => (
            <span key={item}>
              <SkeletonBar />
            </span>
          ))}
        </div>
        <div data-testid="stats-speed-frame" className="stats-speed-frame stats-surface">
          <div className="h-80 overflow-auto" style={{ scrollbarGutter: "stable" }}>
            <div className="flex flex-col gap-8 py-2">
              {[0, 1, 2, 3, 4, 5].map((item) => (
                <SkeletonBar key={item} />
              ))}
            </div>
          </div>
        </div>
        <div className="h-36 sm:h-20">
          <SkeletonBar />
        </div>
      </section>
    );

  if (view === "coverage")
    return (
      <section data-testid="stats-health" aria-label="Loading local Stats" className="stats-health">
        <div className="flex h-10 items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Coverage & storage</h2>
        </div>
        <div
          data-testid="stats-health-facts"
          className="stats-health-facts stats-surface grid gap-x-8 py-2 sm:grid-cols-2"
        >
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((item) => (
            <div
              key={item}
              className="grid h-14 grid-cols-2 items-start gap-3 border-b border-border py-3 last:border-0"
            >
              <SkeletonBar />
            </div>
          ))}
        </div>
        <div
          data-testid="stats-health-retention"
          className="stats-health-retention stats-surface"
          style={{ scrollbarGutter: "stable" }}
        >
          <h3>Retention</h3>
          <div className="mt-2">
            <SkeletonBar />
          </div>
        </div>
        <div
          data-testid="stats-health-accounts"
          className="stats-health-accounts stats-surface"
          style={{ scrollbarGutter: "stable" }}
        >
          <h3>Account attribution</h3>
          <div className="mt-2">
            <SkeletonBar />
          </div>
        </div>
      </section>
    );

  return (
    <div aria-label="Loading local Stats" className="stats-overview">
      <div data-testid="stats-range-totals" className="stats-range-totals stats-surface">
        {[0, 1, 2, 3, 4].map((item) => (
          <span key={item}>
            <SkeletonBar />
          </span>
        ))}
      </div>
      <div className="stats-chart-grid">
        <StatsChart points={[]} metric="agents" resolutionSeconds={0} skeleton />
        <StatsChart points={[]} metric="tps" resolutionSeconds={0} skeleton />
      </div>
      <StatsFabric report={null} />
      <section data-testid="stats-breakdown-frame" className="stats-breakdown stats-surface">
        <div className="stats-section-heading stats-breakdown-heading">
          <SkeletonBar />
        </div>
        <div className="stats-breakdown-scroll">
          <div className="flex flex-col gap-6 py-2">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
              <SkeletonBar key={item} />
            ))}
          </div>
        </div>
        <div className="stats-breakdown-pagination">
          <SkeletonBar />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          </div>
        </div>
      </section>
      <div className="stats-range-caption">
        <SkeletonBar />
      </div>
    </div>
  );
}
