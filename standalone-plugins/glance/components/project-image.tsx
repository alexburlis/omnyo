import { useEffect, useRef, useState } from "react";
import { experimental_ImagePreview as ImagePreview, useSdk } from "@omnyo/plugin-sdk/app";
import type { ProjectImage } from "../contract";

const imageLimit = 4 * 1024 * 1024;

export function imageBytesMatch(bytes: Uint8Array, mimeType: ProjectImage["mimeType"]): boolean {
  if (mimeType === "image/png")
    return (
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    );

  if (mimeType === "image/jpeg")
    return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;

  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

export function ProjectImagePreview({ image, title }: { image: ProjectImage; title: string }) {
  const sdk = useSdk();
  const element = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ url: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${image.projectId}:${image.path}:${image.mimeType}`;

  useEffect(() => {
    const target = element.current;

    if (target === null || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequested(true);
        observer.disconnect();
      }
    });

    observer.observe(target);

    return () => observer.disconnect();
  }, [key]);

  useEffect(() => {
    if (!requested) return;

    const controller = new AbortController();
    let url: string | null = null;
    setResult(null);
    setError(null);

    void sdk.projects.attachments
      .read({
        projectId: image.projectId,
        path: image.path,
        signal: controller.signal,
      })
      .then((attachment) => {
        if (controller.signal.aborted) return;

        if (attachment.sizeBytes > imageLimit || attachment.bytes.byteLength > imageLimit)
          throw new Error("The preview exceeds the 4 MB image limit.");

        if (
          attachment.mimeType.split(";")[0]?.trim() !== image.mimeType ||
          !imageBytesMatch(attachment.bytes, image.mimeType)
        )
          throw new Error("The attachment does not match its image format.");

        url = URL.createObjectURL(
          new Blob([new Uint8Array(attachment.bytes)], { type: image.mimeType }),
        );
        setResult({ url, key });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "The image could not be loaded.");
      });

    return () => {
      controller.abort();

      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [image.projectId, image.path, image.mimeType, key, requested, retry, sdk]);

  return (
    <div ref={element} className="min-w-0 space-y-1" data-glance-visual="">
      {image.role === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {image.role === "before" ? "Before" : "Result"}
        </p>
      )}
      {result !== null && result.key === key ? (
        <ImagePreview
          src={result.url}
          alt={image.alt}
          title={title}
          mimeType={image.mimeType}
          className="max-h-64 max-w-full"
        />
      ) : error === null ? (
        <button
          type="button"
          className="text-sm underline"
          disabled={requested}
          onClick={() => setRequested(true)}
        >
          {requested ? "Loading image…" : "View image"}
        </button>
      ) : (
        <div role="alert" className="text-sm text-destructive">
          <p>{error}</p>
          <button
            type="button"
            className="underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry image
          </button>
        </div>
      )}
    </div>
  );
}
