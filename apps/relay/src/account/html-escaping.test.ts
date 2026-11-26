import { describe, expect, it } from "vitest";
import {
  machinePage,
  notYourServerPage,
  offlinePage,
  egressCapPage,
} from "../gate/pages.js";
import type { LinkRequestView } from "./account.js";
import type { AccountState, ServerSummary } from "./api.js";
import {
  dashboardPage,
  errorPage,
  GITHUB_MARK,
  linkPage,
  messageFor,
  OMNYO_MARK,
  signInPage,
} from "./html.js";

const HOSTILE = `"'><script>alert(1)</script><img src=x onerror=alert(2)><svg/onload=alert(3)>&amp;‮`;

const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "meta",
  "title",
  "style",
  "body",
  "main",
  "footer",
  "header",
  "a",
  "p",
  "form",
  "input",
  "button",
  "h1",
  "h2",
  "span",
  "strong",
  "ul",
  "li",
  "br",
  "div",
  "code",
]);

function expectInert(rendered: string): void {
  const html = rendered.replaceAll(OMNYO_MARK, "").replaceAll(GITHUB_MARK, "");

  const tags = [...html.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9-]*)/gu)].map(
    (match) => (match[1] ?? "").toLowerCase(),
  );

  for (const tag of tags) expect(ALLOWED_TAGS.has(tag), tag).toBe(true);

  for (const element of html.matchAll(/<[a-zA-Z][^>]*>/gu)) {
    const unquoted = element[0].replace(/"[^"]*"/gu, '""');
    expect(unquoted).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(unquoted.slice(1)).not.toMatch(/['<]/u);
  }

  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<svg");
  expect(html).not.toContain(`"'>`);

  for (const href of html.matchAll(/\s(?:href|action)="([^"]*)"/gu)) {
    expect(href[1] ?? "", "link target").toMatch(/^(?:https:\/\/|\/)/u);
  }
}

function hostileServer(overrides: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: HOSTILE,
    subdomain: HOSTILE,
    name: HOSTILE,
    isPrimary: false,
    connected: false,
    online: false,
    lastSeenAt: null,
    version: HOSTILE,
    createdAt: 0,
    serverUrl: "https://alexb.relay.test",
    ...overrides,
  };
}

function hostileState(handle: string | null): AccountState {
  return {
    handle,
    suggestedHandle: HOSTILE,
    servers: [
      hostileServer(),
      hostileServer({ connected: true, online: true, isPrimary: true }),
    ],
    appUrl: "https://relay.test",
    serverUrlTemplate: "https://{label}.relay.test",
    githubLogin: HOSTILE,
    maxServers: 5,
    machines: [
      {
        id: HOSTILE,
        name: HOSTILE,
        subdomain: HOSTILE,
        online: true,
        lastSeenAt: null,
        createdAt: 0,
      },
      {
        id: "m2",
        name: null,
        subdomain: null,
        online: false,
        lastSeenAt: null,
        createdAt: 1,
      },
    ],
  };
}

const request = {
  userCode: HOSTILE,
  clientName: HOSTILE,
  requestedAt: 0,
  location: HOSTILE,
  expiresAt: 1,
};

describe("account site output escaping with hostile values", () => {
  it("renders the dashboard inert for hostile login, names, ids and codes", () => {
    for (const handle of [null, HOSTILE]) {
      expectInert(
        dashboardPage(hostileState(handle), {
          message: HOSTILE,
          issued: {
            code: HOSTILE,
            expiresInMs: 600_000,
            serverUrl: HOSTILE,
            serverId: HOSTILE,
            replacesConnectedServer: true,
            takesOverDevices: 0,
          },
        }),
      );
    }
  });

  it("renders every link page state inert for a hostile device-supplied client name", () => {
    const views: LinkRequestView[] = [
      { state: "invalid" },
      { state: "expired" },
      { state: "used" },
      { state: "denied" },
      { state: "approved", serverUrl: "https://alexb.relay.test" },
      {
        state: "claim-handle",
        request,
        suggestedHandle: HOSTILE,
        serverUrlTemplate: "https://{label}.relay.test",
      },
      {
        state: "choose-server",
        request,
        handle: HOSTILE,
        servers: [hostileServer(), hostileServer({ isPrimary: true })],
        usedServers: 1,
        maxServers: 5,
        suggestedLabel: HOSTILE,
        serverUrlTemplate: "https://{label}.relay.test",
      },
    ];

    for (const view of views) expectInert(linkPage(view, HOSTILE, HOSTILE));
  });

  it("renders the sign-in and error pages inert", () => {
    expectInert(signInPage(HOSTILE, HOSTILE));

    for (const status of [400, 403, 404, 429, 500]) {
      expectInert(errorPage(status));
    }
  });

  it("only turns known message keys into text", () => {
    for (const key of [
      HOSTILE,
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(messageFor(key)).toBeNull();
    }
  });

  it("renders gate pages inert for a hostile label and origin", async () => {
    const pages = [
      notYourServerPage(HOSTILE),
      machinePage(HOSTILE, "https://relay.test", HOSTILE),
      offlinePage(new Date(0), "server", 1_000, {}),
      offlinePage(null, "machine", 1_000, {}),
      egressCapPage(100_000_000_000, new Date(Date.UTC(2026, 11, 1)), 0),
    ];

    for (const response of pages) {
      expectInert(await response.text());
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    }
  });
});
