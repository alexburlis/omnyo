import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  ConsentBanner,
  type ConsentChoice,
} from "../components/consent/ConsentBanner";
import {
  browserObjects,
  type ConsentDefault,
} from "../components/consent/consent-region";
import { watchConsentWithdrawal } from "../components/consent/consent-withdrawal";
import { startBrowserErrors, stopBrowserErrors } from "./browser-errors";
import { CONSENT_CHANNEL } from "./config";
import {
  consentGrants,
  loadConsentDefault,
  removePosthogStorage,
  savePurposeChoices,
  storedChoice,
  type ConsentGrants,
} from "./consent";
import { sendSiteUsage, siteRoute, stopSiteUsage } from "./usage";

const NO_GRANTS: ConsentGrants = { analytics: false, diagnostics: false };

const SETTINGS_TRIGGER = "[data-cookie-settings]";

function stopOptionalTools(): void {
  stopSiteUsage();
  stopBrowserErrors();
}

function focusDialog(): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>("[data-consent-dialog]")
      ?.focus({ preventScroll: true });
  });
}

export function SiteConsent() {
  const [saved, setSaved] = useState<ConsentChoice | null>(null);
  const [regionDefault, setRegionDefault] = useState<ConsentDefault>(null);
  const [granted, setGranted] = useState<ConsentGrants>(NO_GRANTS);
  const [objecting, setObjecting] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pageHasControl, setPageHasControl] = useState(true);
  const opener = useRef<HTMLElement | null>(null);

  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const changeOpen = (next: boolean) => {
    setOpen(next);

    if (next) return;
    const target = opener.current;
    opener.current = null;

    if (target?.isConnected === true)
      requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  useEffect(() => {
    setPageHasControl(document.querySelector(SETTINGS_TRIGGER) !== null);
  }, [pathname]);

  useEffect(() => {
    const choice = storedChoice();
    const current = consentGrants();
    setSaved(choice);
    setGranted(current);
    setObjecting(browserObjects());

    removePosthogStorage();

    if (choice !== null) return;
    let disposed = false;

    void loadConsentDefault().then((value) => {
      if (disposed) return;
      setRegionDefault(value);
      setOpen((now) => now || value === null);
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!granted.analytics && !granted.diagnostics) return;

    if (granted.diagnostics) startBrowserErrors();

    const stopWatching = watchConsentWithdrawal({
      channelName: CONSENT_CHANNEL,
      isAccepted: () => {
        const now = consentGrants();

        return (
          (!granted.analytics || now.analytics) &&
          (!granted.diagnostics || now.diagnostics)
        );
      },
      onWithdraw: () => {
        const now = consentGrants();

        if (!now.analytics) stopSiteUsage();

        if (!now.diagnostics) stopBrowserErrors();
        setGranted(now);
        setSaved(storedChoice());
        setObjecting(browserObjects());
      },
    });

    return () => {
      stopWatching();
    };
  }, [granted]);

  useEffect(() => {
    const openFromPage = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest(SETTINGS_TRIGGER);

      if (control === null) return;
      event.preventDefault();
      opener.current = control instanceof HTMLElement ? control : null;
      setOpen(true);
      focusDialog();
    };

    document.addEventListener("click", openFromPage);

    return () => document.removeEventListener("click", openFromPage);
  }, []);

  useEffect(() => {
    if (granted.analytics)
      sendSiteUsage({ name: "route_view", route: siteRoute(pathname) });
  }, [pathname, granted.analytics]);

  const save = (next: ConsentGrants) => {
    const withdrew =
      (granted.analytics && !next.analytics) ||
      (granted.diagnostics && !next.diagnostics);

    try {
      savePurposeChoices(next);
    } catch {
      stopOptionalTools();
      setGranted(NO_GRANTS);
      setFailed(true);
      setOpen(true);

      return;
    }

    if (withdrew) {
      if (!next.analytics) stopSiteUsage();

      if (!next.diagnostics) stopBrowserErrors();
    }

    setFailed(false);
    setSaved(storedChoice());
    setGranted(consentGrants());
    changeOpen(false);
  };

  return (
    <ConsentBanner
      key={`${granted.analytics}:${granted.diagnostics}`}
      choice={saved ?? (regionDefault === "rejected" ? "rejected" : null)}
      open={open}
      onOpenChange={changeOpen}
      classes={pageHasControl ? { trigger: "omnyo-consent-page-control" } : {}}
      onChoose={(value) =>
        save({
          analytics: value === "accepted",
          diagnostics: value === "accepted",
        })
      }
      labels={{
        region: "Cookie settings",
        settings: "Cookie settings",
        reject: "Reject all",
        accept: "Accept all",
        close: "Close cookie settings",
      }}
      status={
        objecting
          ? "Your browser asks sites not to track you, so these stay off."
          : undefined
      }
      description="Burlis Management GmbH would like to count use of this website and receive browser error reports. Usage counts contain no visitor ID or search text. The site works the same either way."
      error={
        failed
          ? "Your choice couldn’t be saved. Allow cookies for this site and try again."
          : undefined
      }
      links={
        <>
          <a href="/privacy">Privacy</a>
          <a href="/cookies">Cookies</a>
        </>
      }
      preferences={{
        label: "Choose purposes",
        save: "Save choices",
        onSave: (values) =>
          save({
            analytics: values.analytics === true,
            diagnostics: values.diagnostics === true,
          }),
        purposes: [
          {
            id: "analytics",
            label: "Usage analytics",
            enabled: granted.analytics,
            description:
              "Counts page sections, download clicks, result-count ranges and interest in kinds of public listings. No recordings, visitor ID or search terms. See Privacy for collection availability.",
          },
          {
            id: "diagnostics",
            label: "Error reports",
            enabled: granted.diagnostics,
            description:
              "Sentry (EU) receives the technical details of an error in your browser, such as the failing code and your browser version, so we can fix it.",
          },
        ],
        disclosure: (
          <p>
            We remember your choice for 180 days. The privacy policy lists
            providers, retention and your rights.
          </p>
        ),
      }}
    />
  );
}
