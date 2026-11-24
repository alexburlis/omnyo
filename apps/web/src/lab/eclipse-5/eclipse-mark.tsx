import { type RefObject, useId } from "react";

import { APPROACH, SUN_TO_MOON } from "./path";

const O_PATH =
  "M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z";

export function FlatMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="7.3 7.3 50 50"
      aria-hidden="true"
      focusable="false"
    >
      <path d={O_PATH} fill="currentColor" />
      <circle cx="49.5" cy="14.5" r="6.5" fill="currentColor" />
    </svg>
  );
}

export function PhaseGlyph({
  c,
  className,
}: {
  c: number;
  className?: string;
}) {
  const sun = 7;
  const moon = sun / SUN_TO_MOON;
  const distance = (1 - c) * (sun + moon);
  const id = useId().replace(/:/g, "");

  return (
    <svg
      className={`e5-glyph ${className ?? ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={`${id}-m`}>
          <rect width="24" height="24" fill="#fff" />
          <circle
            cx={12 + APPROACH.x * distance}
            cy={12 + APPROACH.y * distance}
            r={moon}
            fill="#000"
          />
        </mask>
      </defs>
      {c > 0.97 ? (
        <circle cx="12" cy="12" r="10.5" className="e5-glyph-corona" />
      ) : null}
      <circle
        cx="12"
        cy="12"
        r={sun}
        className="e5-glyph-sun"
        mask={`url(#${id}-m)`}
      />
      <circle
        cx={12 + APPROACH.x * distance}
        cy={12 + APPROACH.y * distance}
        r={moon}
        className="e5-glyph-moon"
      />
    </svg>
  );
}

export function EclipsePoster({
  posterRef,
}: {
  posterRef: RefObject<HTMLDivElement | null>;
}) {
  const id = useId().replace(/:/g, "");

  return (
    <div ref={posterRef} className="e5-poster" aria-hidden="true">
      <div className="e5-poster-sky e5-poster-sky--day" />
      <div className="e5-poster-sky e5-poster-sky--night" />
      <div className="e5-poster-sunset" />
      <div className="e5-poster-aureole" />
      <div className="e5-poster-corona" />
      <div className="e5-poster-sun" />
      <svg
        className="e5-poster-moon"
        viewBox="-50 -50 100 100"
        focusable="false"
      >
        <defs>
          <linearGradient id={`${id}-rim`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff4dc" />
            <stop offset="0.35" stopColor="#ffb468" />
            <stop offset="0.7" stopColor="#3a2418" />
            <stop offset="1" stopColor="#8a5a3a" />
          </linearGradient>
          <radialGradient id={`${id}-body`} cx="0.62" cy="0.36" r="0.75">
            <stop offset="0" stopColor="#24201f" />
            <stop offset="0.7" stopColor="#0b0b0e" />
            <stop offset="1" stopColor="#040405" />
          </radialGradient>
        </defs>
        <circle r="49" fill={`url(#${id}-body)`} />
        <circle r="40" fill="none" stroke="#141215" strokeWidth="3" />
        <circle r="31" fill="none" stroke="#1d1a1a" strokeWidth="2" />
        <circle r="27" fill="#030304" />
        <circle
          r="48.6"
          fill="none"
          stroke={`url(#${id}-rim)`}
          strokeWidth="1.2"
        />
      </svg>
      <svg
        className="e5-poster-ridge"
        viewBox="0 0 1200 80"
        preserveAspectRatio="none"
        focusable="false"
      >
        <path d="M0 52 C80 40 130 46 190 34 S320 18 380 30 S470 48 560 38 S700 14 790 26 S900 44 980 36 S1110 22 1200 34 V80 H0Z" />
      </svg>
    </div>
  );
}
