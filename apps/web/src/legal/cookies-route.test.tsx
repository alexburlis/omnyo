import { createRequire } from "node:module";

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import {
  ANALYTICS_CONSENT_COOKIE,
  DIAGNOSTICS_CONSENT_COOKIE,
} from "../analytics/config";
import { OPERATOR } from "../landing/site";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { Route } from "../routes/cookies";
import { SCROLL_RESTORATION_KEY } from "./website-storage";
import {
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
} from "../../../relay/src/auth/cookies";
import {
  GATE_COOKIE,
  NONCE_COOKIE,
  SECURE_DESKTOP_SESSION_COOKIE,
} from "../../../relay/src/gate/cookies";

function renderCookiePolicy() {
  const Page = Route.options.component;

  if (Page === undefined) throw new Error("The cookie route has no page");

  return renderToStaticMarkup(<Page />);
}

function listedNames(html: string): string[] {
  return [
    ...html.matchAll(/<code class="legal-storage-name">([^<]+)<\/code>/gu),
  ].map((match) => (match[1] ?? "").replace("&lt;", "<").replace("&gt;", ">"));
}

it("lists only current consent and necessary browser storage", () => {
  const html = renderCookiePolicy();

  expect(listedNames(html)).toEqual(
    expect.arrayContaining([
      ANALYTICS_CONSENT_COOKIE,
      DIAGNOSTICS_CONSENT_COOKIE,
      SCROLL_RESTORATION_KEY,
      THEME_STORAGE_KEY,
    ]),
  );
  expect(listedNames(html).some((name) => name.startsWith("ph_"))).toBe(false);
  expect(html).toContain("Usage analytics writes no visitor ID");
  expect(html).toContain("leftover PostHog cookies");
});

it("lists the scroll restoration key under the name the installed router writes", () => {
  const require = createRequire(import.meta.url);

  const routerCore: unknown = require(
    createRequire(require.resolve("@tanstack/react-router")).resolve(
      "@tanstack/router-core",
    ),
  );

  expect(routerCore).toHaveProperty("storageKey", SCROLL_RESTORATION_KEY);
});

it("lists the Omnyo connect cookies under the names the relay sets", () => {
  expect(listedNames(renderCookiePolicy())).toEqual(
    expect.arrayContaining([
      SESSION_COOKIE_NAME,
      STATE_COOKIE_NAME,
      GATE_COOKIE,
      NONCE_COOKIE,
      SECURE_DESKTOP_SESSION_COOKIE,
    ]),
  );
});

it("offers the cookie settings control and names the operator", () => {
  const html = renderCookiePolicy();

  expect(html.match(/data-cookie-settings/gu)?.length).toBeGreaterThan(1);
  expect(html).toContain(OPERATOR.name);
  expect(html).toContain(`mailto:${OPERATOR.email}`);
  expect(html).toContain('href="/privacy"');
});
