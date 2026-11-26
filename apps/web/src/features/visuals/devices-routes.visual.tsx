import type { CSSProperties } from "react";

export const label =
  "Three ways your devices reach the Omnyo server: Omnyo connect through the omnyo.link relay, where TLS ends at the relay; Tailscale Serve, which keeps traffic on your tailnet; and a direct address on a trusted local network, which has no sign-in.";

const ROUTES = [
  {
    id: "connect",
    name: "Omnyo connect",
    via: "you.omnyo.link",
    note: "Free account · TLS ends at the relay",
    color: "var(--fv-accent)",
    wait: "0s",
  },
  {
    id: "tailscale",
    name: "Tailscale Serve",
    via: "macbook.tailnet.ts.net",
    note: "Stays on your tailnet",
    color: "var(--fv-info)",
    wait: "-1.1s",
  },
  {
    id: "lan",
    name: "Local network",
    via: "192.168.1.20:38886",
    note: "No sign-in · trusted networks only",
    color: "var(--fv-soft)",
    wait: "-2.2s",
  },
] as const;

const DEVICES = [
  <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
    <path d="M11 18.5h2" />
  </>,
  <>
    <rect x="4.5" y="5.5" width="15" height="10.5" rx="1.4" />
    <path d="M2.5 18.5h19" />
  </>,
  <>
    <rect x="7" y="3" width="10" height="18" rx="1.6" />
    <circle cx="12" cy="9" r="2.2" />
  </>,
];

export function Visual() {
  return (
    <div className="fv fv-dt fv-dr" aria-hidden="true">
      <div className="dr-col dr-from">
        <p className="fv-eyebrow dr-eyebrow">Devices</p>
        <span className="dr-devices">
          {DEVICES.map((icon, index) => (
            <span className="dt-icon" key={index}>
              <svg viewBox="0 0 24 24">{icon}</svg>
            </span>
          ))}
        </span>
      </div>
      <ul className="dr-lanes">
        {ROUTES.map((route) => (
          <li
            className={`dr-lane is-${route.id}`}
            key={route.id}
            style={
              {
                "--dr-c": route.color,
                "--dr-wait": route.wait,
              } as CSSProperties
            }
          >
            <i className="dr-wire" />
            <i className="dr-packet" />
            <span className="dr-station">
              <b>{route.name}</b>
              <span>{route.via}</span>
              <small>{route.note}</small>
            </span>
          </li>
        ))}
      </ul>
      <div className="dr-col dr-to">
        <p className="fv-eyebrow dr-eyebrow">Server</p>
        <span className="dr-server">
          <b>macbook</b>
          <small>Chats, database and settings</small>
          <span className="dt-badge is-server">server</span>
        </span>
      </div>
    </div>
  );
}
