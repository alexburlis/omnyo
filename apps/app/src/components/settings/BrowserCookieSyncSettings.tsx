import { useEffect, useState } from "react";
import type { OmnyoDesktopBrowserApi } from "@omnyo/desktop-contract";
import {
  DESKTOP_BROWSER_IMPORT_FAILURE_COPY,
  type DesktopBrowserCookieSyncSource,
  type DesktopBrowserCookieSyncStatus,
  type DesktopBrowserImportSource,
} from "@omnyo/host-daemon-contract";
import { Button } from "@omnyo/shared-ui/button";
import { Switch } from "@omnyo/shared-ui/switch";
import {
  SettingsRow,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  formatCookieCount,
  recommendedCandidate,
  sourceKey,
  syncCandidates,
} from "./browser-import-wizard";
import { ChoiceDropdownSetting } from "./ChoiceDropdownSetting";

const STATUS_REFRESH_INTERVAL_MS = 30_000;

function sourceLabel(
  selected: DesktopBrowserCookieSyncSource,
  sources: readonly DesktopBrowserImportSource[],
): string {
  const source = sources.find((entry) => entry.id === selected.sourceId);

  const profile = source?.profiles.find(
    (entry) => entry.directory === selected.sourceProfileDirectory,
  );

  return `${source?.name ?? selected.sourceId} · ${profile?.name ?? selected.sourceProfileDirectory}`;
}

function lastRunText(status: DesktopBrowserCookieSyncStatus, now: number) {
  const run = status.lastRun;

  if (status.running) return "Syncing…";

  if (run === null) return "Not synced yet";
  const when = formatRelativeTime({ timestamp: run.at, now });

  if (!run.ok)
    return `Failed ${when}: ${DESKTOP_BROWSER_IMPORT_FAILURE_COPY[run.reason]}`;

  return `Synced ${when} · ${formatCookieCount(run.imported)}${
    run.removed > 0 ? `, ${run.removed} removed` : ""
  }`;
}

export function BrowserCookieSyncSettings({
  desktopBrowser,
  sourceList,
}: {
  desktopBrowser: OmnyoDesktopBrowserApi;
  sourceList: {
    sources: readonly DesktopBrowserImportSource[];
    recommended: DesktopBrowserCookieSyncSource | null;
  } | null;
}) {
  const [status, setStatus] = useState<DesktopBrowserCookieSyncStatus | null>(
    null,
  );

  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const readStatus = desktopBrowser.cookieSyncStatus;

    if (!readStatus) return;
    let active = true;

    const refresh = () => {
      readStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {
          if (active) setError("Could not read the sync status.");
        });
    };

    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [desktopBrowser]);

  const apply = (request: Promise<DesktopBrowserCookieSyncStatus>) => {
    setPending(true);
    setError(null);
    request
      .then((next) => {
        setStatus(next);
        setPicking(false);
      })
      .catch(() => setError("Could not update login sync."))
      .finally(() => setPending(false));
  };

  const configure = (source: DesktopBrowserCookieSyncSource | null) => {
    if (desktopBrowser.configureCookieSync)
      apply(desktopBrowser.configureCookieSync(source));
  };

  if (sourceList === null) return null;

  if (!desktopBrowser.cookieSyncStatus || status === null)
    return error ? (
      <p className="text-sm text-destructive-text">{error}</p>
    ) : null;

  const { sources, recommended } = sourceList;
  const enabled = status.source !== null;
  const candidates = syncCandidates(sources);
  const defaultBrowser = recommendedCandidate(candidates, recommended);

  return (
    <div className="space-y-3" data-testid="browser-cookie-sync">
      <SettingsWithControl
        label="Keep logins synced"
        description="Refreshes Omnyo's logins from one browser profile every 15 minutes. Cookies stay on this device."
      >
        <Switch
          aria-label="Keep logins synced"
          checked={enabled || picking}
          disabled={pending}
          onCheckedChange={(checked) => {
            if (checked) setPicking(true);
            else if (enabled) configure(null);
            else setPicking(false);
          }}
        />
      </SettingsWithControl>
      {!enabled && !picking && defaultBrowser !== null ? (
        <SettingsRow>
          <p className="min-w-0 flex-1 text-xs text-subtle-foreground">
            {defaultBrowser.browserName} · {defaultBrowser.profileName} is your
            default browser. If macOS asks, choose Always Allow.
          </p>
          <Button
            size="sm"
            disabled={pending || !desktopBrowser.configureCookieSync}
            onClick={() => configure(defaultBrowser.source)}
          >
            Connect {defaultBrowser.browserName}
          </Button>
        </SettingsRow>
      ) : null}
      {enabled || picking ? (
        candidates.length === 0 && status.source === null ? (
          <p className="text-sm text-subtle-foreground">
            No browser profile is ready to sync.
          </p>
        ) : (
          <ChoiceDropdownSetting
            label="Sync from"
            description="Omnyo's browser mirrors this profile's logins."
            triggerAriaLabel="Sync from"
            disabled={pending}
            options={candidates.map((candidate) => ({
              key: candidate.key,
              title: candidate.browserName,
              description: candidate.profileName,
            }))}
            selected={
              status.source === null
                ? { key: "", title: "Choose a profile" }
                : {
                    key: sourceKey(status.source),
                    title: sourceLabel(status.source, sources),
                  }
            }
            onSelect={(key) => {
              const candidate = candidates.find((entry) => entry.key === key);

              if (
                candidate &&
                (status.source === null ||
                  sourceKey(status.source) !== candidate.key)
              )
                configure(candidate.source);
            }}
          />
        )
      ) : null}
      {status.source !== null ? (
        <SettingsRow>
          <p
            className={
              status.lastRun?.ok === false
                ? "min-w-0 flex-1 truncate text-xs text-warning-text"
                : "min-w-0 flex-1 truncate text-xs text-subtle-foreground"
            }
          >
            {lastRunText(status, Date.now())}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending || status.running || !desktopBrowser.runCookieSync
            }
            onClick={() => {
              if (desktopBrowser.runCookieSync)
                apply(desktopBrowser.runCookieSync());
            }}
          >
            Sync now
          </Button>
        </SettingsRow>
      ) : null}
      {error ? <p className="text-sm text-destructive-text">{error}</p> : null}
    </div>
  );
}
