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
    <div className={`e1-poster ${className ?? ""}`} aria-hidden="true">
      <div className="e1-poster-corona" />
      <div className="e1-poster-rays" />
      <svg className="e1-poster-mark" viewBox="7.3 7.3 50 50" focusable="false">
        <defs>
          <linearGradient id={`${id}-rim`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.4" stopColor="#f3e6d2" stopOpacity="0.7" />
            <stop offset="1" stopColor="#d9c4a6" stopOpacity="0.25" />
          </linearGradient>
        </defs>
        <circle cx="32.3" cy="32.3" r="24.85" fill="#000" />
        <circle
          cx="32.3"
          cy="32.3"
          r="12.15"
          fill="none"
          stroke={`url(#${id}-rim)`}
          strokeWidth="0.3"
        />
      </svg>
      <div className="e1-poster-bead" />
    </div>
  );
}
