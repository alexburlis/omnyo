import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import {
  ANALYTICS_CONSENT_COOKIE,
  DIAGNOSTICS_CONSENT_COOKIE,
} from "./analytics/config";
import { Route } from "./routes/privacy";
import {
  SITE_USAGE_DICTIONARY,
  siteUsageEventSchema,
} from "@omnyo/domain/site-usage";
import {
  productUsageEventSchema,
  productUsageReportSchema,
  publicUsageListingSchema,
} from "@omnyo/domain/usage-telemetry";
import { PRODUCT_USAGE_DICTIONARY } from "./legal/product-data-dictionary";

function renderPrivacyPage() {
  const Page = Route.options.component;

  if (Page === undefined) throw new Error("The privacy route has no page");

  return renderToStaticMarkup(<Page />);
}

function section(html: string, id: string) {
  const start = html.indexOf(`<h2 id="${id}">`);

  if (start === -1) throw new Error(`The privacy page has no ${id} section`);

  return html.slice(start, html.indexOf("<h2 ", start + 1));
}

it("describes Omnyo and Omnyo connect at the Omnyo relay's domain", () => {
  const html = renderPrivacyPage();

  expect(html).toContain("<strong>the Omnyo apps</strong>");
  expect(html).toContain('<h2 id="connect">Omnyo connect</h2>');
  expect(html).toContain("<code>omnyo.link</code>");
  expect(html).toContain("<code>yourhandle.omnyo.link</code>");
  expect(html).toContain("<code>OMNYO_TELEMETRY=false</code>");
  expect(html).toContain("monthly total of how much traffic the relay carries");
  expect(html).not.toMatch(/\bbb (apps?|server|connect)\b/u);
});

it("links every contents entry to a heading on the page", () => {
  const html = renderPrivacyPage();

  const links = [...html.matchAll(/<a href="#([\w-]+)">/gu)].map(
    (match) => match[1],
  );

  expect(links.length).toBeGreaterThan(8);

  for (const id of links) expect(html).toContain(`<h2 id="${id}">`);
});

it("says the website asks before analytics and error reports and honors GPC and DNT", () => {
  const website = section(renderPrivacyPage(), "website");

  expect(website).toContain("Until you choose, the site sets no");
  expect(website).toContain("We ask every visitor, wherever they are.");
  expect(website).toContain("data-cookie-settings");
  expect(website).toContain('href="/cookies"');
  expect(website).toContain("<code>Sec-GPC: 1</code>");
  expect(website).toContain("<code>DNT: 1</code>");
  expect(website).toContain("There is no session recording");
  expect(website).toContain("never the words you type");
  expect(website).toContain("no visitor IP address");
  expect(website).toContain("§25(1) TDDDG, Art. 6(1)(a) GDPR");
  expect(website).toContain("Errors on our server");
  expect(website).not.toContain("sets no cookies and loads no analytics");
});

it("names the retention of analytics, replays and error reports", () => {
  const retention = section(renderPrivacyPage(), "retention")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ");

  expect(retention).toContain("for up to seven years");
  expect(retention).toContain("session replays for 30 days");
  expect(retention).toContain("error reports for at most 90 days");
});

it("states our own transfer safeguards and separates processors from independent controllers", () => {
  const providers = section(renderPrivacyPage(), "providers")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ");

  expect(providers).toContain(
    "Where one of our processors moves data outside the EU or the EEA, we rely on the EU–US Data Privacy Framework for providers certified under it, and otherwise on the European Commission’s standard contractual clauses in our agreement with them",
  );
  expect(providers).toContain("under a data processing agreement");
  expect(providers).toContain("Proton AG, Switzerland");
  expect(providers).toContain("as independent controllers");
  expect(providers).not.toContain("they state that they rely on");
  expect(providers).not.toContain("Let’s Encrypt");
});

it("leaves the cookie inventory to the cookie policy", () => {
  const html = renderPrivacyPage();

  expect(html).not.toContain(ANALYTICS_CONSENT_COOKIE);
  expect(html).not.toContain(DIAGNOSTICS_CONSENT_COOKIE);
});

it("makes no upstream bb claims about Omnyo", () => {
  const policy = /<article[\s\S]*<\/article>/u.exec(renderPrivacyPage())?.[0];

  if (policy === undefined) throw new Error("The privacy page has no policy");

  expect(policy).not.toContain("getbb.app");
  expect(policy).not.toContain("github.com/get-bb/bb");
  expect(policy).not.toContain("edge cache");
});

