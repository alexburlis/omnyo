export const label =
  "The Dev servers shelf above a chat composer, listing three servers with their address, status and machine, with Open on the running one and Restart on the others.";

const SERVERS = [
  {
    address: "localhost:5174/invoices",
    status: "Running",
    machine: "studio-mac",
    tone: "ok",
    action: "Open",
  },
  {
    address: "localhost:5175/reports",
    status: "Stopped",
    machine: "build-pc",
    tone: "dim",
    action: "Restart",
  },
  {
    address: "localhost:5176/admin",
    status: "Didn't start",
    machine: "studio-mac",
    tone: "dim",
    action: "Restart",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-dev-servers" aria-hidden="true">
      <div className="fv-dev-servers-log">
        <p className="fv-dev-servers-agent">
          Added an Export CSV button to the invoices table.
        </p>
        <p className="fv-dev-servers-you">Start the invoices page for me</p>
        <p className="fv-dev-servers-agent">
          The invoices page is running. Open it from Dev servers.
        </p>
      </div>
      <div className="fv-dev-servers-shelf fv-panel">
        <p className="fv-dev-servers-head">
          <span className="fv-eyebrow">Dev servers</span>
          <span className="fv-dim">Add CSV export</span>
        </p>
        <ul className="fv-dev-servers-rows">
          {SERVERS.map((server) => (
            <li key={server.address} className={`is-${server.tone}`}>
              <i className={`fv-dot fv-dot--${server.tone}`} />
              <span className="fv-dev-servers-address">{server.address}</span>
              <span className="fv-dev-servers-status">
                {server.status} · {server.machine}
              </span>
              <span className="fv-dev-servers-action">{server.action}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="fv-dev-servers-composer">
        <span className="fv-dim">Ask for follow-up changes</span>
        <i className="fv-dev-servers-send" />
      </div>
    </div>
  );
}
