import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketplaceIndex } from "../explore/MarketplaceIndex";
import { marketplaceItems } from "../explore/marketplace.server";
import {
  ANALYTICS_CONSENT_COOKIE,
  DIAGNOSTICS_CONSENT_COOKIE,
  LEGACY_ANALYTICS_CONSENT_COOKIE,
} from "./config";
import {
  analyticsChoice,
  consentGrants,
  removePosthogStorage,
  savePurposeChoices,
} from "./consent";
import {
  resultCountBucket,
  sendSiteUsage,
  siteRoute,
  stopSiteUsage,
} from "./usage";

function browser({
  analytics = true,
  diagnostics = false,
  dnt = "",
  gpc = false,
  pathname = "/explore",
} = {}) {
  const cookies = new Map<string, string>();
  cookies.set(
    ANALYTICS_CONSENT_COOKIE,
    `${analytics ? "accepted" : "rejected"}:${Date.now()}`,
  );
  cookies.set(
    DIAGNOSTICS_CONSENT_COOKIE,
    `${diagnostics ? "accepted" : "rejected"}:${Date.now()}`,
  );
  const document = {};
  Object.defineProperty(document, "cookie", {
    get: () =>
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (value: string) => {
      const pair = value.split(";", 1)[0] ?? "";
      const equal = pair.indexOf("=");
      const name = pair.slice(0, equal);

      if (value.includes("Max-Age=0")) cookies.delete(name);
      else cookies.set(name, pair.slice(equal + 1));
    },
  });

  const storage = () => {
    const data = new Map<string, string>();

    return {
      get length() {
        return data.size;
      },
      key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => data.delete(key),
      setItem: (key: string, value: string) => data.set(key, value),
      getItem: (key: string) => data.get(key) ?? null,
    };
  };

  const calls: RequestInit[] = [];

  const window = {
    location: { hostname: "omnyohq.com", pathname, protocol: "https:" },
    localStorage: storage(),
    sessionStorage: storage(),
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init !== undefined) calls.push(init);

      return new Response(null, { status: 204 });
    }),
  };

  vi.stubGlobal("window", window);
  vi.stubGlobal("location", window.location);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { doNotTrack: dnt, globalPrivacyControl: gpc });
  vi.stubGlobal("BroadcastChannel", undefined);

  return { cookies, window, calls };
}

afterEach(() => {
  stopSiteUsage();
  vi.unstubAllGlobals();
});

describe("first-party semantic usage", () => {
  it("sends only a declared event and never reads DOM content", () => {
    const { calls } = browser();
    sendSiteUsage({ name: "marketplace_results", count: "1-5" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(
      '{"event":{"name":"marketplace_results","count":"1-5"}}',
    );
    expect(calls[0]).toMatchObject({
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      keepalive: false,
      redirect: "error",
    });
  });

  it.each([
    { analytics: false },
    { dnt: "1" },
    { gpc: true },
    { pathname: "/w/private" },
  ])(
    "does not send with refusal, objection or private pages: %j",
    (options) => {
      const { calls } = browser(options);
      sendSiteUsage({ name: "route_view", route: "home" });
      expect(calls).toHaveLength(0);
    },
  );

  it("aborts pending sends, prevents new sends after refusal and does not replay after regrant", () => {
    const { calls, cookies } = browser();
    sendSiteUsage({ name: "download_click", os: "mac" });
    const signal = calls[0]?.signal;
    savePurposeChoices({ analytics: false, diagnostics: false });
    stopSiteUsage();
    expect(signal?.aborted).toBe(true);
    sendSiteUsage({ name: "download_click", os: "mac" });
    expect(calls).toHaveLength(1);
    cookies.set(ANALYTICS_CONSENT_COOKIE, `accepted:${Date.now()}`);
    expect(calls).toHaveLength(1);
    sendSiteUsage({ name: "download_click", os: "mac" });
    expect(calls).toHaveLength(2);
  });

  it("keeps diagnostics independent of the analytics choice", () => {
    browser({ analytics: false, diagnostics: true });
    expect(consentGrants()).toEqual({ analytics: false, diagnostics: true });
  });

  it("does not turn legacy acceptance into a new grant and preserves legacy refusal", () => {
    const { cookies } = browser();
    cookies.delete(ANALYTICS_CONSENT_COOKIE);
    cookies.set(LEGACY_ANALYTICS_CONSENT_COOKIE, `accepted:${Date.now()}`);
    expect(analyticsChoice()).toBeNull();
    cookies.set(LEGACY_ANALYTICS_CONSENT_COOKIE, `rejected:${Date.now()}`);
    expect(analyticsChoice()).toBe("rejected");
  });

  it("cleans earlier SDK keys without deleting other browser storage", () => {
    const { cookies, window } = browser();
    cookies.set("ph_old_posthog", "legacy");
    window.localStorage.setItem("ph_old_posthog", "legacy");
    window.sessionStorage.setItem("__ph_old", "legacy");
    window.localStorage.setItem("theme", "dark");
    removePosthogStorage();
    expect(cookies.has("ph_old_posthog")).toBe(false);
    expect(window.localStorage.getItem("ph_old_posthog")).toBeNull();
    expect(window.sessionStorage.getItem("__ph_old")).toBeNull();
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("renders a private query but emits only result and route buckets", () => {
    const marker = "PRIVATE_QUERY_MARKER";

    const html = renderToStaticMarkup(
      <MarketplaceIndex items={marketplaceItems} search={{ q: marker }} />,
    );

    expect(html).toContain(marker);
    const { calls } = browser();
    sendSiteUsage({ name: "marketplace_results", count: resultCountBucket(0) });
    sendSiteUsage({
      name: "route_view",
      route: siteRoute(`/explore/skills/${marker}?q=${marker}`),
    });
    expect(JSON.stringify(calls)).not.toContain(marker);
    expect(calls.map(({ body }) => body)).toEqual([
      '{"event":{"name":"marketplace_results","count":"0"}}',
      '{"event":{"name":"route_view","route":"listing"}}',
    ]);
  });
});
