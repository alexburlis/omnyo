export const label =
  "The GitHub page in Omnyo listing issues across projects. After a refresh, the issue an agent fixed shows as closed. Then Start on another issue hands it to a new agent, and the issue gets an agent badge.";

const ISSUES = [
  {
    number: 131,
    title: "Sunday shows as Monday",
    agent: true,
    assignee: "a",
    updated: "2h ago",
    role: "closes",
  },
  {
    number: 47,
    title: "ISO week dates are rejected",
    agent: false,
    assignee: null,
    updated: "5h ago",
    role: "starts",
  },
  {
    number: 126,
    title: "Export skips rows with an empty note",
    agent: false,
    assignee: "b",
    updated: "1d ago",
    role: null,
  },
  {
    number: 44,
    title: "Note dates lose their time zone",
    agent: false,
    assignee: null,
    updated: "3d ago",
    role: null,
  },
  {
    number: 122,
    title: "CSV header order changes between exports",
    agent: false,
    assignee: "a",
    updated: "4d ago",
    role: null,
  },
  {
    number: 39,
    title: "Tags vanish after a rename",
    agent: false,
    assignee: null,
    updated: "8d ago",
    role: null,
  },
] as const;

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Roll({ from, to }: { from: string; to: string }) {
  return (
    <span className="fv-github-roll">
      <span>{from}</span>
      <span>{to}</span>
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-github" aria-hidden="true">
      <div className="fv-github-top">
        <Glyph d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
        <b>GitHub</b>
        <span className="fv-github-sync">
          2 repos · synced <Roll from="6m ago" to="1m ago" />
        </span>
        <span className="fv-github-refresh">
          <Glyph d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 3.5v5h-5" />
          Refresh
        </span>
        <Glyph className="fv-github-close" d="M17 7 7 17M7 7l10 10" />
      </div>
      <div className="fv-github-body">
        <div className="fv-github-row">
          <span className="fv-github-tabs">
            <span className="is-on">Issues</span>
            <span>Pull requests</span>
          </span>
          <span className="fv-github-new">New issue</span>
        </div>
        <div className="fv-github-chips">
          <span className="is-on">All projects</span>
          <span>atlas-notes</span>
          <span>harbor-ledger</span>
        </div>
        <div className="fv-github-states">
          <span className="is-on">All (7)</span>
          <span>
            Open (<Roll from="6" to="5" />)
          </span>
          <span>
            Closed (<Roll from="1" to="2" />)
          </span>
          <em>Recent cache</em>
        </div>
        <p className="fv-github-filter">
          Filter — is:open assignee:@me label:bug, or plain text
        </p>
        <div className="fv-github-list">
          <div className="fv-github-head">
            <span className="fv-github-id">ID</span>
            <span className="fv-github-title">Title</span>
            <span className="fv-github-assignee">Assignee</span>
            <span className="fv-github-status">Status</span>
            <span className="fv-github-updated">Updated</span>
            <span className="fv-github-actions" />
          </div>
          {ISSUES.map((issue) => (
            <div
              className={`fv-github-item${issue.role ? ` is-${issue.role}` : ""}`}
              key={issue.number}
            >
              <span className="fv-github-title">
                <span className="fv-github-name">{issue.title}</span>
                {issue.agent || issue.role === "starts" ? (
                  <span className="fv-github-agent">⚡ agent</span>
                ) : null}
              </span>
              <span className="fv-github-meta">
                <span className="fv-github-id">#{issue.number}</span>
                <span
                  className={`fv-github-assignee ${issue.assignee ? "" : "is-none"}`}
                >
                  {issue.assignee ? (
                    <i className={`fv-github-avatar is-${issue.assignee}`} />
                  ) : (
                    "—"
                  )}
                </span>
                <span className="fv-github-status">
                  <span className="fv-github-state">
                    <i />
                    {issue.role === "closes" ? (
                      <span className="fv-github-swap">
                        <span>open</span>
                        <span>closed</span>
                      </span>
                    ) : (
                      "open"
                    )}
                    <Glyph d="m6 9 6 6 6-6" />
                  </span>
                </span>
                <span className="fv-github-updated">
                  {issue.role === "closes" ? (
                    <Roll from={issue.updated} to="1m ago" />
                  ) : (
                    issue.updated
                  )}
                </span>
                <span className="fv-github-actions">
                  <span className="fv-github-start">
                    {issue.role === "starts" ? (
                      <>
                        <span className="fv-github-swap">
                          <span>Start</span>
                          <span>…</span>
                        </span>
                        <svg className="fv-github-cursor" viewBox="0 0 24 24">
                          <path d="M5 2.5v17l4.6-4.2 2.8 6.3 2.9-1.3-2.7-6.1h6.2Z" />
                        </svg>
                      </>
                    ) : (
                      "Start"
                    )}
                  </span>
                  <span className="fv-github-more">⋮</span>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
