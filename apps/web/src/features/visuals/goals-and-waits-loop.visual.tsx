import "./goals-and-waits-loop.css";

export const label =
  "A loop in a chat's Glance card re-checks whether the CSV button is live on staging. Quiet checks wait 1, then 2, then 4 minutes before the next one, and the fourth check finds the change and ends the loop.";

const RUNS = [
  { key: "r1", text: "Nothing new", next: "next in 1 min" },
  { key: "r2", text: "Nothing new", next: "next in 2 min" },
  { key: "r3", text: "Nothing new", next: "next in 4 min" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-goals-and-waits-loop" aria-hidden="true">
      <section className="fv-gl-card">
        <p className="fv-gl-head">
          <svg viewBox="0 0 16 16">
            <path d="M2.5 6.5A5.5 5.5 0 0 1 12.6 4M13.5 9.5A5.5 5.5 0 0 1 3.4 12M12.8 1.8v2.6h-2.6M3.2 14.2v-2.6h2.6" />
          </svg>
          <b>Loop</b>
          <span className="fv-gl-next">
            <span className="is-1m">Next check in 1m</span>
            <span className="is-2m">Next check in 2m</span>
            <span className="is-4m">Next check in 4m</span>
            <span className="is-end">Ended · change found</span>
          </span>
        </p>
        <p className="fv-gl-prompt">
          Check whether staging shows the Export CSV button. Rearm if not.
        </p>
        <p className="fv-gl-cmd">omnyo pursue loop 1m &quot;…&quot;</p>
        <p className="fv-gl-own">
          Omnyo&apos;s server keeps the timer, so the loop survives restarts.
        </p>
        <p className="fv-gl-actions">
          <span>Edit</span>
          <span className="is-stop">Stop loop</span>
        </p>
      </section>
      <section className="fv-gl-runs">
        <p className="fv-gl-eyebrow">Checks</p>
        {RUNS.map((run, index) => (
          <div key={run.key} className={`fv-gl-run is-${run.key}`}>
            <p>
              Check {index + 1} · {run.text}
              <span>{run.next}</span>
            </p>
            <i className="fv-gl-bar" />
          </div>
        ))}
        <div className="fv-gl-run is-hit">
          <p>
            Check 4 · Export CSV is live
            <span>loop ends</span>
          </p>
        </div>
      </section>
    </div>
  );
}
