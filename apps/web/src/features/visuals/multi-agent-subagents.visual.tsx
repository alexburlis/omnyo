import "./multi-agent-subagents.css";

export const label =
  "A Claude Code chat runs two subagents. Each run is a timeline row, the first expands into its searches and file reads, and the count on the chat's status ring drops from 2 to 1 to done as they finish.";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 10 10">
      <path d={open ? "M2.5 3.8 5 6.3l2.5-2.5" : "M3.8 2.5 6.3 5 3.8 7.5"} />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em">
      <path
        d="m3.5 8.4 2.9 2.9 6.1-6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-multi-agent-subagents" aria-hidden="true">
      <header className="fv-mu-bar">
        <span className="fv-mu-glyph">
          <i className="fv-mu-ring" />
          <i className="fv-mu-num">
            <span className="is-two">2</span>
            <span className="is-one">1</span>
          </i>
        </span>
        <b>Add CSV export</b>
        <small>harbor-ledger · Claude Code</small>
      </header>
      <div className="fv-mu-thread">
        <p className="fv-mu-say">
          I will split the research between two subagents.
        </p>
        <div className="fv-mu-run is-a">
          <Chevron open />
          <b>
            Agent <em>· Find every parseDate call site</em>
          </b>
          <span className="fv-mu-state">
            <span className="is-work">Running</span>
            <span className="is-done">
              <Check />
              Done
            </span>
          </span>
        </div>
        <div className="fv-mu-nest">
          <p>
            Searched for parseDate <span>· 14 results</span>
          </p>
          <p>
            Read src/export.ts <span>· 212 lines</span>
          </p>
          <p>
            Read src/date-parser.ts <span>· 96 lines</span>
          </p>
        </div>
        <div className="fv-mu-run is-b">
          <Chevron open={false} />
          <b>
            Agent <em>· Check CSV quoting rules</em>
          </b>
          <span className="fv-mu-state">
            <span className="is-work">Running</span>
            <span className="is-done">
              <Check />
              Done
            </span>
          </span>
        </div>
        <p className="fv-mu-say fv-mu-wrap">
          Both done: 14 call sites, and quoted fields need doubled quotes.
        </p>
      </div>
    </div>
  );
}
