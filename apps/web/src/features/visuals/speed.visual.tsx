export const label =
  "Four measured times: switching to a recently opened chat in 85 ms or less, a new chat saved in 6 ms, search across 1,000 chats in 3 ms and a 15,000-event chat reopened in 25 ms.";

const RESULTS = [
  {
    value: "≤ 85",
    where: "On screen",
    caption: "Switch to a recently opened chat",
  },
  {
    value: "6",
    where: "Server",
    caption: "New chat saved by the local server",
  },
  {
    value: "3",
    where: "Server",
    caption: "Search across 1,000 chats on the server",
  },
  {
    value: "25",
    where: "Server",
    caption: "Reopen a 15,000-event chat on the server",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-speed" aria-hidden="true">
      <ul className="fv-speed-grid">
        {RESULTS.map((result) => (
          <li key={result.caption} className="fv-panel">
            <span className="fv-speed-where fv-pill">
              <i
                className={`fv-dot ${result.where === "Server" ? "fv-dot--dim" : "fv-dot--ok"}`}
              />
              {result.where}
            </span>
            <p className="fv-speed-value">
              {result.value}
              <small>ms</small>
            </p>
            <p className="fv-speed-caption">{result.caption}</p>
          </li>
        ))}
      </ul>
      <p className="fv-speed-note">
        Measured by Omnyo on an M4 Pro Mac, October 2026, local test
      </p>
    </div>
  );
}
