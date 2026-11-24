import "./devices.css";

import type { CSSProperties } from "react";

export const label =
  "A diagram of one Omnyo setup: a phone, a browser and the desktop app steer four computers, macbook, mac-mini, win-3090 and linux-box. Every computer runs a chat, and the server badge moves from one computer to the next because any of them can host the server.";

const SCREENS = [
  { name: "Phone", kind: "phone" },
  { name: "Browser", kind: "browser" },
  { name: "Desktop app", kind: "desktop" },
] as const;

const MACHINES = [
  { name: "macbook", os: "macOS · laptop", chat: "Add CSV export" },
  { name: "mac-mini", os: "macOS · desktop", chat: "Date parser tests" },
  { name: "win-3090", os: "Windows · 3090", chat: "Fine-tune eval run" },
  { name: "linux-box", os: "Linux · always on", chat: "Weekday issue triage" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-devices" aria-hidden="true">
      <p className="fv-devices-head fv-eyebrow">Steer from</p>
      <ul className="fv-devices-screens">
        {SCREENS.map((screen) => (
          <li className="fv-devices-surface fv-panel" key={screen.name}>
            <i className={`fv-devices-icon is-${screen.kind}`} />
            {screen.name}
          </li>
        ))}
      </ul>
      <svg
        className="fv-devices-links"
        viewBox="0 0 100 62.5"
        preserveAspectRatio="none"
      >
        <path d="M 29 15.5 C 32.5 15.5, 32.5 31.25, 36 31.25" />
        <path d="M 29 31.25 L 36 31.25" />
        <path d="M 29 47 C 32.5 47, 32.5 31.25, 36 31.25" />
        <path className="is-flow" d="M 29 31.25 L 36 31.25" />
      </svg>
      <div className="fv-devices-cluster">
        <p className="fv-eyebrow">Your machines</p>
        <ul className="fv-devices-grid">
          {MACHINES.map((machine, index) => (
            <li
              className="fv-devices-machine"
              key={machine.name}
              style={{ "--i": index } as CSSProperties}
            >
              <p className="fv-devices-host">
                <i className="fv-dot fv-dot--ok" />
                <b>{machine.name}</b>
                <span className="fv-devices-badge">server</span>
              </p>
              <p className="fv-devices-os">{machine.os}</p>
              <p className="fv-devices-chat">
                <i className="fv-devices-run" />
                <span>{machine.chat}</span>
              </p>
            </li>
          ))}
        </ul>
        <p className="fv-devices-note">
          <i className="fv-devices-mark" />
          <span>Any of them can host the server</span>
        </p>
      </div>
    </div>
  );
}
