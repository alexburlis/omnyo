import { z } from "zod";
import {
  isSplitDiagnosticAssetPath,
  readDiagnosticAssetName,
  SPLIT_ASSET_ATTEMPT_HEADER,
  type SplitLoadDiagnosticContext,
} from "@omnyo/process-utils/error-reporting-privacy";

const splitManifestSchema = z.object({
  files: z.array(z.string()),
  splits: z.record(z.string(), z.array(z.number().int().nonnegative())),
});

let parsedManifest: {
  source: string;
  urls: ReadonlyMap<string, readonly string[]>;
} | null = null;

function splitAssetUrls(id: string): readonly string[] | null {
  const source = document.getElementById(
    "omnyo-prefetch-manifest",
  )?.textContent;

  if (!source) return null;

  if (parsedManifest?.source !== source) {
    const manifest = splitManifestSchema.parse(JSON.parse(source));

    const urls = new Map(
      Object.entries(manifest.splits).map(([split, indexes]) => [
        split,
        indexes.map((index) => {
          const file = manifest.files[index];

          if (file === undefined)
            throw new Error(`Split ${split} lists a missing file ${index}`);

          return new URL(file, document.baseURI).href;
        }),
      ]),
    );

    parsedManifest = { source, urls };
  }

  return parsedManifest.urls.get(id) ?? null;
}

const downloaded = new Set<string>();

export type SplitDownloadFailure = (
  | { kind: "http"; status: number }
  | { kind: "timeout" | "network"; assetAttemptId?: string }
) & {
  assetName?: string;
  downloadPhase?: "request" | "body";
  online?: boolean;
};

const failureDiagnostics = new WeakMap<Error, SplitLoadDiagnosticContext>();

let splitDownloadDiagnosticsEnabled = false;

export function setSplitDownloadDiagnosticsEnabled(enabled: boolean): void {
  splitDownloadDiagnosticsEnabled = enabled;
}

function manifestAssetName(url: string): string | undefined {
  return readDiagnosticAssetName(
    new URL(url, document.baseURI).pathname.split("/").at(-1),
  );
}

export function recordSplitDownloadFailure(
  error: Error,
  failure: SplitDownloadFailure,
  attempt: number,
): void {
  const base = {
    operation: "split-load" as const,
    stage: "download" as const,
    outcome: "terminal" as const,
    attempt,
    ...(failure.downloadPhase === undefined
      ? {}
      : { downloadPhase: failure.downloadPhase }),
    ...(failure.online === undefined ? {} : { online: failure.online }),
    ...(failure.assetName === undefined
      ? {}
      : { assetName: failure.assetName }),
  };

  const diagnostic: SplitLoadDiagnosticContext =
    failure.kind === "http"
      ? {
          ...base,
          kind: failure.kind,
          status: failure.status,
          failureClass: "upstream-rejected",
        }
      : {
          ...base,
          ...(failure.assetAttemptId === undefined
            ? {}
            : { assetAttemptId: failure.assetAttemptId }),
          ...(failure.kind === "timeout"
            ? { kind: failure.kind, failureClass: "timeout" }
            : { kind: failure.kind, failureClass: "connection" }),
        };

  failureDiagnostics.set(error, Object.freeze(diagnostic));
}

export function splitImportAssetName(id: string): string | undefined {
  const assets = (splitAssetUrls(id) ?? []).filter((url) =>
    new URL(url).pathname.endsWith(".js"),
  );

  return assets.length === 1 && assets[0] !== undefined
    ? manifestAssetName(assets[0])
    : undefined;
}

export function isSplitModuleFetchFailure(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/i.test(
      cause.message,
    )
  );
}

export function recordSplitImportFailure(
  error: unknown,
  assetName: string | undefined,
  attempt: number,
  preflight?: "downloaded" | "unlisted",
): void {
  if (!(error instanceof Error)) return;

  const importFailure = isSplitModuleFetchFailure(error)
    ? "fetch"
    : /^Unable to preload CSS for /i.test(error.message)
      ? "css-preload"
      : error instanceof SyntaxError
        ? "syntax"
        : "exception";

  failureDiagnostics.set(
    error,
    Object.freeze({
      operation: "split-load",
      stage: "import",
      kind: "module",
      failureClass: "unknown",
      outcome: "terminal",
      attempt,
      importFailure,
      online: navigator.onLine,
      ...(preflight === undefined ? {} : { preflight }),
      ...(assetName === undefined ? {} : { assetName }),
    }),
  );
}

