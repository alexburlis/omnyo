import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ExperimentalProjectIconProps } from "@omnyo/plugin-sdk/app";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  projectMonogram,
  projectMonogramHue,
  selectProjectIconSource,
  useProjectIcon,
  type ProjectIconProject,
} from "./useProjectIcon";

interface ProjectMonogramStyle extends CSSProperties {
  "--omnyo-project-hue": string;
}

export function monogramStyle(projectId: string): ProjectMonogramStyle {
  return { "--omnyo-project-hue": String(projectMonogramHue(projectId)) };
}

const FACE_CLASS =
  "grid size-full place-items-center bg-[color-mix(in_oklab,oklch(0.62_0.12_var(--omnyo-project-hue))_45%,var(--canvas))] font-bold tracking-tight text-sidebar-foreground";

const FACE_VARIANTS = {
  tile: {
    face: FACE_CLASS,
    monogram: (monogram: string) =>
      Array.from(monogram).length > 1 ? "text-sm" : "text-base",
    glyph: "size-5.5",
  },
  inline: { face: FACE_CLASS, monogram: () => "", glyph: "size-[60%]" },
} as const;

export type IconTone = "artwork" | "mark" | "dark-mark" | "light-mark";

const ICON_TONE_SAMPLE_SIZE = 16;

const ICON_TONE_PLATE_CLASS =
  "isolate bg-[color-mix(in_oklch,var(--ink)_12%,var(--canvas))]";

const ICON_TONE_IMAGE_CLASS: Readonly<Record<IconTone, string>> = {
  artwork: "",
  mark: "",
  "dark-mark": "dark:mix-blend-lighten dark:invert dark:hue-rotate-180",
  "light-mark": "invert hue-rotate-180 dark:invert-0 dark:hue-rotate-0",
};

const measuredIconTones = new Map<string, IconTone>();

function pixelLuma(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

export function classifyIconPixels(
  pixels: Uint8ClampedArray,
  size: number,
): IconTone {
  let edges = 0;
  let clearEdges = 0;
  let paleEdges = 0;
  let markWeight = 0;
  let markLuma = 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const alpha = pixels[offset + 3] ?? 0;
      const luma = pixelLuma(red, green, blue);
      const isEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;

      if (isEdge) {
        edges += 1;

        if (alpha < 32) clearEdges += 1;
        else if (
          luma > 0.8 &&
          Math.max(red, green, blue) - Math.min(red, green, blue) < 48
        ) {
          paleEdges += 1;
        }
      }

      if (alpha >= 32) {
        markWeight += alpha;
        markLuma += luma * alpha;
      }
    }
  }

  if (clearEdges * 2 >= edges) {
    if (markWeight === 0) return "mark";

    const luma = markLuma / markWeight;

    return luma < 0.35 ? "dark-mark" : luma > 0.75 ? "light-mark" : "mark";
  }

  return paleEdges * 5 >= edges * 3 ? "dark-mark" : "artwork";
}

function measureIconTone(image: HTMLImageElement): IconTone {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_TONE_SAMPLE_SIZE;
  canvas.height = ICON_TONE_SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (context === null) return "artwork";

  context.drawImage(image, 0, 0, ICON_TONE_SAMPLE_SIZE, ICON_TONE_SAMPLE_SIZE);

  return classifyIconPixels(
    context.getImageData(0, 0, ICON_TONE_SAMPLE_SIZE, ICON_TONE_SAMPLE_SIZE)
      .data,
    ICON_TONE_SAMPLE_SIZE,
  );
}

function sampleIconTone(image: HTMLImageElement): IconTone {
  try {
    return measureIconTone(image);
  } catch {
    return "artwork";
  }
}

