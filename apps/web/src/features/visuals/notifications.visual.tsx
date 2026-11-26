export const label =
  "Omnyo notice cards sliding in beside the sidebar: Review: Add CSV export asks which date format to use, the recommended answer is tapped and the card confirms Sent before the next waiting chat slides in.";

const ROWS = [
  {
    group: "Needs you",
    count: 2,
    rows: [
      {
        title: "Review: Add CSV export",
        sub: "Which date format for the export?",
        attention: 1,
      },
      {
        title: "Weekday issue triage",
        sub: "Close the two duplicates?",
        attention: 2,
      },
    ],
  },
  {
    group: "Running",
    count: 1,
    rows: [{ title: "Date parser tests", sub: null, attention: 0 }],
  },
  {
    group: "Finished",
    count: 1,
    rows: [
      {
        title: "Fix invoice rounding",
        sub: "Rounding now matches the ledger",
        attention: 0,
      },
    ],
  },
] as const;

const NOTICES = [
  {
    title: "Review: Add CSV export",
    project: "harbor-ledger",
    prompt: "Which date format for the export?",
    choices: ["dd.mm.yyyy", "yyyy-mm-dd"],
  },
  {
    title: "Weekday issue triage",
    project: "atlas-notes",
    prompt: "Close the two duplicate issues?",
    choices: ["Close both", "Keep open"],
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-notifications" aria-hidden="true">
      <aside className="fv-notices-side">
        <p className="fv-notices-new">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 8.5v7M8.5 12h7" />
          </svg>
          New thread
        </p>
        {ROWS.map((section) => (
          <div key={section.group} className="fv-notices-group">
            <p className="fv-notices-label">
              {section.group}
              <span>{section.count}</span>
            </p>
            {section.rows.map((row) => (
              <p
                key={row.title}
                className={`fv-notices-row${row.attention ? ` is-attention is-n${row.attention}` : ""}`}
              >
                <i />
                <span>
                  <b>{row.title}</b>
                  {row.sub ? <small>{row.sub}</small> : null}
                </span>
              </p>
            ))}
          </div>
        ))}
      </aside>
      <div className="fv-notices-main">
        <p>
          The export button is in place. Before I format the dates, I need one
          decision from you.
        </p>
      </div>
      <div className="fv-notices-stack">
        {NOTICES.map((notice, index) => (
          <article
            key={notice.title}
            className={`fv-notices-card is-n${index + 1}`}
          >
            <div className="fv-notices-top">
              <span className="fv-notices-glyph">
                <svg viewBox="0 0 16 16">
                  <path d="M5.6 6.1a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4" />
                  <circle cx="8" cy="12.6" r="1" />
                </svg>
              </span>
              <span className="fv-notices-heading">
                <b>{notice.title}</b>
                <small>
                  <em>Needs you</em> · {notice.project} · now
                </small>
              </span>
              <svg className="fv-notices-close" viewBox="0 0 16 16">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </div>
            <p className="fv-notices-prompt">{notice.prompt}</p>
            <div className="fv-notices-outcome">
              <p className="fv-notices-choices">
                <span className="is-primary">
                  {notice.choices[0]} <small>★</small>
                  <svg className="fv-notices-cursor" viewBox="0 0 16 20">
                    <path d="M2 1.5v14.2l3.6-3.4 2.3 5.4 2.4-1-2.3-5.3h5z" />
                  </svg>
                </span>
                <span>{notice.choices[1]}</span>
              </p>
              <p className="fv-notices-sent">
                <svg viewBox="0 0 16 16">
                  <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
                </svg>
                Sent “{notice.choices[0]}”
              </p>
            </div>
            <p className="fv-notices-actions">
              <span className="is-main">Open chat</span>
              <span>Later</span>
            </p>
          </article>
        ))}
        <span className="fv-notices-more">+1 more waiting</span>
      </div>
    </div>
  );
}
