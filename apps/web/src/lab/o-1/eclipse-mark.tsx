import { useId } from "react";

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

export function EclipsePoster({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");

  return (
    <div className={`o1-poster ${className ?? ""}`} aria-hidden="true">
      <div className="o1-poster-halo" />
      <div className="o1-poster-corona" />
      <div className="o1-poster-rays" />
      <svg className="o1-poster-mark" viewBox="7.3 7.3 50 50" focusable="false">
        <defs>
          <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2a2622" />
            <stop offset="0.45" stopColor="#0b0b0d" />
            <stop offset="1" stopColor="#030304" />
          </linearGradient>
          <linearGradient id={`${id}-rim`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff4dc" />
            <stop offset="0.35" stopColor="#ffb468" />
            <stop offset="0.7" stopColor="#c2461c" />
            <stop offset="1" stopColor="#ffa25a" />
          </linearGradient>
          <radialGradient id={`${id}-bead`}>
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.5" stopColor="#fff1d6" />
            <stop offset="1" stopColor="#ffb468" />
          </radialGradient>
        </defs>
        <path
          d={O_PATH}
          fill={`url(#${id}-body)`}
          stroke={`url(#${id}-rim)`}
          strokeWidth="0.55"
          strokeLinejoin="round"
        />
        <circle cx="49.5" cy="14.5" r="6.5" fill={`url(#${id}-bead)`} />
      </svg>
      <div className="o1-poster-flare" />
    </div>
  );
}
