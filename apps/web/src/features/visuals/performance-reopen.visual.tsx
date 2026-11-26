export const label =
  "Reopening a saved 116 MB chat with 15,543 events, timed at the server in real time: before the change the read takes about 1.8 seconds and its bar crawls across, now it takes about 25 ms and finishes at once. Below, a new chat saves in about 6 ms and a search across 1,000 chats takes about 3 ms.";

export function Visual() {
  return (
    <div className="fv fv-performance-reopen" aria-hidden="true">
      <header className="fv-pro-head">
        <div>
          <h3>Reopen a saved chat</h3>
          <p className="fv-dim">116 MB · 15,543 events · server read</p>
        </div>
        <span className="fv-pro-tag fv-mono">M4 Pro · Oct 2026</span>
      </header>
      <div className="fv-pro-race">
        <div className="fv-pro-lane is-before">
          <p>
            <span>Before the change</span>
            <b className="fv-pro-done">≈ 1.8 s</b>
          </p>
          <span className="fv-pro-track">
            <i />
          </span>
        </div>
        <div className="fv-pro-lane is-now">
          <p>
            <span>Now</span>
            <b className="fv-pro-done">≈ 25 ms</b>
          </p>
          <span className="fv-pro-track">
            <i />
          </span>
        </div>
        <p className="fv-pro-note fv-dim">
          Bars run at real speed. Now is the median of 20 reopens.
        </p>
      </div>
      <ul className="fv-pro-cards">
        <li>
          <span className="fv-dim">Save a new chat</span>
          <b>≈ 6 ms</b>
          <span className="fv-dim">median of 30</span>
        </li>
        <li>
          <span className="fv-dim">Search 1,000 chats</span>
          <b>≈ 3 ms</b>
          <span className="fv-dim">median of 30</span>
        </li>
      </ul>
    </div>
  );
}
