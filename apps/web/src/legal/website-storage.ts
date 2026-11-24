import {
  ANALYTICS_CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  DIAGNOSTICS_CONSENT_COOKIE,
} from "../analytics/config";
import { THEME_STORAGE_KEY } from "../lib/theme";

export const CONSENT_DAYS = CONSENT_MAX_AGE_SECONDS / (24 * 60 * 60);

export const LEGACY_POSTHOG_EVENT_RETENTION = "up to seven years";

export const LEGACY_REPLAY_RETENTION_DAYS = 30;

export const SENTRY_RETENTION_DAYS = 90;

export const SCROLL_RESTORATION_KEY = "tsr-scroll-restoration-v1_3";

export interface StorageItem {
  names: readonly string[];
  kind: "Cookie" | "Session storage" | "Local storage";
  site: string;
  provider: string;
  purpose: string;
  duration: string;
}

export interface StorageGroup {
  id: string;
  title: string;
  when: string;
  note?: string;
  basis: string;
  items: readonly StorageItem[];
}

export const WEBSITE_STORAGE: readonly StorageGroup[] = [
  {
    id: "necessary",
    title: "Necessary: your cookie choice",
    when: "Set when you make a choice in the cookie banner, never before. Each holds only “accepted” or “rejected” and the time you chose.",
    basis:
      "Needed to respect your choice (§25(2) no. 2 TDDDG) and to show that you consented (Art. 6(1)(c) with Art. 7(1) GDPR).",
    items: [
      {
        names: [ANALYTICS_CONSENT_COOKIE],
        kind: "Cookie",
        site: "omnyohq.com",
        provider: "Omnyo",
        purpose: "Remembers whether you allowed Usage analytics.",
        duration: `${CONSENT_DAYS} days`,
      },
      {
        names: [DIAGNOSTICS_CONSENT_COOKIE],
        kind: "Cookie",
        site: "omnyohq.com",
        provider: "Omnyo",
        purpose: "Remembers whether you allowed Error reports.",
        duration: `${CONSENT_DAYS} days`,
      },
    ],
  },
  {
    id: "navigation",
    title: "Necessary: your place on the page",
    when: "Set while you browse, before any choice. It holds only scroll positions and never leaves your browser.",
    basis: "Needed for the navigation you asked for (§25(2) no. 2 TDDDG).",
    items: [
      {
        names: [SCROLL_RESTORATION_KEY],
        kind: "Session storage",
        site: "omnyohq.com",
        provider: "Omnyo",
        purpose:
          "Remembers how far down each page you were in this tab, so Back returns you to the same place.",
        duration: "Until you close the tab",
      },
    ],
  },
  {
    id: "display",
    title: "Necessary: your light or dark choice",
    when: "Set only when you switch to the mode your device does not use. Switching back to your device’s mode deletes it. It holds only “light” or “dark” and never leaves your browser.",
    basis: "Needed to keep the display setting you chose (§25(2) no. 2 TDDDG).",
    items: [
      {
        names: [THEME_STORAGE_KEY],
        kind: "Local storage",
        site: "omnyohq.com",
        provider: "Omnyo",
        purpose:
          "Remembers whether you chose light or dark mode, so every page opens that way.",
        duration: "Until you switch back or clear this site’s data",
      },
    ],
  },
];

export const CONNECT_STORAGE: StorageGroup = {
  id: "connect",
  title: "Necessary: sign-in and security",
  when: "Only if you use Omnyo connect. Each one is needed to sign you in or to protect your address.",
  basis:
    "Needed for the service you asked for (§25(2) no. 2 TDDDG, Art. 6(1)(b) GDPR).",
  items: [
    {
      names: ["__Host-omnyo.session_token"],
      kind: "Cookie",
      site: "omnyo.link",
      provider: "Omnyo",
      purpose: "Keeps you signed in to your Omnyo connect account.",
      duration: "7 days, renewed once a day while you use it",
    },
    {
      names: ["__Host-omnyo.state"],
      kind: "Cookie",
      site: "omnyo.link",
      provider: "Omnyo",
      purpose: "Ties a GitHub sign-in to the browser that started it.",
      duration: "5 minutes",
    },
    {
      names: ["__Host-omnyo-nonce"],
      kind: "Cookie",
      site: "Your address, such as yourhandle.omnyo.link",
      provider: "Omnyo",
      purpose: "Checks the one-time hand-off from sign-in to your address.",
      duration: "10 minutes",
    },
    {
      names: ["__Host-omnyo-gate"],
      kind: "Cookie",
      site: "Your address, such as yourhandle.omnyo.link",
      provider: "Omnyo",
      purpose:
        "Lets your signed-in browser open your own server through the relay.",
      duration: "Until your sign-in ends, at most 7 days",
    },
    {
      names: ["__Secure-omnyo-connect.desktop_session"],
      kind: "Cookie",
      site: "omnyo.link and your address",
      provider: "Omnyo",
      purpose:
        "Lets a paired Omnyo app on your computer or phone open your address without signing in again.",
      duration: "7 days, renewed once a day while you use it",
    },
  ],
};
