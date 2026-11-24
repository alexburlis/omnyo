import { useEffect, useState } from "react";
import type {
  OmnyoDesktopApi,
  OmnyoDesktopBrowserApi,
} from "@omnyo/desktop-contract";
import {
  DESKTOP_BROWSER_IMPORT_FAILURE_COPY,
  type DesktopBrowserCookieSyncStatus,
} from "@omnyo/host-daemon-contract";
import {
  recommendedCandidate,
  sourceKey,
  syncCandidates,
  type SyncCandidate,
} from "@/components/settings/browser-import-wizard";
import {
  BrowserStep,
  OnboardingLayout,
  type OnboardingStepChrome,
} from "./OnboardingViews";

export type BrowserLoginApi = OmnyoDesktopBrowserApi &
  Required<
    Pick<
      OmnyoDesktopBrowserApi,
      "listImportSources" | "configureCookieSync" | "cookieSyncStatus"
    >
  >;

export function browserLoginApi(
  desktopInfo: OmnyoDesktopApi | null,
): BrowserLoginApi | null {
  const browser = desktopInfo?.browser;

  if (
    (desktopInfo?.platform !== "macos" && desktopInfo?.platform !== "linux") ||
    !browser?.listImportSources ||
    !browser.configureCookieSync ||
    !browser.cookieSyncStatus
  )
    return null;

  return {
    ...browser,
    listImportSources: browser.listImportSources,
    configureCookieSync: browser.configureCookieSync,
    cookieSyncStatus: browser.cookieSyncStatus,
  };
}

type BrowserStepData =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      candidates: SyncCandidate[];
      recommended: SyncCandidate | null;
      syncing: DesktopBrowserCookieSyncStatus["source"];
    };

export function OnboardingBrowserStep({
  chrome,
  browser,
  permissionNote,
  onBack,
  onContinue,
  onSkip,
  onConnectedChange,
}: {
  chrome: OnboardingStepChrome;
  browser: BrowserLoginApi;
  permissionNote: string | null;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onConnectedChange: (connected: boolean) => void;
}) {
  const [data, setData] = useState<BrowserStepData>({ status: "loading" });
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedConnect, setFailedConnect] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([browser.listImportSources(), browser.cookieSyncStatus()])
      .then(([listing, status]) => {
        if (!active) return;
        const candidates = syncCandidates(listing.sources);
        setData({
          status: "ready",
          candidates,
          recommended: recommendedCandidate(
            candidates,
            listing.recommended ?? null,
          ),
          syncing: status.source,
        });
      })
      .catch(() => {
        if (active) setData({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [browser]);

  const ready = data.status === "ready" ? data : null;
  const syncingKey = ready?.syncing ? sourceKey(ready.syncing) : null;
  const selectedKey = chosenKey ?? syncingKey ?? ready?.recommended?.key;

  const selected =
    ready === null
      ? null
      : (ready.candidates.find((candidate) => candidate.key === selectedKey) ??
        ready.candidates[0] ??
        null);

  const connected =
    selected !== null && syncingKey === selected.key && !failedConnect;

  useEffect(() => onConnectedChange(connected), [connected, onConnectedChange]);

  const connect = () => {
    if (selected === null) return;
    setPending(true);
    setError(null);
    browser
      .configureCookieSync(selected.source)
      .then((status) => {
        if (status.lastRun?.ok === false) {
          setFailedConnect(true);
          setError(DESKTOP_BROWSER_IMPORT_FAILURE_COPY[status.lastRun.reason]);

          return;
        }

        onContinue();
      })
      .catch(() => {
        setFailedConnect(true);
        setError(`Could not connect ${selected.browserName}.`);
      })
      .finally(() => setPending(false));
  };

  const skip = () => {
    if (!failedConnect) {
      onSkip();

      return;
    }

    setPending(true);
    browser
      .configureCookieSync(null)
      .then(onSkip)
      .catch(() => setError("Could not turn off login sync."))
      .finally(() => setPending(false));
  };

  const primaryLabel =
    selected === null || connected
      ? "Continue"
      : failedConnect
        ? "Try again"
        : `Connect ${selected.browserName}`;

  return (
    <OnboardingLayout
      {...chrome}
      step="browser"
      title="Use your browser's logins"
      description="Omnyo's browser and your agents stay signed in to the sites you use. Logins stay on this computer."
      footerNote={selected !== null && !connected ? permissionNote : null}
      primaryLabel={primaryLabel}
      primaryBusy={pending}
      primaryDisabled={data.status === "loading" || pending}
      {...(selected === null || connected
        ? {}
        : { secondaryLabel: "Not now", onSecondary: skip })}
      onPrimary={selected === null || connected ? onContinue : connect}
      onBack={onBack}
    >
      {data.status === "loading" ? null : (
        <BrowserStep
          selected={selected}
          choices={ready?.candidates ?? []}
          selectedIsDefault={
            selected !== null && selected.key === ready?.recommended?.key
          }
          connected={connected}
          error={
            data.status === "error"
              ? "Could not check the browsers on this computer."
              : error
          }
          disabled={pending}
          onSelect={(key) => {
            setChosenKey(key);
            setError(null);
          }}
        />
      )}
    </OnboardingLayout>
  );
}
