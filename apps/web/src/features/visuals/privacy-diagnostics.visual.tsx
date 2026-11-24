import "./privacy-diagnostics.css";

export const label =
  "Updated Omnyo Privacy & diagnostics settings: Weekly activity count, Product analytics for this client, Crash reports and Show diagnostic events, each with its own switch.";

const ROWS = [
  {
    id: "streamer",
    title: "Weekly activity count",
    body: "One report per active UTC week from this coordinator, with no identifier.",
    on: false,
  },
  {
    id: "usage",
    title: "Product analytics for this client",
    body: "Optional measurements of setup, feature use and operation outcomes, only after your explicit choice.",
    on: true,
  },
  {
    id: "crash",
    title: "Crash reports",
    body: "Send error reports from the app, this server and its machines to help fix crashes.",
    on: true,
  },
  {
    id: "events",
    title: "Show diagnostic events",
    body: "Show provider environment resolution and unhandled provider events for troubleshooting.",
    on: false,
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-privacy-diagnostics" aria-hidden="true">
      <p className="fv-pdx-crumb fv-dim">Settings</p>
      <h3 className="fv-pdx-title">Privacy &amp; diagnostics</h3>
      <ul className="fv-pdx-list">
        {ROWS.map((row) => (
          <li
            key={row.id}
            className={`fv-pdx-row is-${row.id} ${row.on ? "is-on" : ""}`}
          >
            <span className="fv-pdx-copy">
              <b>{row.title}</b>
              <span className="fv-dim">{row.body}</span>
            </span>
            <span className="fv-pdx-switch">
              <i className="fv-pdx-fill" />
              <i className="fv-pdx-thumb" />
            </span>
          </li>
        ))}
      </ul>
      <svg className="fv-pdx-cursor" viewBox="0 0 16 20">
        <path d="M2 1.5v14.2l3.6-3.4 2.4 5.6 2.5-1.1-2.4-5.5H13z" />
      </svg>
    </div>
  );
}
