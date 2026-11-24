import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SystemAppUpdateStatus } from "@omnyo/server-contract";
import type { ProviderCliInstallAction } from "@omnyo/host-daemon-contract";
import { SettingsStoryFixtures } from "../../../.ladle/settings-story-fixtures";
import {
  HOST_IDS,
  makeHost,
  makeProviderCliStatus,
} from "../../../.ladle/story-fixtures";
import type { ProviderCliActionableIssue } from "@/components/provider-cli/provider-cli-install";
import { startProviderCliInstall } from "@/components/provider-cli/provider-cli-install-store";
import {
  SidebarInset,
  SidebarMenu,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useLocation } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { SettingsStoryChrome } from "../../../.ladle/story-settings-chrome";
import { AppLayoutSidebar } from "@/components/layout/AppLayoutSidebar";
import { systemAppUpdateQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";
import { AppUpdateHost } from "@/components/app-update/AppUpdateHost";

export default { title: "sidebar/Updates badge" };

const action: ProviderCliInstallAction = {
  kind: "update",
  label: "Update",
  command: "codex update",
};

const status = makeProviderCliStatus("codex", {
  currentVersion: "0.150.0",
  latestVersion: "0.151.0",
  needsUpdate: true,
  installAction: action,
});

const issue: ProviderCliActionableIssue = {
  provider: "codex",
  status,
  action,
  title: "Codex update available",
  description: "0.150.0 -> 0.151.0",
  fingerprint: "codex:story",
};

function BadgeStage({ children }: { children?: ReactNode }) {
  return (
    <SettingsStoryFixtures>
      <div className="flex min-h-32 w-80 flex-col rounded-md border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
        {children}
        <SidebarMenu className="mt-auto">
          <SidebarUpdatesBadge />
        </SidebarMenu>
      </div>
    </SettingsStoryFixtures>
  );
}

function ActiveProviderUpdate() {
  useEffect(() => {
    const originalInstallProviderCli = sdk.hosts.installProviderCli;
    let finishInstall: (() => void) | null = null;

    const startTimer = window.setTimeout(() => {
      sdk.hosts.installProviderCli = () =>
        new Promise((resolve) => {
          finishInstall = () => {
            resolve([
              {
                type: "completed",
                provider: "codex",
                exitCode: 0,
                signal: null,
                success: true,
              },
            ]);
          };
        });
      startProviderCliInstall({ hostId: HOST_IDS.local, issue });
    }, 0);

    return () => {
      window.clearTimeout(startTimer);
      sdk.hosts.installProviderCli = originalInstallProviderCli;
      finishInstall?.();
    };
  }, []);

  return <BadgeStage />;
}

const privateUpdate: SystemAppUpdateStatus = {
  activity: { phase: "idle" },
  available: {
    channel: "private",
    commit: "b".repeat(40),
    commitCount: null,
    subjects: [],
    version: "0.46.170+private.1",
  },
  blocked: null,
  current: { commit: null, version: "0.46.169+private.1" },
  installsWhenIdle: false,
  lastResult: null,
  newTurnsPausedForUpdate: false,
  runningThreadCount: 3,
  support: { kind: "supported", mode: "private" },
};

function SeedOmnyoUpdate({
  initialStatus = privateUpdate,
}: {
  initialStatus?: SystemAppUpdateStatus;
}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const originalApply = sdk.system.applyAppUpdate;
    const originalStatus = sdk.system.appUpdate;
    let current = initialStatus;
    sdk.system.appUpdate = async () => current;
    sdk.system.applyAppUpdate = async () => {
      current = {
        ...privateUpdate,
        activity: {
          output: [],
          phase: "preparing",
          startedAt: new Date().toISOString(),
          step: "Pausing chats",
          targetVersion: "0.46.170+private.1",
        },
      };

      return current;
    };

    queryClient.setQueryData(systemAppUpdateQueryKey(), initialStatus);

    return () => {
      sdk.system.applyAppUpdate = originalApply;
      sdk.system.appUpdate = originalStatus;
    };
  }, [initialStatus, queryClient]);

  return null;
}

