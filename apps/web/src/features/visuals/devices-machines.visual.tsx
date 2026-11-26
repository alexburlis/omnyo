export const label =
  "Settings, Machines: four computers connected to one Omnyo server. macbook is this machine and the server, and mac-mini, win-3090 and linux-box run agents for it. Each row shows its status, system and running chats, and a setting picks the default machine for new chats.";

const ICONS = {
  laptop: (
    <>
      <rect x="4.5" y="5.5" width="15" height="10.5" rx="1.4" />
      <path d="M2.5 18.5h19" />
    </>
  ),
  mini: (
    <>
      <path d="M6.2 9.5 7.4 7h9.2l1.2 2.5" />
      <rect x="3.5" y="9.5" width="17" height="7.5" rx="2" />
    </>
  ),
  tower: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="1.6" />
      <circle cx="12" cy="9" r="2.2" />
    </>
  ),
  rack: (
    <>
      <rect x="3.5" y="5.5" width="17" height="5.5" rx="1.2" />
      <rect x="3.5" y="13" width="17" height="5.5" rx="1.2" />
    </>
  ),
} as const;

const MACHINES = [
  {
    name: "macbook",
    icon: "laptop",
    badges: ["this machine", "server"],
    sub: ["macOS", "3 projects"],
    runs: 2,
  },
  {
    name: "mac-mini",
    icon: "mini",
    badges: [],
    sub: ["macOS", "2 projects"],
    runs: 1,
  },
  {
    name: "win-3090",
    icon: "tower",
    badges: [],
    sub: ["Windows", "1 project"],
    runs: 1,
  },
  {
    name: "linux-box",
    icon: "rack",
    badges: [],
    sub: ["Linux", "2 projects"],
    runs: 3,
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-dt fv-dm" aria-hidden="true">
      <div className="dm-head">
        <div>
          <h3>Machines</h3>
          <p>Computers that run chats for this server</p>
        </div>
        <span className="dm-add">
          <svg viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add a machine
        </span>
      </div>
      <ul className="dm-list">
        {MACHINES.map((machine) => (
          <li
            className={`dm-row ${machine.badges.length > 0 ? "is-server" : ""}`}
            key={machine.name}
          >
            <span className="dt-icon">
              <svg viewBox="0 0 24 24">{ICONS[machine.icon]}</svg>
            </span>
            <span className="dm-main">
              <span className="dm-name">
                {machine.name}
                {machine.badges.map((badge) => (
                  <span
                    className={`dt-badge ${badge === "server" ? "is-server" : ""}`}
                    key={badge}
                  >
                    {badge}
                  </span>
                ))}
              </span>
              <span className="dm-sub">
                <i className="fv-dot fv-dot--ok" />
                Online · {machine.sub.join(" · ")}
              </span>
            </span>
            <span className="dm-runs">
              <i className="fv-dot fv-dot--ok dt-live" />
              {machine.runs} running
            </span>
            <svg className="dm-chev" viewBox="0 0 24 24">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </li>
        ))}
      </ul>
      <p className="dm-default">
        <span>Default machine for new chats</span>
        <span className="dm-select">
          win-3090
          <svg viewBox="0 0 24 24">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </span>
      </p>
    </div>
  );
}
