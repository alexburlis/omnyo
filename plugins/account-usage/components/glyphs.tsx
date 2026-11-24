export function RestingGlyph(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className="size-2.5 shrink-0"
    >
      <circle cx="5" cy="5" r="3.9" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5 2.9V5l1.4 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CreditGlyph(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className="size-2.5 shrink-0"
    >
      <ellipse
        cx="5"
        cy="2.9"
        rx="3.6"
        ry="1.5"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M1.4 2.9v4.2c0 .83 1.61 1.5 3.6 1.5s3.6-.67 3.6-1.5V2.9M1.4 5c0 .83 1.61 1.5 3.6 1.5S8.6 5.83 8.6 5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function RefreshGlyph({
  className,
  strokeWidth,
}: {
  className: string;
  strokeWidth: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M20.4879 15C19.2524 18.4956 15.9187 21 12 21C7.02943 21 3 16.9706 3 12C3 7.02943 7.02943 3 12 3C15.7292 3 18.9286 5.26806 20.2941 8.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <path
        d="M15 9H18C19.4142 9 20.1213 9 20.5607 8.56066C21 8.12132 21 7.41421 21 6V3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}

export function DisclosureGlyph({
  className,
}: {
  className: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3.75 2.25 6.5 5 3.75 7.75"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