export function readSplitFailureDiagnostic(
  error: unknown,
): SplitLoadDiagnosticContext | undefined {
  return error instanceof Error ? failureDiagnostics.get(error) : undefined;
}

type AssetDownload = "downloaded" | SplitDownloadFailure;

const downloading = new Map<string, Promise<AssetDownload>>();

function splitAssetAttemptId(url: string): string | undefined {
  const assetUrl = new URL(url);

  return assetUrl.origin === window.location.origin &&
    !assetUrl.search &&
    isSplitDiagnosticAssetPath(assetUrl.pathname)
    ? crypto.randomUUID?.()
    : undefined;
}

function downloadAsset(
  url: string,
  priority: RequestPriority,
  traceRequestFailure: boolean,
) {
  if (downloaded.has(url)) return Promise.resolve<AssetDownload>("downloaded");
  let pending = downloading.get(url);

  if (pending === undefined) {
    const assetAttemptId =
      splitDownloadDiagnosticsEnabled && traceRequestFailure
        ? splitAssetAttemptId(url)
        : undefined;

    let downloadPhase: "request" | "body" = "request";
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    pending = fetch(url, {
      cache: "force-cache",
      priority,
      signal: controller.signal,
      ...(assetAttemptId === undefined
        ? {}
        : { headers: { [SPLIT_ASSET_ATTEMPT_HEADER]: assetAttemptId } }),
    })
      .then(async (response): Promise<AssetDownload> => {
        if (!response.ok)
          return {
            kind: "http",
            status: response.status,
            downloadPhase,
            online: navigator.onLine,
          };
        downloadPhase = "body";
        await response.arrayBuffer();
        downloaded.add(url);

        return "downloaded";
      })
      .catch((): SplitDownloadFailure => ({
        kind: controller.signal.aborted ? "timeout" : "network",
        downloadPhase,
        online: navigator.onLine,
        ...(downloadPhase === "request" && assetAttemptId !== undefined
          ? { assetAttemptId }
          : {}),
      }))
      .finally(() => {
        clearTimeout(deadline);
        downloading.delete(url);
      });
    downloading.set(url, pending);
  }

  return pending;
}

export type SplitDownload = "unlisted" | "downloaded" | SplitDownloadFailure;

export async function downloadSplit(
  id: string,
  priority: RequestPriority = "low",
  traceRequestFailure = false,
): Promise<SplitDownload> {
  const urls = splitAssetUrls(id);

  if (urls === null) return "unlisted";

  const results = await Promise.all(
    urls.map(async (url) => {
      const result = await downloadAsset(url, priority, traceRequestFailure);

      if (typeof result === "string") return result;
      const assetName = manifestAssetName(url);

      return { ...result, ...(assetName === undefined ? {} : { assetName }) };
    }),
  );

  return results.find((result) => result !== "downloaded") ?? "downloaded";
}

let pendingCriticalLoads = 0;

const settledWaiters: Array<() => void> = [];

function resolveSettledWaitersAfterRender() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (pendingCriticalLoads > 0) return;

      for (const resolve of settledWaiters.splice(0)) resolve();
    });
  });
}

export function trackCriticalLoad<T>(load: Promise<T>): Promise<T> {
  pendingCriticalLoads += 1;

  const settle = () => {
    pendingCriticalLoads -= 1;

    if (pendingCriticalLoads > 0) return;
    resolveSettledWaitersAfterRender();
  };

  load.then(settle, settle);

  return load;
}

export function whenCriticalLoadsSettled(): Promise<void> {
  const settled = new Promise<void>((resolve) => settledWaiters.push(resolve));

  if (pendingCriticalLoads === 0) resolveSettledWaitersAfterRender();

  return settled;
}
