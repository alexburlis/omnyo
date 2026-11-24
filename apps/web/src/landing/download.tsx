import "./download.css";

import { sendSiteUsage } from "../analytics/usage";

import {
  DIRECT_DOWNLOADS,
  FALLBACK_DOWNLOAD,
  PLATFORMS_ANCHOR,
  PLATFORMS,
  type PlatformId,
  platformHref,
} from "./platforms";
import type { PublicMacDownload } from "./site";

const GLYPHS: Record<PlatformId, readonly string[]> = {
  mac: ["M5 6.5h14v9H5z", "M2.5 18.5h19"],
  windows: ["M3.5 5h17v11h-17z", "M9 20h6", "M12 16v4"],
  ios: [
    "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3Z",
    "M10.5 18.2h3",
  ],
  web: ["M3.5 5.5h17v13h-17z", "M3.5 9.5h17", "M6.2 7.5h.01", "M8.6 7.5h.01"],
  android: [
    "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3Z",
    "M12 5.8h.01",
  ],
};

export function PlatformGlyph({ id }: { id: PlatformId }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="get-glyph">
      {GLYPHS[id].map((path) => (
        <path
          key={path}
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

const ARROWS = {
  down: "M8 3v10m0 0-4-4m4 4 4-4",
  next: "M3 8h10m0 0L9 4m4 4-4 4",
} as const;

export function GetArrow({ kind }: { kind: keyof typeof ARROWS }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`get-arrow get-arrow--${kind}`}
    >
      <path
        d={ARROWS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type DownloadProps = { macDownload?: PublicMacDownload | null };

export function DownloadButton({
  size = "md",
  macDownload,
}: DownloadProps & { size?: "md" | "lg" }) {
  return (
    <span className="get-set">
      {DIRECT_DOWNLOADS.map((entry) => {
        const href =
          entry.id === "mac" && macDownload
            ? macDownload.url
            : platformHref(entry.id);

        const className = `get-btn get-btn--${size} get-for get-for--${entry.id}`;

        const body = (
          <>
            <PlatformGlyph id={entry.id} />
            <span className="get-label">{entry.label}</span>
            {entry.tabletLabel ? (
              <span className="get-label get-label--tablet">
                {entry.tabletLabel}
              </span>
            ) : null}
          </>
        );

        return (
          <a
            key={entry.id}
            className={className}
            href={href ?? PLATFORMS_ANCHOR}
            onClick={
              href
                ? () => sendSiteUsage({ name: "download_click", os: entry.id })
                : undefined
            }
          >
            {body}
          </a>
        );
      })}
      <a
        className={`get-btn get-btn--${size} get-for get-for--any`}
        href={PLATFORMS_ANCHOR}
      >
        <span className="get-label">{FALLBACK_DOWNLOAD.label}</span>
        <GetArrow kind="next" />
      </a>
    </span>
  );
}

export function DownloadNote({ macDownload }: DownloadProps) {
  return (
    <span className="get-notes">
      {DIRECT_DOWNLOADS.map((entry) => (
        <span key={entry.id} className={`get-for get-for--${entry.id}`}>
          {entry.id === "mac" && macDownload && <>v{macDownload.version} · </>}
          {entry.note}
        </span>
      ))}
      <span className="get-for get-for--any">{FALLBACK_DOWNLOAD.note}</span>
    </span>
  );
}

function recordDownload(id: PlatformId): void {
  if (id !== "web") sendSiteUsage({ name: "download_click", os: id });
}

export function PlatformRail({ macDownload }: DownloadProps) {
  return (
    <ul className="get-rail" aria-label="Omnyo on every platform">
      {PLATFORMS.map((platform) => {
        const download = platform.id === "mac" ? macDownload : null;
        const href = download?.url ?? platform.href;

        const body = (
          <>
            <PlatformGlyph id={platform.id} />
            <span className="get-rail-text">
              <span className="get-rail-name">{platform.name}</span>
              <span className="get-rail-action">{platform.action}</span>
              {download && (
                <span className="get-rail-version">v{download.version}</span>
              )}
              <span className="get-rail-here">This device</span>
            </span>
            {href ? <GetArrow kind="down" /> : null}
          </>
        );

        return (
          <li
            key={platform.id}
            className={`get-rail-item get-is--${platform.id}`}
          >
            {href ? (
              <a
                className="get-rail-cell"
                href={href}
                onClick={() => recordDownload(platform.id)}
              >
                {body}
              </a>
            ) : (
              <span
                className={
                  platform.soon ? "get-rail-cell is-soon" : "get-rail-cell"
                }
              >
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DownloadPanel({ macDownload }: DownloadProps) {
  return (
    <div className="get-panel">
      <div className="get-primary">
        <DownloadButton size="lg" macDownload={macDownload} />
        <DownloadNote macDownload={macDownload} />
      </div>
      <div className="get-all">
        <p className="get-all-label">
          <span className="get-pick get-pick--mac">Or get it for</span>
          <span className="get-pick get-pick--other">Choose your platform</span>
        </p>
        <PlatformRail macDownload={macDownload} />
      </div>
    </div>
  );
}
