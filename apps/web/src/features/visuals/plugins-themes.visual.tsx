import "./plugins-themes.css";

import type { CSSProperties } from "react";

export const label =
  "Settings, Appearance in Omnyo with the Dark theme selected. The palette moves from Default to Nord, Dracula and Catppuccin, and the preview of the app repaints with each one. Below, a custom theme.css file is listed.";

interface Palette {
  id: string;
  name: string;
  canvas: string;
  ink: string;
  primary: string;
  success: string;
  warning: string;
  animated: boolean;
}

const PALETTES: readonly Palette[] = [
  {
    id: "default",
    name: "Default",
    canvas: "var(--fv-canvas)",
    ink: "var(--fv-ink)",
    primary: "var(--fv-info)",
    success: "var(--fv-ok)",
    warning: "var(--fv-attn-text)",
    animated: true,
  },
  {
    id: "nord",
    name: "Nord",
    canvas: "#2e3440",
    ink: "#d8dee9",
    primary: "#88c0d0",
    success: "#a3be8c",
    warning: "#d08770",
    animated: true,
  },
  {
    id: "dracula",
    name: "Dracula",
    canvas: "#282a36",
    ink: "#f8f8f2",
    primary: "#bd93f9",
    success: "#50fa7b",
    warning: "#ffb86c",
    animated: true,
  },
  {
    id: "solarized",
    name: "Solarized",
    canvas: "#002b36",
    ink: "#93a1a1",
    primary: "#268bd2",
    success: "#859900",
    warning: "#cb4b16",
    animated: false,
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    canvas: "#282828",
    ink: "#ebdbb2",
    primary: "#83a598",
    success: "#b8bb26",
    warning: "#fe8019",
    animated: false,
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    canvas: "#1e1e2e",
    ink: "#cdd6f4",
    primary: "#cba6f7",
    success: "#a6e3a1",
    warning: "#f9e2af",
    animated: true,
  },
];

const SHOWN = PALETTES.filter((palette) => palette.animated);

const tokens = (palette: Palette) =>
  ({
    "--pt-canvas": palette.canvas,
    "--pt-ink": palette.ink,
    "--pt-primary": palette.primary,
    "--pt-success": palette.success,
    "--pt-warning": palette.warning,
  }) as CSSProperties;

function Preview({ palette, index }: { palette: Palette; index: number }) {
  return (
    <div className={`fv-pt-preview is-p${index}`} style={tokens(palette)}>
      <div className="fv-pt-side">
        <i className="fv-pt-dot" />
        <p className="is-on">Add CSV export</p>
        <p>Date parser tests</p>
        <p>Review: Add CSV export</p>
      </div>
      <div className="fv-pt-main">
        <p className="fv-pt-you">Add a CSV export to invoices</p>
        <p className="fv-pt-agent">Added exportCsv() and 6 tests.</p>
        <p className="fv-pt-diff">
          <span className="is-add">+ export function exportCsv(rows)</span>
          <span className="is-del">- // TODO: export</span>
        </p>
        <p className="fv-pt-row">
          <span className="fv-pt-chip">
            <i />
            Done
          </span>
          <span className="fv-pt-send">Send</span>
        </p>
      </div>
    </div>
  );
}

export function Visual() {
  return (
    <div className="fv fv-plugins-themes" aria-hidden="true">
      <nav className="fv-pt-nav">
        <p className="fv-eyebrow">Settings</p>
        <p>General</p>
        <p className="is-on">Appearance</p>
        <p>Keyboard</p>
        <p>Plugins</p>
        <p>Privacy</p>
      </nav>
      <div className="fv-pt-body">
        <h3 className="fv-pt-title">Appearance</h3>
        <div className="fv-pt-field">
          <span>Theme</span>
          <span className="fv-pt-seg">
            <i>System</i>
            <i>Light</i>
            <i>Dark</i>
          </span>
        </div>
        <div className="fv-pt-field is-palette">
          <span>Palette</span>
          <ul className="fv-pt-chips">
            {PALETTES.map((palette) => {
              const shown = SHOWN.indexOf(palette);

              return (
                <li
                  key={palette.id}
                  className={shown === -1 ? "" : `is-p${shown}`}
                  style={tokens(palette)}
                >
                  <i />
                  {palette.name}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="fv-pt-stage">
          {SHOWN.map((palette, index) => (
            <Preview key={palette.id} palette={palette} index={index} />
          ))}
        </div>
        <p className="fv-pt-custom">
          <span className="fv-mono">theme.css</span>
          <span className="fv-dim">Custom theme from your theme folder</span>
        </p>
      </div>
    </div>
  );
}
