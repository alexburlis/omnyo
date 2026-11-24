import type {
  OmnyoDesktopInfo,
  OmnyoDesktopInfoChangeHandler,
  OmnyoDesktopInfoUnsubscribe,
} from "@omnyo/desktop-contract";

const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;

export const DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS = 60 * 1000;

export interface DesktopUpdateService {
  checkAfterActive(): Promise<OmnyoDesktopInfo | null>;
  checkForUpdates(): Promise<OmnyoDesktopInfo>;
  getInfo(): OmnyoDesktopInfo;
  start(): void;
  stop(): void;
  subscribe(
    listener: OmnyoDesktopInfoChangeHandler,
  ): OmnyoDesktopInfoUnsubscribe;
}

interface DesktopUpdateScheduler extends DesktopUpdateService {
  updateInfo(nextInfo: OmnyoDesktopInfo): void;
}

interface CreateDesktopUpdateSchedulerArgs {
  enabled: boolean;
  initialInfo: OmnyoDesktopInfo;
  now: () => number;
  runCheck(checkedAt: string): Promise<void>;
  shouldSkipCheck?: () => boolean;
}

function areDesktopInfoValuesEqual(
  left: OmnyoDesktopInfo,
  right: OmnyoDesktopInfo,
): boolean {
  return (
    left.lastCheckedAt === right.lastCheckedAt &&
    left.downloadState === right.downloadState &&
    left.latestVersion === right.latestVersion &&
    left.pendingVersion === right.pendingVersion &&
    left.platform === right.platform &&
    left.updateAvailable === right.updateAvailable &&
    left.updateDownloaded === right.updateDownloaded &&
    left.version === right.version
  );
}

export function createDesktopUpdateScheduler(
  args: CreateDesktopUpdateSchedulerArgs,
): DesktopUpdateScheduler {
  let currentInfo = args.initialInfo;
  let inflight: Promise<OmnyoDesktopInfo> | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let lastAttemptedAt: number | null = null;
  const listeners = new Set<OmnyoDesktopInfoChangeHandler>();

  function updateInfo(nextInfo: OmnyoDesktopInfo): void {
    if (areDesktopInfoValuesEqual(currentInfo, nextInfo)) {
      return;
    }

    currentInfo = nextInfo;

    for (const listener of listeners) {
      listener(currentInfo);
    }
  }

  async function checkForUpdates(): Promise<OmnyoDesktopInfo> {
    if (!args.enabled) {
      return currentInfo;
    }

    if (args.shouldSkipCheck?.()) {
      return currentInfo;
    }

    if (inflight !== null) {
      return inflight;
    }

    const requestPromise = (async () => {
      lastAttemptedAt = args.now();
      await args.runCheck(new Date(lastAttemptedAt).toISOString());

      return currentInfo;
    })();

    inflight = requestPromise;

    try {
      return await requestPromise;
    } finally {
      if (inflight === requestPromise) {
        inflight = null;
      }
    }
  }

  return {
    async checkAfterActive(): Promise<OmnyoDesktopInfo | null> {
      if (!args.enabled) {
        return null;
      }

      const currentTime = args.now();

      if (
        lastAttemptedAt !== null &&
        currentTime - lastAttemptedAt < DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS
      ) {
        return currentInfo;
      }

      return checkForUpdates();
    },
    checkForUpdates,
    getInfo(): OmnyoDesktopInfo {
      return currentInfo;
    },
    start(): void {
      if (!args.enabled || intervalHandle !== null) {
        return;
      }

      void checkForUpdates();
      intervalHandle = setInterval(() => {
        void checkForUpdates();
      }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    },
    stop(): void {
      if (intervalHandle === null) {
        return;
      }

      clearInterval(intervalHandle);
      intervalHandle = null;
    },
    subscribe(
      listener: OmnyoDesktopInfoChangeHandler,
    ): OmnyoDesktopInfoUnsubscribe {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    updateInfo,
  };
}