it("discloses crash reports and the public beta that sends neither kind of data", () => {
  const html = renderPrivacyPage();

  expect(html).toContain(
    "Settings → General → Privacy &amp; diagnostics → Crash reports",
  );
  expect(html).toContain("<code>OMNYO_SENTRY_DSN</code>");
  expect(html).toContain("The switch covers the app, the server");
  expect(html).toContain("<strong>Sentry</strong> (Functional Software, Inc.)");
  expect(html).toContain(
    "Earlier beta packages contained production collector configuration",
  );
  expect(html).not.toContain(
    "The iOS and Android apps send no analytics, no telemetry, and no crash reports",
  );
});

it("publishes the exact event dictionary and distinguishes old clients from new streams", () => {
  const html = renderPrivacyPage();

  for (const name of [
    "route_view",
    "download_click",
    "marketplace_results",
    "listing_open",
    "install_intent",
    "public_plugin_installed",
    "first_accepted_action",
  ])
    expect(html).toContain(`<code>${name}</code>`);
  expect(html).toContain("/metrics/site-events");
  expect(html).toContain("no hidden SDK fields");
  expect(html).toContain("Older builds used a reusable installation ID");
  expect(html).toContain("does not erase those records");
  expect(html).not.toContain('href="https://github.com/alexburlis/omnyo"');
});

it("describes verified public installs, capped counts and raw retention accurately", () => {
  const text = renderPrivacyPage()
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ");

  expect(text).toContain("listing: workspace-github, sentry");
  expect(text).toContain("feature: chat, queued_message, plugin");
  expect(text).not.toContain(
    "feature: chat, queued_message, plugin, automation",
  );
  expect(text).toContain("completed, verified public connector installations");
  expect(text).toContain("cumulative count from 1 to 100");
  expect(text).toContain("Daily activity is capped at one");
  expect(text).toContain("hash of the random client grant");
  expect(text).toContain("expire after 30 UTC calendar days");
  expect(text).toContain("at least 10 contributing subjects");
  expect(text).toContain("measurement window has matured");
  expect(text).toContain("sent at fixed UTC hour boundaries");
  expect(text).toContain("no per-action, page-close or shutdown flush");
  expect(text).toContain("failed or stale batches are not retried");
  expect(text).toContain(
    "since_grant: under_1m, 1_to_10m, 10_to_60m, over_60m",
  );
  expect(text).toContain("not time to a model answer");
  expect(text).toContain(
    "failure_reason: nonzero_exit, start_rejected, unknown (failed sign-in only)",
  );
  expect(text).toContain("omit provider identity and free-form error text");
  expect(text).not.toContain("provider: codex, claude, custom");
  expect(
    productUsageEventSchema.safeParse({
      event: "operation",
      properties: {
        operation: "message",
        outcome: "accepted",
        latency: "under_1s",
        provider: "codex",
      },
    }).success,
  ).toBe(false);
  expect(
    productUsageEventSchema.safeParse({
      event: "first_accepted_action",
      properties: { since_grant: "1_to_10m" },
    }).success,
  ).toBe(true);

  const example = {
    event: "public_plugin_installed",
    properties: { listing: publicUsageListingSchema.options[0] },
    subject: "1".repeat(64),
    day: "2026-11-24",
    count: 100,
  };

  expect(productUsageReportSchema.safeParse(example).success).toBe(true);
  expect(
    productUsageReportSchema.safeParse({ ...example, count: 101 }).success,
  ).toBe(false);
  expect(
    productUsageReportSchema.safeParse({
      ...example,
      properties: { listing: "private-project" },
    }).success,
  ).toBe(false);
});

it("keeps the public dictionaries matched to their event schemas", () => {
  expect(SITE_USAGE_DICTIONARY.map(({ name }) => name).sort()).toEqual(
    siteUsageEventSchema.def.options
      .map((event) => event.shape.name.def.values[0])
      .sort(),
  );
  expect(PRODUCT_USAGE_DICTIONARY.map(({ name }) => name).sort()).toEqual(
    productUsageEventSchema.options
      .map((event) => event.shape.event.value)
      .sort(),
  );

  for (const { example } of PRODUCT_USAGE_DICTIONARY) {
    expect(productUsageEventSchema.safeParse(example).success).toBe(true);
  }

  for (const { name, fields } of PRODUCT_USAGE_DICTIONARY) {
    const schema = productUsageEventSchema.options.find(
      (event) => event.shape.event.value === name,
    );

    if (schema === undefined) throw new Error(`No schema for ${name}`);

    const documented = fields
      .split(";")
      .map((field) => field.split(":", 1)[0]?.trim());

    expect(documented.sort()).toEqual(
      Object.keys(schema.shape.properties.shape).sort(),
    );
  }
});
