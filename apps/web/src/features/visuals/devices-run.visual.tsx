export const label =
  "A new chat in Omnyo with the machine menu open. macbook, mac-mini and win-3090 are ready, linux-box is not set up for this project, and the pick moves from macbook to win-3090 for a GPU job. Host limits show one chat per processor on each machine, and waiting chats can start on a free machine.";

const OPTIONS = [
  { name: "macbook", meta: "macOS · this machine", state: "first" },
  { name: "mac-mini", meta: "macOS", state: "ready" },
  { name: "win-3090", meta: "Windows · NVIDIA GPU", state: "pick" },
  { name: "linux-box", meta: "Not set up for this project", state: "off" },
] as const;

const LIMITS = [
  { name: "macbook", facts: "10 processors · macOS arm64", limit: 10 },
  {
    name: "win-3090",
    facts: "24 processors · Windows x64 · RTX 3090",
    limit: 24,
  },
  { name: "linux-box", facts: "16 processors · Linux x64", limit: 16 },
] as const;

function Check() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function Laptop() {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="4.5" y="5.5" width="15" height="10.5" rx="1.4" />
      <path d="M2.5 18.5h19" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-dt fv-dn" aria-hidden="true">
      <div className="dn-side">
        <p className="dn-side-title">Host limits</p>
        <p className="dn-flow">
          <span>Start waiting chats on a free machine</span>
          <i className="dn-toggle" />
        </p>
        {LIMITS.map((host) => (
          <p className="dn-limit" key={host.name}>
            <span>
              <b>{host.name}</b>
              <small>{host.facts}</small>
            </span>
            <em>Auto ({host.limit})</em>
          </p>
        ))}
      </div>
      <div className="dn-pop">
        <p className="dn-pop-title">Machine</p>
        {OPTIONS.map((option) => (
          <p className={`dn-opt is-${option.state}`} key={option.name}>
            <i />
            <Laptop />
            <span className="dn-opt-text">
              <b>{option.name}</b>
              <small>{option.meta}</small>
            </span>
            {option.state === "first" ? (
              <span className="dn-check dt-a">
                <Check />
              </span>
            ) : null}
            {option.state === "pick" ? (
              <span className="dn-check dt-b">
                <Check />
              </span>
            ) : null}
          </p>
        ))}
      </div>
      <div className="dn-composer">
        <p className="dn-text">
          Fine-tune the eval model and report the scores
          <i />
        </p>
        <p className="dn-chips">
          <span className="dn-chip">harbor-ledger</span>
          <span className="dn-chip is-machine">
            <Laptop />
            <span className="dt-swap">
              <span className="dt-a">macbook</span>
              <span className="dt-b">win-3090</span>
            </span>
          </span>
          <span className="dn-chip">feat/csv-export</span>
          <span className="dn-send">
            <svg viewBox="0 0 24 24">
              <path d="M12 19V5m0 0-6 6m6-6 6 6" />
            </svg>
          </span>
        </p>
      </div>
    </div>
  );
}
