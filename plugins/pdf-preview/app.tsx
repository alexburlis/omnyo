import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  type PluginFileOpenerProps,
} from "@omnyo/plugin-sdk/app";
import { loadPdfBlob, resolvePdfUrl } from "./pdf-source.js";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; frameLoaded: boolean; url: string }
  | { status: "error"; message: string };

function PdfFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  const url = useMemo(
    () => resolvePdfUrl(path, source),
    // oxlint-disable-next-line react/exhaustive-deps
    [
      path,
      source.environmentId,
      source.kind,
      source.projectId,
      source.threadId,
    ],
  );

  useEffect(() => {
    if (url === null) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    void loadPdfBlob(url, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", frameLoaded: false, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      controller.abort();

      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [reloadNonce, url]);

  if (url === null) return <Original />;

  if (state.status === "error") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div
          className="flex max-w-sm flex-col items-center gap-3 text-center"
          role="alert"
        >
          <span className="grid size-11 place-items-center rounded-full bg-surface-destructive text-destructive-text ring-1 ring-surface-destructive-border">
            <Icon name="FileText" className="size-5" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-foreground">
              Couldn’t open this PDF
            </p>
            <p className="text-sm leading-relaxed break-words text-muted-foreground">
              {state.message}
            </p>
          </div>
          <button
            type="button"
            className="mt-1 inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-control-primary px-3 text-xs font-medium text-control-primary-foreground shadow-control-primary hover:bg-control-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={() => setReloadNonce((current) => current + 1)}
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden />
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
        aria-label={`Loading ${path}`}
      >
        <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
        Loading PDF…
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      {state.frameLoaded ? null : (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
          role="status"
          aria-label={`Rendering ${path}`}
        >
          <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
          Rendering PDF…
        </div>
      )}
      <iframe
        src={state.url}
        title={path}
        className="block h-full w-full border-0"
        onLoad={() => {
          setState((current) =>
            current.status === "ready"
              ? { ...current, frameLoaded: true }
              : current,
          );
        }}
        onError={() => {
          setState({
            status: "error",
            message: "The browser could not open the PDF viewer.",
          });
        }}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "pdf",
    title: "PDF viewer",
    extensions: ["pdf"],
    component: PdfFileOpener,
  });
});
