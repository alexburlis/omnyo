import type { ReactNode } from "react";

import type { Provider, ToolIcon } from "./threads";

function Svg({
  children,
  size = 14,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ProviderGlyph({
  provider,
  size = 14,
}: {
  provider: Provider;
  size?: number;
}) {
  if (provider === "claude") {
    return (
      <svg
        className="o2-glyph o2-glyph--claude"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((angle, index) => (
          <rect
            key={angle}
            x="7.25"
            y={index % 2 ? 2.4 : 1}
            width="1.5"
            height={index % 2 ? 11.2 : 14}
            rx="0.75"
            fill="currentColor"
            transform={`rotate(${angle} 8 8)`}
          />
        ))}
      </svg>
    );
  }

  return (
    <svg
      className="o2-glyph o2-glyph--codex"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z"
        strokeLinejoin="round"
      />
      <path
        d="m5.6 6.6 1.9 1.6-1.9 1.6M8.8 10h2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolGlyph({ icon }: { icon: ToolIcon }) {
  if (icon === "edit") {
    return (
      <Svg size={13}>
        <path d="M10.5 2.5 13.5 5.5 6 13H3v-3Z" />
      </Svg>
    );
  }

  if (icon === "run") {
    return (
      <Svg size={13}>
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
        <path d="m4.6 6.4 2 1.6-2 1.6M8.4 10h3" />
      </Svg>
    );
  }

  if (icon === "browser") {
    return (
      <Svg size={13}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2Z" />
      </Svg>
    );
  }

  if (icon === "list") {
    return (
      <Svg size={13}>
        <circle cx="8" cy="8" r="5.8" />
        <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      </Svg>
    );
  }

  return (
    <Svg size={13}>
      <path d="M4 1.8h5.2L12.6 5v9.2H4Z" />
      <path d="M9 1.8V5h3.6" />
    </Svg>
  );
}

export function Spinner() {
  return (
    <svg
      className="o2-spinner"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Check({ size = 12 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m3.2 8.4 3 3 6.6-6.8" strokeWidth="1.8" />
    </Svg>
  );
}

export function BranchIcon() {
  return (
    <Svg size={13}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-2 3.2-7 4" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg size={14}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function NewThreadIcon() {
  return (
    <Svg size={15}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.4v5.2M5.4 8h5.2" />
    </Svg>
  );
}

export function InboxIcon() {
  return (
    <Svg size={16}>
      <path d="M2 9.5 3.8 3.6A1.2 1.2 0 0 1 5 2.8h6a1.2 1.2 0 0 1 1.2.8L14 9.5V12a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12Z" />
      <path d="M2 9.5h3.4l.9 1.6h3.4l.9-1.6H14" />
    </Svg>
  );
}

export function LoopIcon() {
  return (
    <Svg size={15}>
      <path d="M3 7.5a5 5 0 0 1 8.6-3.4L13 5.5M13 2.5v3h-3M13 8.5a5 5 0 0 1-8.6 3.4L3 10.5M3 13.5v-3h3" />
    </Svg>
  );
}

export function BoltIcon() {
  return (
    <Svg size={15}>
      <path d="M9 1.8 3.6 9h4l-.6 5.2L12.4 7h-4Z" />
    </Svg>
  );
}

export function GridIcon() {
  return (
    <Svg size={15}>
      <rect x="2.4" y="2.4" width="4.4" height="4.4" rx="1.2" />
      <rect x="9.2" y="2.4" width="4.4" height="4.4" rx="1.2" />
      <rect x="2.4" y="9.2" width="4.4" height="4.4" rx="1.2" />
      <rect x="9.2" y="9.2" width="4.4" height="4.4" rx="1.2" />
    </Svg>
  );
}

export function GearIcon() {
  return (
    <Svg size={15}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </Svg>
  );
}

export function MicIcon() {
  return (
    <Svg size={15}>
      <rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2" />
      <path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2" />
    </Svg>
  );
}

export function ArrowUp() {
  return (
    <Svg size={14}>
      <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" strokeWidth="1.7" />
    </Svg>
  );
}

export function ChevronDown() {
  return (
    <Svg size={11}>
      <path d="m4 6 4 4 4-4" />
    </Svg>
  );
}

export function ArrowRight() {
  return (
    <Svg size={14}>
      <path d="M3 8h10M9 4l4 4-4 4" strokeWidth="1.6" />
    </Svg>
  );
}

export function AppleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.2 8.5c0-1.6 1.3-2.4 1.4-2.4-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6C4.4 4.8 3.3 5.5 2.7 6.6c-1.2 2.1-.3 5.2.9 6.9.6.8 1.2 1.7 2.1 1.7.9 0 1.2-.5 2.2-.5s1.3.5 2.2.5c.9 0 1.5-.9 2-1.7.7-1 .9-1.9.9-2-.1 0-1.8-.7-1.8-3ZM9.6 3.6c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1.1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-1Z"
      />
    </svg>
  );
}

export function LockIcon() {
  return (
    <Svg size={11}>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.6" />
      <path d="M5.4 7V5a2.6 2.6 0 0 1 5.2 0v2" />
    </Svg>
  );
}

export function CloudOff() {
  return (
    <Svg size={12}>
      <path d="M4.5 12.5h7a2.8 2.8 0 0 0 .6-5.5 4.2 4.2 0 0 0-7.8-1.4A3.5 3.5 0 0 0 4.5 12.5ZM2 2l12 12" />
    </Svg>
  );
}
