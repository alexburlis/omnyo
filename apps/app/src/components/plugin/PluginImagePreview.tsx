import { useState } from "react";
import type { ExperimentalImagePreviewProps } from "@omnyo/plugin-sdk";
import { ImageLightbox } from "@/components/ui/image-lightbox";

export function PluginImagePreview({
  src,
  alt,
  title = alt,
  className,
  mimeType,
}: ExperimentalImagePreviewProps) {
  const [expanded, setExpanded] = useState(false);
  let safe = false;

  try {
    const url = new URL(src);
    safe =
      url.protocol === "blob:" &&
      url.origin === location.origin &&
      ["image/png", "image/jpeg", "image/webp"].includes(mimeType);
  } catch {
    safe = false;
  }

  if (!safe) return <span role="alert">Image preview is unavailable</span>;

  return (
    <>
      <button
        type="button"
        aria-label={`Open ${alt}`}
        onClick={() => setExpanded(true)}
        className={className}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="max-h-64 max-w-full object-contain"
        />
      </button>
      <ImageLightbox
        imageSrc={expanded ? src : null}
        imageAlt={alt}
        title={title}
        onClose={() => setExpanded(false)}
      />
    </>
  );
}
