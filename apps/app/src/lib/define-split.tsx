import {
  downloadSplit,
  isSplitModuleFetchFailure,
  recordSplitDownloadFailure,
  recordSplitImportFailure,
  splitImportAssetName,
  trackCriticalLoad,
  type SplitDownloadFailure,
} from "./split-load";
import { Button } from "@omnyo/shared-ui/button";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import {
  Component,
  lazy,
  Suspense,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

type FailureProps = { retry: () => void; error?: Error };

export function SplitLoadFailure({ retry, error }: FailureProps) {
  const needsReload = isSplitModuleFetchFailure(error);

  return (
    <div role="alert">
      <EmptyStateBlock
        className="px-4 py-6"
        icon="AlertCircle"
        tone="error"
        title="This part of Omnyo didn’t load"
        description={
          needsReload
            ? "Omnyo may have been updated since this window opened."
            : undefined
        }
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={needsReload ? () => window.location.reload() : retry}
          >
            {needsReload ? "Reload Omnyo" : "Try again"}
          </Button>
        }
      />
    </div>
  );
}

interface SplitErrorBoundaryState {
  error: Error | null;
}

class SplitErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: Error) => ReactNode },
  SplitErrorBoundaryState
> {
  override state: SplitErrorBoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }

  override render() {
    return this.state.error
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

const DOWNLOAD_RETRY_DELAYS = [500, 1500];

class SplitDownloadError extends Error {
  constructor(id: string, failure: SplitDownloadFailure, attempts: number) {
    const reason =
      failure.kind === "http"
        ? `HTTP ${failure.status}`
        : failure.kind === "timeout"
          ? "timeout"
          : "network failure";

    super(
      `Could not download the ${id} feature (${reason} after ${attempts} attempts)`,
    );
    this.name = "SplitDownloadError";
    recordSplitDownloadFailure(this, failure, attempts);
  }
}

async function downloadBeforeImport(
  id: string,
  priority: RequestPriority,
): Promise<{
  assetName: string | undefined;
  preflight: "downloaded" | "unlisted";
}> {
  const assetName = splitImportAssetName(id);
  let traceRequestFailure = false;

  for (let attempt = 0; ; attempt += 1) {
    const result = await downloadSplit(id, priority, traceRequestFailure);

    if (typeof result === "string") return { assetName, preflight: result };
    const delay = DOWNLOAD_RETRY_DELAYS[attempt];

    if (delay === undefined)
      throw new SplitDownloadError(id, result, attempt + 1);
    traceRequestFailure =
      attempt === DOWNLOAD_RETRY_DELAYS.length - 1 &&
      result.kind !== "http" &&
      result.downloadPhase === "request";
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

export function defineSplit<P extends object>({
  id,
  load,
  loading: Loading,
  error: ErrorView = SplitLoadFailure,
  mountWhen,
  keepMounted = false,
  unmounted: Unmounted,
}: {
  id: string;
  load: () => Promise<ComponentType<P>>;
  loading: ComponentType<P>;
  error?: ComponentType<P & FailureProps>;
  mountWhen?: (props: P) => boolean;
  keepMounted?: boolean;
  unmounted?: ComponentType<P>;
}) {
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  let loaded: ComponentType<P> | null = null;
  let importAttempts = 0;
  const listeners = new Set<() => void>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const getLoaded = () => loaded;

  const loadModule = (priority: RequestPriority) => {
    pending ??= downloadBeforeImport(id, priority)
      .then(async ({ assetName, preflight }) => {
        importAttempts += 1;

        try {
          return await load();
        } catch (cause) {
          recordSplitImportFailure(cause, assetName, importAttempts, preflight);
          throw cause;
        }
      })
      .then((component) => {
        loaded = component;

        for (const listener of listeners) listener();

        return { default: component };
      })
      .catch((cause: unknown) => {
        pending = null;
        throw cause;
      });

    return pending;
  };

  const renderModule = () => trackCriticalLoad(loadModule("high"));

  const preload = () =>
    loadModule("auto").then(
      () => undefined,
      () => undefined,
    );

  const onIntent = () => {
    void preload();
  };

  function SplitContent(props: P) {
    const [attempt, setAttempt] = useState(() => ({
      number: 0,
      View: loaded ?? lazy(renderModule),
    }));

    const retry = () => {
      setAttempt((previous) => ({
        number: previous.number + 1,
        View: loaded ?? lazy(renderModule),
      }));
    };

    const resolved = useSyncExternalStore(subscribe, getLoaded, getLoaded);
    const View = resolved ?? attempt.View;

    return (
      <SplitErrorBoundary
        key={attempt.number}
        fallback={(error) => (
          <ErrorView {...props} retry={retry} error={error} />
        )}
      >
        <Suspense fallback={<Loading {...props} />}>
          <View {...props} />
        </Suspense>
      </SplitErrorBoundary>
    );
  }

  function SplitComponent(props: P) {
    const wanted = mountWhen?.(props) ?? true;
    const [mountedBefore, setMountedBefore] = useState(wanted);

    if (wanted && !mountedBefore) setMountedBefore(true);

    if (wanted || (keepMounted && mountedBefore)) {
      return <SplitContent {...props} />;
    }

    return Unmounted ? <Unmounted {...props} /> : null;
  }

  return Object.assign(SplitComponent, {
    displayName: `Split(${id})`,
    id,
    preload,
    isLoaded: () => loaded !== null,
    intentProps: {
      onPointerEnter: onIntent,
      onFocus: onIntent,
      onPointerDown: onIntent,
    },
  });
}
