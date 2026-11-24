import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { Project, ProjectSource } from "@omnyo/domain";
import { withLocalStorage } from "@/lib/browser-storage";
import { buildProjectFileContentUrl } from "@/lib/file-content-urls";
import { sdk } from "@/lib/sdk";

export const PROJECT_ICON_EXCLUDE_NAMES: readonly string[] = [
  "node_modules",
  ".pnpm-store",
  ".claude/worktrees",
  ".venv",
  "venv",
  ".turbo",
  ".next",
  ".cache",
  "__pycache__",
  ".DS_Store",
  "Pods",
  "DerivedData",
  "target",
  ".agent-worktrees",
  ".worktrees",
];

export const PROJECT_ICON_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_CONCURRENT_PROJECT_ICON_RESOLUTIONS = 3;

export const PROJECT_ICON_IMAGE_REFRESH_MS = 5 * 60 * 1000;

export const MAX_CACHED_PROJECT_ICON_BYTES = 24 * 1024;

const CACHED_PROJECT_ICON_EDGE_PX = 96;

const PROJECT_ICON_LIST_LIMIT = 100;

const PROJECT_ICON_CACHE_KEY_PREFIX = "omnyo.sidebar.project-icon:v2:";

const PROJECT_ICON_BASENAME =
  /^(?<stem>icon|favicon|app-icon|appicon)\.(?:png|svg|ico)$/iu;

const cachedProjectIconImageSchema = z
  .object({
    dataUrl: z.string().startsWith("data:image/"),
    at: z.number().nonnegative(),
  })
  .strict();

const cachedProjectIconSchema = z
  .object({
    path: z.string().min(1).nullable(),
    at: z.number().nonnegative(),
    hostId: z.string().min(1),
    root: z.string().min(1),
    image: cachedProjectIconImageSchema.optional(),
  })
  .strict();

type CachedProjectIcon = z.infer<typeof cachedProjectIconSchema>;

type CachedProjectIconImage = z.infer<typeof cachedProjectIconImageSchema>;

export interface ProjectIconProject {
  id: string;
  kind: Project["kind"];
  customIcon?: string | null;
  sources: readonly ProjectSource[];
}

export function selectProjectIconSource(
  project: ProjectIconProject,
): ProjectSource | null {
  if (project.kind === "personal" || project.customIcon) return null;

  return (
    project.sources.find((source) => source.isDefault) ??
    project.sources[0] ??
    null
  );
}

function iconCandidateRank(path: string): [number, number] | null {
  const segments = path.split("/");
  const match = PROJECT_ICON_BASENAME.exec(segments.at(-1) ?? "");
  const stem = match?.groups?.stem?.toLowerCase();

  if (stem === undefined) return null;

  return [stem === "favicon" ? 1 : 0, segments.length];
}

export function pickProjectIconPath(paths: readonly string[]): string | null {
  let best: { path: string; rank: [number, number] } | null = null;

  for (const path of paths) {
    const rank = iconCandidateRank(path);

    if (rank === null) continue;

    if (
      best === null ||
      rank[0] < best.rank[0] ||
      (rank[0] === best.rank[0] && rank[1] < best.rank[1]) ||
      (rank[0] === best.rank[0] &&
        rank[1] === best.rank[1] &&
        path.localeCompare(best.path) < 0)
    ) {
      best = { path, rank };
    }
  }

  return best?.path ?? null;
}

function projectIconCacheKey(projectId: string, sourceId: string): string {
  return `${PROJECT_ICON_CACHE_KEY_PREFIX}${projectId}:${sourceId}`;
}

function readCachedProjectIcon(
  projectId: string,
  source: ProjectSource,
): CachedProjectIcon | undefined {
  const stored = withLocalStorage(
    (storage) => storage.getItem(projectIconCacheKey(projectId, source.id)),
    null,
  );

  if (stored === null) return undefined;

  let value: unknown;

  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }

  const parsed = cachedProjectIconSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data.hostId !== source.hostId ||
    parsed.data.root !== source.path
  ) {
    return undefined;
  }

  return parsed.data;
}

function readCachedProjectIconImage(
  projectId: string,
  source: ProjectSource,
  path: string,
): CachedProjectIconImage | undefined {
  const cached = readCachedProjectIcon(projectId, source);

  return cached?.path === path ? cached.image : undefined;
}

function writeCachedProjectIcon(
  projectId: string,
  source: ProjectSource,
  value: CachedProjectIcon,
): void {
  withLocalStorage(
    (storage) =>
      storage.setItem(
        projectIconCacheKey(projectId, source.id),
        JSON.stringify(value),
      ),
    undefined,
  );
}

function writeCachedProjectIconPath(
  projectId: string,
  source: ProjectSource,
  path: string | null,
): void {
  const previous = readCachedProjectIcon(projectId, source);

  writeCachedProjectIcon(projectId, source, {
    path,
    at: Date.now(),
    hostId: source.hostId,
    root: source.path,
    ...(previous?.path === path && previous.image !== undefined
      ? { image: previous.image }
      : {}),
  });
}