export function TileIconImage({
  src,
  onError,
}: {
  src: string;
  onError: () => void;
}) {
  const [measured, setMeasured] = useState<{
    src: string;
    tone: IconTone;
  } | null>(null);

  const tone = !src.startsWith("data:")
    ? "artwork"
    : measured?.src === src
      ? measured.tone
      : measuredIconTones.get(src);

  const measure = (image: HTMLImageElement) => {
    const known = measuredIconTones.get(src) ?? sampleIconTone(image);
    measuredIconTones.set(src, known);
    setMeasured({ src, tone: known });
  };

  return (
    <span
      data-rail-tile-icon-tone={tone ?? "pending"}
      className={cn(
        "block size-full",
        tone !== undefined && tone !== "artwork" && ICON_TONE_PLATE_CLASS,
      )}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        data-rail-tile-icon=""
        className={cn(
          "block size-full object-cover",
          tone === undefined ? "opacity-0" : ICON_TONE_IMAGE_CLASS[tone],
        )}
        ref={(image) => {
          if (
            image !== null &&
            tone === undefined &&
            image.complete &&
            image.naturalWidth > 0
          )
            measure(image);
        }}
        onLoad={(event) => {
          if (tone === undefined) measure(event.currentTarget);
        }}
        onError={onError}
      />
    </span>
  );
}

function FaceImage({
  src,
  variant,
  onError,
}: {
  src: string;
  variant: ProjectFaceVariant;
  onError: () => void;
}) {
  if (variant === "tile") return <TileIconImage src={src} onError={onError} />;

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      data-rail-tile-icon=""
      className="block size-full object-cover"
      onError={onError}
    />
  );
}

export type ProjectFaceVariant = keyof typeof FACE_VARIANTS;

export interface ProjectFaceProject extends ProjectIconProject {
  name: string;
}

export function useConnectedHostIds(): ReadonlySet<string> {
  const { data: hosts } = useHosts();

  return useMemo(
    () =>
      new Set(
        (hosts ?? [])
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [hosts],
  );
}

export function ProjectFace({
  project,
  connectedHostIds,
  variant,
}: {
  project: ProjectFaceProject;
  connectedHostIds: ReadonlySet<string>;
  variant: ProjectFaceVariant;
}) {
  const {
    url: iconUrl,
    image,
    refresh,
  } = useProjectIcon(project, connectedHostIds);

  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const source = selectProjectIconSource(project);
  const connected = source !== null && connectedHostIds.has(source.hostId);
  const classes = FACE_VARIANTS[variant];

  useEffect(() => {
    if (connected) {
      setRetryCount(0);
      setFailedUrl(null);
    }
  }, [connected]);

  useEffect(() => {
    if (failedUrl === null) return;

    let cancelled = false;

    const recover = async (attempt: number) => {
      await refresh();

      if (cancelled) return;
      setRetryCount(attempt);
      setFailedUrl(null);
    };

    const onFocus = () => {
      if (connected) void recover(0);
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);

    const timer =
      connected && retryCount < 2
        ? window.setTimeout(
            () => void recover(retryCount + 1),
            1000 * 2 ** retryCount,
          )
        : undefined;

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.clearTimeout(timer);
    };
  }, [connected, failedUrl, refresh, retryCount]);

  if (project.kind === "personal") {
    return (
      <span className={classes.face} style={monogramStyle(project.id)}>
        <Icon name="UserRound" aria-hidden="true" className={classes.glyph} />
      </span>
    );
  }

  if (image !== null && image !== failedImage) {
    return (
      <FaceImage
        src={image}
        variant={variant}
        onError={() => setFailedImage(image)}
      />
    );
  }

  if (iconUrl !== null && iconUrl !== failedUrl) {
    return (
      <FaceImage
        src={retryCount === 0 ? iconUrl : `${iconUrl}?iconRetry=${retryCount}`}
        variant={variant}
        onError={() => setFailedUrl(iconUrl)}
      />
    );
  }

  const monogram = projectMonogram(project.name);

  return (
    <span
      data-rail-tile-monogram=""
      className={cn(classes.face, classes.monogram(monogram))}
      style={monogramStyle(project.id)}
    >
      {monogram}
    </span>
  );
}

export function ProjectIcon({
  projectId,
  className,
  style,
}: ExperimentalProjectIconProps) {
  const { data } = useSidebarNavigation();
  const connectedHostIds = useConnectedHostIds();

  const project = useMemo(
    () =>
      data === undefined
        ? undefined
        : data.personalProject.id === projectId
          ? data.personalProject
          : data.projects.find((entry) => entry.id === projectId),
    [data, projectId],
  );

  if (project === undefined) return null;

  return (
    <span
      aria-hidden="true"
      data-project-icon={projectId}
      className={cn("inline-block shrink-0 overflow-hidden", className)}
      style={style}
    >
      <ProjectFace
        project={project}
        connectedHostIds={connectedHostIds}
        variant="inline"
      />
    </span>
  );
}
