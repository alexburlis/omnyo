import type { Event } from "electron";
import { createLocalViewUrl } from "./local-view.js";

export interface DesktopWindowNavigationEvents {
  "did-start-navigation": [
    event: Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ];
  "did-navigate": [
    event: Event,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
  ];
  "did-fail-load": [
    event: Event,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ];
}

interface NavigationWebContents {
  on<K extends keyof DesktopWindowNavigationEvents>(
    event: K,
    listener: (...args: DesktopWindowNavigationEvents[K]) => void,
  ): void;
  removeListener<K extends keyof DesktopWindowNavigationEvents>(
    event: K,
    listener: (...args: DesktopWindowNavigationEvents[K]) => void,
  ): void;
}

interface NavigationWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  webContents: NavigationWebContents;
}

interface NavigationCycle {
  controller: AbortController;
  generation: number;
  url: string;
  expectedUrl: string | null;
  status: number;
}

type NavigationFailure =
  | { kind: "http"; status: number }
  | { kind: "network"; code: number | null; error: Error };

type NavigationResult = "loaded" | "superseded";

const TRANSIENT_NETWORK_ERRORS = new Set([
  -7, -21, -100, -101, -102, -103, -104, -105, -106, -109, -118, -130, -137,
]);

const RECONNECT_URL = createLocalViewUrl({
  viewModel: {
    kind: "loading",
    title: "Reconnecting to Omnyo",
    message: "The server is unavailable. Retrying automatically.",
  },
});

async function waitForRetry(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, 2_000);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) finish();
  });
}

function describeFailure(url: string, failure: NavigationFailure): string {
  const origin = new URL(url).origin;

  const status =
    failure.kind === "http"
      ? `HTTP ${failure.status}`
      : `network error ${failure.code ?? "unknown"}`;

  return `[desktop] ${origin} navigation failed (${status}); retrying`;
}

export function createDesktopWindowNavigation(args: {
  browserWindow: NavigationWindow;
  getServerTargetGeneration(): number;
  isQuitting(): boolean;
  logWarning(message: string): void;
}): {
  load(url: string): Promise<NavigationResult>;
  stop(): void;
} {
  const webContents = args.browserWindow.webContents;
  let current: NavigationCycle | null = null;

  function cancel(): void {
    current?.controller.abort();
    current = null;
  }

  function isCurrent(cycle: NavigationCycle): boolean {
    return (
      current === cycle &&
      !cycle.controller.signal.aborted &&
      cycle.generation === args.getServerTargetGeneration() &&
      !args.isQuitting() &&
      !args.browserWindow.isDestroyed()
    );
  }

  function createCycle(url: string): NavigationCycle {
    cancel();

    const cycle: NavigationCycle = {
      controller: new AbortController(),
      generation: args.getServerTargetGeneration(),
      url,
      expectedUrl: null,
      status: -1,
    };

    current = cycle;

    return cycle;
  }

  async function run(
    cycle: NavigationCycle,
    initialFailure: NavigationFailure | null,
  ): Promise<NavigationResult> {
    let failure = initialFailure;

    try {
      while (isCurrent(cycle)) {
        if (failure !== null) {
          if (
            failure.kind === "http"
              ? failure.status < 500 || failure.status >= 600
              : !TRANSIENT_NETWORK_ERRORS.has(failure.code ?? 0)
          ) {
            if (failure.kind === "network" && failure.code === -3)
              return "superseded";
            throw failure.kind === "http"
              ? new Error(
                  `HTTP ${failure.status} loading the saved Omnyo server`,
                )
              : failure.error;
          }

          args.logWarning(describeFailure(cycle.url, failure));
          cycle.expectedUrl = RECONNECT_URL;
          await args.browserWindow.loadURL(RECONNECT_URL);

          if (!isCurrent(cycle)) return "superseded";

          await waitForRetry(cycle.controller.signal);

          if (!isCurrent(cycle)) return "superseded";
        }

        cycle.expectedUrl = cycle.url;
        cycle.status = -1;

        try {
          await args.browserWindow.loadURL(cycle.url);

          if (!isCurrent(cycle)) return "superseded";

          if (cycle.status < 400) return "loaded";
          failure = { kind: "http", status: cycle.status };
        } catch (error) {
          if (!isCurrent(cycle)) return "superseded";

          const code =
            error !== null &&
            typeof error === "object" &&
            "errno" in error &&
            typeof error.errno === "number"
              ? error.errno
              : null;

          failure = {
            kind: "network",
            code,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }

      return "superseded";
    } catch (error) {
      if (initialFailure !== null && isCurrent(cycle)) {
        cycle.expectedUrl = createLocalViewUrl({
          viewModel: {
            kind: "error",
            actions: [],
            title: "Could not open this Omnyo server",
            details: "Choose a server from the Server menu to reconnect.",
            logText: "",
          },
        });
        await args.browserWindow.loadURL(cycle.expectedUrl);
      }

      throw error;
    } finally {
      if (current === cycle) cancel();
    }
  }

  function recover(cycle: NavigationCycle, failure: NavigationFailure): void {
    void run(cycle, failure).catch(() => {
      args.logWarning(
        `[desktop] ${new URL(cycle.url).origin} navigation recovery failed`,
      );
    });
  }

  const onStart = (
    _event: Event,
    url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ): void => {
    if (!mainFrame || inPlace) return;

    if (
      current !== null &&
      current.expectedUrl !== null &&
      new URL(current.expectedUrl).href === new URL(url).href
    )
      return;
    createCycle(url);
  };

  const onNavigate = (_event: Event, _url: string, status: number): void => {
    const cycle = current;

    if (cycle === null) return;

    if (cycle.expectedUrl !== null) {
      cycle.status = status;
    } else if (status >= 500 && status < 600) {
      recover(cycle, { kind: "http", status });
    } else {
      cancel();
    }
  };

  const onFailure = (
    _event: Event,
    code: number,
    _description: string,
    _url: string,
    mainFrame: boolean,
  ): void => {
    const cycle = current;

    if (!mainFrame || cycle === null) return;

    if (cycle.expectedUrl !== null) return;

    if (TRANSIENT_NETWORK_ERRORS.has(code)) {
      recover(cycle, {
        kind: "network",
        code,
        error: new Error(`Network error ${code}`),
      });
    } else {
      cancel();
    }
  };

  webContents.on("did-start-navigation", onStart);
  webContents.on("did-navigate", onNavigate);
  webContents.on("did-fail-load", onFailure);

  return {
    load: (url) => run(createCycle(url), null),
    stop() {
      cancel();
      webContents.removeListener("did-start-navigation", onStart);
      webContents.removeListener("did-navigate", onNavigate);
      webContents.removeListener("did-fail-load", onFailure);
    },
  };
}
