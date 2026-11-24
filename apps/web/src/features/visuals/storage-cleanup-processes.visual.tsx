import "./storage-cleanup-processes.css";

export const label =
  "Omnyo's Left running page on macbook. The archived chat Add CSV export still has a vite dev server and a tsc watcher using 1.1 GB, counting down to their stop. Both are stopped, the total falls from 1.4 GB in 3 processes to 310 MB in 1 process, and Recent stops lists them as Chat archived. The running chat's server is left alone.";

const STOPPED = [
  {
    exe: "node",
    command: "vite --port 5174",
    memory: "612 MB",
    age: "2h 14m",
  },
  {
    exe: "node",
    command: "tsc --watch --noEmit",
    memory: "486 MB",
    age: "2h 10m",
  },
] as const;

function Actions() {
  return (
    <span className="fv-scp-actions">
      <span>Keep</span>
      <span>Stop</span>
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-storage-cleanup-processes" aria-hidden="true">
      <header className="fv-scp-head">
        <h3>Left running</h3>
        <p className="fv-scp-summary fv-soft">
          <span className="is-before">1.4 GB in 3 processes.</span>
          <span className="is-after">310 MB in 1 process.</span>
        </p>
      </header>
      <p className="fv-scp-machine fv-soft">macbook</p>
      <div className="fv-scp-group is-archived">
        <p className="fv-scp-chat">
          <b>Add CSV export</b>
          <span className="fv-dim">Archived · 1.1 GB</span>
        </p>
        <ul>
          {STOPPED.map((row) => (
            <li key={row.command} className="fv-scp-row">
              <span className="fv-scp-copy">
                <b>{row.exe}</b>
                <span className="fv-mono fv-dim">{row.command}</span>
                <span className="fv-scp-facts">
                  {row.memory} · {row.age} ·{" "}
                  <span className="fv-scp-step">
                    <span className="is-s1">Stops in 48s</span>
                    <span className="is-s2">Stops in 12s</span>
                    <span className="is-s3">Stopping now</span>
                  </span>
                </span>
              </span>
              <Actions />
            </li>
          ))}
        </ul>
      </div>
      <div className="fv-scp-rest">
        <div className="fv-scp-group">
          <p className="fv-scp-chat">
            <b>Date parser tests</b>
            <span className="fv-dim">310 MB</span>
          </p>
          <ul>
            <li className="fv-scp-row">
              <span className="fv-scp-copy">
                <b>python3</b>
                <span className="fv-mono fv-dim">-m http.server 8000</span>
                <span className="fv-scp-facts">
                  310 MB · 25m · Chat is running
                </span>
              </span>
              <Actions />
            </li>
          </ul>
        </div>
        <div className="fv-scp-stops">
          <p className="fv-soft">Recent stops</p>
          <ul>
            {STOPPED.map((row) => (
              <li key={row.command}>
                <span className="fv-mono">{row.command}</span>
                <span className="fv-dim">Chat archived</span>
              </li>
            ))}
            <li className="is-old">
              <span className="fv-mono">next dev --port 3000</span>
              <span className="fv-dim">Chat deleted</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