function writeCachedProjectIconImage(
  projectId: string,
  source: ProjectSource,
  path: string,
  dataUrl: string | null,
): void {
  const cached = readCachedProjectIcon(projectId, source);

  if (cached?.path !== path) return;

  const { image: _previous, ...entry } = cached;

  writeCachedProjectIcon(
    projectId,
    source,
    dataUrl === null ? entry : { ...entry, image: { dataUrl, at: Date.now() } },
  );
}

async function readBlobAsDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function downscaleProjectIcon(blob: Blob): Promise<Blob | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }

  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }

  try {
    const scale = Math.min(
      1,
      CACHED_PROJECT_ICON_EDGE_PX / Math.max(bitmap.width, bitmap.height),
    );

    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );

    const context = canvas.getContext("2d");

    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

export async function encodeProjectIconImage(
  blob: Blob,
): Promise<string | null> {
  if (!blob.type.startsWith("image/")) return null;

  const image =
    blob.size <= MAX_CACHED_PROJECT_ICON_BYTES
      ? blob
      : await downscaleProjectIcon(blob);

  if (image === null || image.size > MAX_CACHED_PROJECT_ICON_BYTES) {
    return null;
  }

  return readBlobAsDataUrl(image);
}

let activeIconResolutions = 0;

const waitingIconResolutions: (() => void)[] = [];

async function withIconResolutionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeIconResolutions < MAX_CONCURRENT_PROJECT_ICON_RESOLUTIONS) {
    activeIconResolutions += 1;
  } else {
    await new Promise<void>((resolve) => {
      waitingIconResolutions.push(resolve);
    });
  }

  try {
    return await task();
  } finally {
    const next = waitingIconResolutions.shift();

    if (next === undefined) activeIconResolutions -= 1;
    else next();
  }
}

export function resolveProjectIconPath(
  projectId: string,
  source: ProjectSource,
  signal: AbortSignal,
): Promise<string | null> {
  return withIconResolutionSlot(async () => {
    const result = await sdk.files.list({
      hostId: source.hostId,
      path: source.path,
      discovery: "icons",
      includeHidden: false,
      limit: PROJECT_ICON_LIST_LIMIT,
      excludeNames: [...PROJECT_ICON_EXCLUDE_NAMES],
      signal,
    });

    const path = pickProjectIconPath(result.files.map((file) => file.path));

    if (path === null && result.truncated) {
      throw new Error("Project icon discovery reached its search limit");
    }

    writeCachedProjectIconPath(projectId, source, path);

    return path;
  });
}

export function useProjectIcon(
  project: ProjectIconProject,
  connectedHostIds: ReadonlySet<string>,
) {
  const source = selectProjectIconSource(project);

  const cached = useMemo(
    () =>
      source === null ? undefined : readCachedProjectIcon(project.id, source),
    [project.id, source],
  );

  const resolved = useQuery({
    queryKey: [
      "sidebar-project-icon-v2",
      project.id,
      source?.id ?? null,
      source?.hostId ?? null,
      source?.path ?? null,
    ],
    queryFn: async ({ signal }) => {
      if (source === null) return { path: null };

      return { path: await resolveProjectIconPath(project.id, source, signal) };
    },
    initialData: cached === undefined ? undefined : { path: cached.path },
    initialDataUpdatedAt: cached?.at,
    enabled: source !== null && connectedHostIds.has(source.hostId),
    retry: 2,
    staleTime: PROJECT_ICON_CACHE_TTL_MS,
  });

  const path = resolved.data?.path ?? null;

  const url = useMemo(
    () =>
      source === null || path === null
        ? null
        : buildProjectFileContentUrl(project.id, path, {
            environmentId: null,
            hostId: source.hostId,
          }),
    [path, project.id, source],
  );

  const cachedImage = useMemo(
    () =>
      source === null || path === null
        ? undefined
        : readCachedProjectIconImage(project.id, source, path),
    [path, project.id, source],
  );

  const image = useQuery({
    queryKey: [
      "sidebar-project-icon-image",
      project.id,
      source?.id ?? null,
      source?.hostId ?? null,
      source?.path ?? null,
      path,
    ],
    queryFn: async ({ signal }) => {
      if (source === null || path === null || url === null) return null;

      const response = await fetch(url, { signal });

      if (response.status === 404) {
        writeCachedProjectIconImage(project.id, source, path, null);
        void resolved.refetch();

        return null;
      }

      if (!response.ok) {
        throw new Error(
          `Project icon request failed with HTTP ${response.status}`,
        );
      }

      const dataUrl = await encodeProjectIconImage(await response.blob());
      writeCachedProjectIconImage(project.id, source, path, dataUrl);

      return dataUrl;
    },
    initialData: cachedImage?.dataUrl,
    initialDataUpdatedAt: cachedImage?.at,
    enabled:
      source !== null && url !== null && connectedHostIds.has(source.hostId),
    retry: 2,
    staleTime: PROJECT_ICON_IMAGE_REFRESH_MS,
  });

  return {
    url,
    image: project.customIcon ?? image.data ?? null,
    refresh: resolved.refetch,
  };
}

export function projectMonogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const [first, second] = words;

  if (first === undefined) return "?";

  if (second === undefined) return Array.from(first).slice(0, 2).join("");

  return `${Array.from(first)[0] ?? ""}${Array.from(second)[0] ?? ""}`;
}

export function projectMonogramHue(projectId: string): number {
  let hash = 0x811c9dc5;

  for (const char of projectId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash % 360;
}
