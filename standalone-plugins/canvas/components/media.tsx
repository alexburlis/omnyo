import { useEffect, useRef, useState } from "react";
import { experimental_usePluginId } from "@omnyo/plugin-sdk/app";
import { mediaManifestSchema, type MediaManifest } from "../media-contract";

const manifests = new Map<string, Promise<MediaManifest>>();

function readManifest(url: string, retry: boolean): Promise<MediaManifest> {
  if (retry) manifests.delete(url);
  const known = manifests.get(url);

  if (known) return known;

  const pending = fetch(url).then(async (response) => {
    if (!response.ok) throw new Error("The image preview could not load.");

    return mediaManifestSchema.parse(await response.json());
  });

  manifests.set(url, pending);

  while (manifests.size > 128) {
    const oldest = manifests.keys().next().value;

    if (oldest === undefined) break;
    manifests.delete(oldest);
  }

  void pending.catch(() => {
    if (manifests.get(url) === pending) manifests.delete(url);
  });

  return pending;
}

export function ResponsiveMedia({
  assetId,
  title,
  zoom,
  onReady,
}: {
  assetId: string;
  title: string;
  zoom: number;
  onReady?(assetId: string): void;
}) {
  const pluginId = experimental_usePluginId();
  const base = `/api/v1/plugins/${pluginId}/http`;
  const anchor = useRef<HTMLAnchorElement>(null);
  const [manifest, setManifest] = useState<MediaManifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(640);
  const readyListener = useRef(onReady);
  readyListener.current = onReady;

  useEffect(() => {
    let current = true;
    setManifest(null);
    setFailed(false);
    void readManifest(`${base}/asset-info?id=${assetId}`, attempt > 0).then(
      (value) => {
        if (!current) return;
        setManifest(value);
        readyListener.current?.(assetId);
      },
      () => {
        if (!current) return;
        setFailed(true);
        readyListener.current?.(assetId);
      },
    );

    return () => {
      current = false;
    };
  }, [assetId, base, attempt]);

  useEffect(() => {
    const target = anchor.current;

    if (target === null) return;

    const measure = () => {
      if (target.clientWidth > 0) setWidth(target.clientWidth);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);

    return () => observer.disconnect();
  }, [manifest]);

  if (failed)
    return (
      <div role="alert">
        Image preview could not load.{" "}
        <button
          type="button"
          className="cnv-button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );

  if (manifest === null)
    return <div aria-label="Loading image" aria-busy="true" style={{ aspectRatio: "16 / 9" }} />;

  const preview =
    manifest.variants.find((variant) => variant.width >= 1280) ?? manifest.variants[0];

  return (
    <a
      ref={anchor}
      href={manifest.originalUrl}
      target="_blank"
      rel="noreferrer"
      style={{ display: "block" }}
    >
      <img
        src={preview?.url ?? manifest.originalUrl}
        srcSet={
          manifest.variants.length > 0
            ? manifest.variants.map((variant) => `${variant.url} ${variant.width}w`).join(", ")
            : undefined
        }
        sizes={`${Math.max(1, Math.ceil(width * zoom))}px`}
        width={manifest.width}
        height={manifest.height}
        alt={title}
        draggable={false}
        decoding="async"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "auto" }}
      />
    </a>
  );
}