export function OmnyoUpdateNow() {
  return (
    <BadgeStage>
      <SeedOmnyoUpdate />
    </BadgeStage>
  );
}

const waitingUpdate: SystemAppUpdateStatus = {
  ...privateUpdate,
  activity: {
    code: "runtime_update_busy",
    output: ["The worker is finishing interrupted chat work."],
    phase: "preparing",
    startedAt: "2026-11-01T06:20:00.000Z",
    step: "Waiting for worker",
    targetVersion: "0.46.170+private.1",
  },
  newTurnsPausedForUpdate: true,
  runningThreadCount: 0,
};

export function OmnyoUpdateWaitingForWorker() {
  return (
    <BadgeStage>
      <SeedOmnyoUpdate initialStatus={waitingUpdate} />
    </BadgeStage>
  );
}

const failedUpdate: SystemAppUpdateStatus = {
  ...privateUpdate,
  lastResult: {
    acknowledged: true,
    errorCode: "runtime_update_busy",
    finishedAt: "2026-11-01T06:24:56.542Z",
    from: privateUpdate.current,
    id: "update-worker-busy",
    logTail: [],
    message: "The worker did not finish stopping. Chats resumed automatically.",
    outcome: "failed",
    phase: "prepare",
    to: { commit: null, version: "0.46.170+private.1" },
  },
};

export function OmnyoUpdateFailed() {
  return (
    <BadgeStage>
      <SeedOmnyoUpdate initialStatus={failedUpdate} />
      <AppUpdateHost />
    </BadgeStage>
  );
}

export function ProviderUpdateAvailable() {
  return <BadgeStage />;
}

export function ProviderUpdateDownloading() {
  return <ActiveProviderUpdate />;
}

export function MachineNotices() {
  const [offlineCount, setOfflineCount] = useState(2);
  const [lastSeenAt, setLastSeenAt] = useState(Date.now);
  const { pathname } = useLocation();

  const hosts = useMemo(
    () =>
      ["Work laptop", "Studio desktop"].map((name, index) =>
        makeHost({
          id: index === 0 ? HOST_IDS.local : HOST_IDS.remote,
          name,
          status: offlineCount > index ? "disconnected" : "connected",
          lastSeenAt,
          lastRejectedProtocolVersion:
            index === 0 && offlineCount > 0 ? 1 : null,
        }),
      ),
    [offlineCount, lastSeenAt],
  );

  return (
    <SettingsStoryFixtures hosts={hosts}>
      {pathname === "/settings/machines" ? (
        <SettingsStoryChrome activeSection="machines">
          <MachinesSettingsSection />
        </SettingsStoryChrome>
      ) : (
        <SidebarProvider className="h-screen bg-background">
          <AppLayoutSidebar
            mode="app"
            isResizing={false}
            onResizeMouseDown={() => {}}
            settingsToggleRoutePath="/settings/machines"
          />
          <SidebarInset>
            <main className="space-y-6 p-6">
              <SidebarTrigger />
              <h1 className="text-lg font-semibold">Machine notices</h1>
              <p className="max-w-lg text-sm text-muted-foreground">
                Hover the footer warning, then open it to see the machines.
                Return to the app: the same outage stays acknowledged.
              </p>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2].map((count) => (
                  <Button
                    key={count}
                    variant={offlineCount === count ? "default" : "outline"}
                    onClick={() => setOfflineCount(count)}
                  >
                    {count === 0
                      ? "All online"
                      : count === 1
                        ? "One offline"
                        : "Two offline"}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  onClick={() => setLastSeenAt(Date.now())}
                >
                  New outage
                </Button>
              </div>
            </main>
          </SidebarInset>
        </SidebarProvider>
      )}
    </SettingsStoryFixtures>
  );
}
