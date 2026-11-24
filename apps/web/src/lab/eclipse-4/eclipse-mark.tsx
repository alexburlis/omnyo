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
  return (
    <div className={`e4-poster ${className ?? ""}`} aria-hidden="true">
      <div className="e4-poster-halo" />
      <div className="e4-poster-rays" />
      <div className="e4-poster-corona" />
      <div className="e4-poster-moon" />
      <div className="e4-poster-bead" />
      <div className="e4-poster-flare" />
    </div>
  );
}
