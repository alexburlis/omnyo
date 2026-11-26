export const label =
  "Switching between recently opened chats in Omnyo. The pointer clicks Date parser tests, then Review: Add CSV export, then Add CSV export, and each chat's messages are on screen at once. A gauge marks the measured result: every one of 20 switches took 85 ms or less, against a 100 ms line.";

const CHATS = [
  { title: "Add CSV export", project: "harbor-ledger" },
  { title: "Date parser tests", project: "atlas-notes" },
  { title: "Review: Add CSV export", project: "harbor-ledger" },
  { title: "Release notes draft", project: "atlas-notes" },
] as const;

const PANES = [
  {
    you: "Add a CSV export to the invoices table",
    agent: [
      "Added exportCsv() with a header row and ISO dates.",
      "6 new tests pass. The Export CSV button is in the toolbar.",
    ],
  },
  {
    you: "Add tests for European date formats",
    agent: [
      "parseDate now accepts 31.12.2026 and 31/12/2026.",
      "4 of 4 European cases pass.",
    ],
  },
  {
    you: "Review the CSV export branch",
    agent: [
      "1 serious finding: commas inside names are not quoted.",
      "2 minor findings in export.test.ts.",
    ],
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-performance-switch" aria-hidden="true">
      <aside className="fv-psw-side">
        <p className="fv-eyebrow">Recent</p>
        <div className="fv-psw-list">
          <i className="fv-psw-mark" />
          {CHATS.map((chat) => (
            <p key={chat.title} className="fv-psw-row">
              <b>{chat.title}</b>
              <span className="fv-dim">{chat.project}</span>
            </p>
          ))}
          <svg className="fv-psw-cursor" viewBox="0 0 16 20">
            <path d="M2 1.5v14.2l3.6-3.4 2.4 5.6 2.5-1.1-2.4-5.5H13z" />
          </svg>
        </div>
      </aside>
      <div className="fv-psw-main">
        {PANES.map((pane, index) => (
          <div key={pane.you} className={`fv-psw-pane is-p${index}`}>
            <p className="fv-psw-title">{CHATS[index]?.title}</p>
            <p className="fv-psw-you">{pane.you}</p>
            {pane.agent.map((line) => (
              <p key={line} className="fv-soft">
                {line}
              </p>
            ))}
          </div>
        ))}
        <div className="fv-psw-gauge">
          <p>
            <b>≤ 85 ms</b>
            <span className="fv-dim">
              all 20 switches, click to first frame
            </span>
          </p>
          <span className="fv-psw-track">
            <i />
            <s />
          </span>
          <p className="fv-psw-scale fv-mono fv-dim">
            <span>0</span>
            <span>100 ms</span>
          </p>
        </div>
      </div>
    </div>
  );
}
