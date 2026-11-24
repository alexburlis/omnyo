import "./theme-toggle.css";

import { useId, useSyncExternalStore } from "react";

import {
  type Theme,
  currentTheme,
  setTheme,
  subscribeTheme,
} from "../lib/theme";

const REVEAL_MS = 820;

const REVEAL_EASING = "cubic-bezier(0.7, 0, 0.25, 1)";

const RIM_WIDTH = 2;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const RAYS = Array.from({ length: 8 }, (_, index) => index * 45);

function revealTheme(theme: Theme, x: number, y: number): void {
  if (
    !("startViewTransition" in document) ||
    matchMedia(REDUCED_MOTION).matches
  ) {
    setTheme(theme);

    return;
  }

  const root = document.documentElement;
  const rim = document.createElement("div");
  const at = `at ${x.toFixed(1)}px ${y.toFixed(1)}px`;

  const radius =
    Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) +
    RIM_WIDTH * 2;

  rim.className = "theme-rim";
  rim.setAttribute("aria-hidden", "true");
  rim.style.setProperty("--rim-x", `${x.toFixed(1)}px`);
  rim.style.setProperty("--rim-y", `${y.toFixed(1)}px`);
  root.classList.add("theme-reveal");

  const transition = document.startViewTransition(() => {
    setTheme(theme);
    document.body.append(rim);
  });

  const finish = () => {
    rim.remove();
    root.classList.remove("theme-reveal");
  };

  const timing = { duration: REVEAL_MS, easing: REVEAL_EASING };

  transition.ready.then(() => {
    root.animate(
      {
        clipPath: [`circle(0px ${at})`, `circle(${radius.toFixed(1)}px ${at})`],
      },
      { ...timing, pseudoElement: "::view-transition-new(root)" },
    );
    rim.animate({ "--rim-r": ["0px", `${radius.toFixed(1)}px`] }, timing);
  }, finish);

  transition.finished.then(finish, finish);
}

const readServerTheme = () => null;

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    currentTheme,
    readServerTheme,
  );

  const mask = `theme-toggle-${useId().replace(/:/g, "")}`;

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Dark mode"
      aria-pressed={theme === null ? undefined : theme === "dark"}
      title={
        theme === null
          ? undefined
          : `Switch to ${theme === "dark" ? "light" : "dark"} mode`
      }
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();

        revealTheme(
          currentTheme() === "dark" ? "light" : "dark",
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
      }}
    >
      <svg
        className="theme-toggle-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <mask id={mask}>
          <rect width="24" height="24" fill="#fff" />
          <circle className="theme-toggle-bite" cx="12" cy="12" r="7" />
        </mask>
        <circle
          className="theme-toggle-core"
          cx="12"
          cy="12"
          r="5"
          mask={`url(#${mask})`}
        />
        <g className="theme-toggle-rays">
          {RAYS.map((angle) => (
            <line
              key={angle}
              x1="12"
              y1="2.4"
              x2="12"
              y2="4.2"
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
        </g>
      </svg>
    </button>
  );
}
