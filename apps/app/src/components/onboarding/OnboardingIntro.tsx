import "./onboarding-brand.css";
import "./onboarding-intro.css";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ONBOARDING_RING_PATH as RING_PATH } from "./OnboardingMark";

const INTRO_DURATION_MS = 4600;

const REDUCED_INTRO_DURATION_MS = 2200;

const INTRO_SKIP_MS = 320;

const WORDMARK = "Omnyo";

const ORBIT_TRAILS = [1, 2, 3, 4] as const;

const FOCUS_RINGS = [1, 2, 3, 4, 5] as const;

type IntroState = "playing" | "leaving";

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function OnboardingIntro({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<IntroState>("playing");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const duration =
      state === "leaving"
        ? INTRO_SKIP_MS
        : prefersReducedMotion()
          ? REDUCED_INTRO_DURATION_MS
          : INTRO_DURATION_MS;

    const done = window.setTimeout(() => onDoneRef.current(), duration);

    return () => window.clearTimeout(done);
  }, [state]);

  const skip = () => {
    if (state === "leaving") return;
    setState("leaving");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      skip();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div
      className="omnyo-intro"
      data-state={state}
      role="presentation"
      onPointerDown={skip}
    >
      <div className="omnyo-intro-stage">
        <div className="omnyo-intro-mark-frame">
          <div className="omnyo-intro-aurora" aria-hidden="true" />
          <div className="omnyo-intro-halo" aria-hidden="true" />
          <svg
            className="omnyo-intro-mark"
            viewBox="7 7 50 50"
            overflow="visible"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <clipPath id="omnyo-intro-ring-clip">
                <path d={RING_PATH} />
              </clipPath>
              <linearGradient
                id="omnyo-intro-sheen"
                x1="0"
                y1="0"
                x2="1"
                y2="0"
              >
                <stop offset="0" stopColor="var(--canvas)" stopOpacity="0" />
                <stop
                  offset="0.5"
                  stopColor="var(--canvas)"
                  stopOpacity="0.55"
                />
                <stop offset="1" stopColor="var(--canvas)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {FOCUS_RINGS.map((ring) => (
              <circle
                key={ring}
                className="omnyo-intro-focus"
                data-ring={ring}
                cx="32"
                cy="32"
                r="24.7"
              />
            ))}
            <g className="omnyo-intro-body">
              <path className="omnyo-intro-ring-fill" d={RING_PATH} />
              <path
                className="omnyo-intro-ring-line"
                d={RING_PATH}
                pathLength={1}
              />
              <g clipPath="url(#omnyo-intro-ring-clip)">
                <rect
                  className="omnyo-intro-sheen"
                  x="-6"
                  y="0"
                  width="18"
                  height="64"
                  fill="url(#omnyo-intro-sheen)"
                />
              </g>
              {ORBIT_TRAILS.map((trail) => (
                <g key={trail} className="omnyo-intro-orbit" data-trail={trail}>
                  <circle
                    className="omnyo-intro-trail"
                    cx="49.5"
                    cy="14.5"
                    r={6.5 - trail * 1.1}
                  />
                </g>
              ))}
              <g className="omnyo-intro-orbit">
                <circle
                  className="omnyo-intro-dot"
                  cx="49.5"
                  cy="14.5"
                  r="6.5"
                />
              </g>
              <circle
                className="omnyo-intro-wave"
                cx="49.5"
                cy="14.5"
                r="6.5"
              />
              <circle
                className="omnyo-intro-wave"
                data-wave="wide"
                cx="49.5"
                cy="14.5"
                r="6.5"
              />
            </g>
          </svg>
        </div>
        <h1
          className="omnyo-intro-wordmark text-display font-semibold"
          aria-label={WORDMARK}
        >
          {Array.from(WORDMARK, (letter, index) => (
            <span
              key={index}
              aria-hidden="true"
              style={{ "--letter": index } as CSSProperties}
            >
              {letter}
            </span>
          ))}
        </h1>
        <p className="omnyo-intro-tagline text-sm text-muted-foreground">
          The unified interface for coding agents
        </p>
      </div>
    </div>
  );
}
