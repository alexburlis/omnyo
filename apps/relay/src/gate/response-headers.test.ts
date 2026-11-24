import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_STRICT_TRANSPORT_SECURITY } from "../contracts.js";
import { issueGateCookie } from "./gate-cookie.js";
import {
  APP_URL,
  type Harness,
  type TestUser,
  cookiePair,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { GATE_KEY_LABEL, derivePurposeKey } from "./signed-token.js";

const OWNER_HOST = "sawyer.relay.test";

const PORT_SHARE_HOST = "sawyer--3000.relay.test";

const PREVIEW_PATH = "/preview-content/p1/cap1/index.html";

const RELAY_SANDBOX = "sandbox allow-scripts allow-forms";

let h: Harness;

let owner: TestUser;

let visitorIndex = 0;

function nextVisitorIp(): string {
  visitorIndex += 1;

  return `203.0.113.${(visitorIndex % 250) + 1}`;
}

function serve(response: () => Response): void {
  h.tunnels.origin = () => response();
}

function fillerCookies(prefix: string, count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, index): [string, string] => [
    "set-cookie",
    `${prefix}${index}=x; Path=/; Secure; SameSite=None; Max-Age=31536000`,
  ]);
}

function policies(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");

  return joined
    .split(",")
    .map((policy) => policy.trim())
    .filter((policy) => policy !== "");
}

function ownerCookie(host: string): string {
  const issued = issueGateCookie(
    derivePurposeKey(h.config.betterAuthSecret, GATE_KEY_LABEL),
    {
      userId: owner.id,
      host,
      sessionId: owner.sessionId,
      sessionExpiresAt: h.clock.now() + 24 * 60 * 60 * 1000,
    },
    h.clock.now(),
  );

  return cookiePair(issued.setCookie);
}

function ownerPage(host: string, path = "/", accept = "text/html") {
  return send(h.port, {
    host,
    path,
    headers: { cookie: ownerCookie(host), accept },
  });
}

beforeEach(async () => {
  h = await startHarness();
  owner = h.addUser("sawyer");
  h.addServer(owner.id, "sawyer");
  h.addMachine(owner.id, "sawyerphone");
  h.tunnels.connect("sawyer");
});

afterEach(async () => {
  await h.close();
});

it("does not report an asset attempt denied by the relay", async () => {
  const response = await send(h.port, {
    host: OWNER_HOST,
    path: "/assets/editor-AbCd1234.js",
    headers: { "x-omnyo-asset-attempt": randomUUID() },
  });

  expect(response.status).toBe(401);
  expect(h.tunnels.httpRequests).toHaveLength(0);
  expect(
    h.logs.filter((log) => log.event === "gate.split_asset_attempt"),
  ).toHaveLength(0);
});

it("bounds asset attempt diagnostics without limiting asset downloads", async () => {
  serve(() => new Response("asset"));
  const cookie = ownerCookie(OWNER_HOST);

  const download = () =>
    send(h.port, {
      host: OWNER_HOST,
      path: "/assets/editor-AbCd1234.js",
      headers: { cookie, "x-omnyo-asset-attempt": randomUUID() },
    });

  for (let index = 0; index < 120; index += 1) await download();
  const overBudget = await download();

  expect(overBudget.body).toBe("asset");
  expect(
    h.tunnels.httpRequests[120]?.headers.map(([name]) => name),
  ).not.toContain("x-omnyo-asset-attempt");
  expect(
    h.logs.filter((log) => log.event === "gate.split_asset_attempt"),
  ).toHaveLength(120);

  h.clock.advance(60_000);
  await download();
  expect(
    h.logs.filter((log) => log.event === "gate.split_asset_attempt"),
  ).toHaveLength(121);
});

it("forwards the asset attempt ID to the tunnel and logs the relay response outcome", async () => {
  serve(() => new Response("asset"));
  const assetAttemptId = "638e6779-928d-4543-a55f-59e31050b30e";

  const response = await send(h.port, {
    host: OWNER_HOST,
    path: "/assets/editor-AbCd1234.js",
    headers: {
      cookie: ownerCookie(OWNER_HOST),
      "x-omnyo-asset-attempt": assetAttemptId,
    },
  });

  expect(response.body).toBe("asset");
  expect(h.tunnels.httpRequests[0]?.headers).toContainEqual([
    "x-omnyo-asset-attempt",
    assetAttemptId,
  ]);
  expect(
    h.logs.filter((log) => log.event === "gate.split_asset_attempt"),
  ).toEqual([
    {
      level: "info",
      event: "gate.split_asset_attempt",
      fields: {
        assetAttemptId,
        elapsedMs: expect.any(Number),
        headersSent: true,
        responseFinished: true,
      },
    },
  ]);
});

it("reports an admitted asset attempt that disconnects before headers", async () => {
  let respond: (response: Response) => void = () => undefined;

  const upstream = new Promise<Response>((resolve) => {
    respond = resolve;
  });

  const assetAttemptId = randomUUID();

  const client = httpRequest({
    host: "127.0.0.1",
    port: h.port,
    path: "/assets/editor-AbCd1234.js",
    headers: {
      host: OWNER_HOST,
      "x-forwarded-for": nextVisitorIp(),
      cookie: ownerCookie(OWNER_HOST),
      "x-omnyo-asset-attempt": assetAttemptId,
    },
  });

  h.tunnels.origin = () => {
    client.destroy();

    return upstream;
  };

  client.on("error", () => undefined);
  client.end();

  try {
    await vi.waitFor(() => {
      expect(h.logs).toContainEqual({
        level: "info",
        event: "gate.split_asset_attempt",
        fields: {
          assetAttemptId,
          elapsedMs: expect.any(Number),
          headersSent: false,
          responseFinished: false,
        },
      });
    });
  } finally {
    client.destroy();
    respond(new Response(null, { status: 204 }));
  }
});

function rawUpgrade(
  host: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port: h.port,
      path: "/realtime",
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "x-forwarded-for": nextVisitorIp(),
        ...headers,
      },
    });

    outgoing.on("response", (incoming) => {
      incoming.resume();
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers });
    });
    outgoing.on("upgrade", (incoming, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: incoming.headers });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("upstream Set-Cookie", () => {
  it("never reaches a visitor from a preview response, a preview redirect or an installer response", async () => {
    const cases: Array<{ path: string; response: () => Response }> = [
      {
        path: PREVIEW_PATH,
        response: () =>
          new Response("<p>x</p>", {
            status: 200,
            headers: [
              ["content-type", "text/html"],
              ...fillerCookies("pv", 200),
              ["set-cookie", "d1=1; Path=/; Domain=relay.test"],
              ["set-cookie", "__Host-omnyo-gate=x; Path=/; Secure"],
              ["set-cookie", "host1=1; Path=/; Secure"],
            ],
          }),
      },
      {
        path: PREVIEW_PATH,
        response: () =>
          new Response(null, {
            status: 302,
            headers: [
              ["location", "/preview-content/p1/cap1/next.html"],
              ...fillerCookies("hop", 50),
            ],
          }),
      },
      {
        path: "/install.sh",
        response: () =>
          new Response(null, {
            status: 302,
            headers: [
              ["location", "/preview-content/a/b/next"],
              ...fillerCookies("hop", 10),
            ],
          }),
      },
      {
        path: "/install.sh",
        response: () =>
          new Response("echo hi\n", {
            status: 200,
            headers: fillerCookies("fill", 200),
          }),
      },
    ];

    for (const entry of cases) {
      serve(entry.response);

      const result = await send(h.port, {
        host: OWNER_HOST,
        path: entry.path,
        forwardedFor: nextVisitorIp(),
      });

      expect(result.setCookies, `${entry.path} ${result.status}`).toEqual([]);
    }
  });

  it("does not accumulate across several preview responses", async () => {
    let round = 0;

    serve(() => {
      round += 1;

      return new Response("<p>x</p>", {
        status: 200,
        headers: fillerCookies(`r${round}c`, 10),
      });
    });

    let delivered = 0;

    for (let step = 0; step < 19; step += 1) {
      const result = await send(h.port, {
        host: OWNER_HOST,
        path: `/preview-content/p1/cap1/page${step}.html`,
        forwardedFor: nextVisitorIp(),
      });

      expect(result.status).toBe(200);
      delivered += result.setCookies.length;
    }

    expect(delivered).toBe(0);
  });

  it("still passes host-only tenant cookies to the signed-in owner and refuses Domain and platform cookies", async () => {
    serve(
      () =>
        new Response("<p>app</p>", {
          status: 200,
          headers: [
            ["content-type", "text/html"],
            ["set-cookie", "theme=dark; Path=/; Secure"],
            ["set-cookie", "wide=1; Path=/; Domain=relay.test"],
            ["set-cookie", "__Host-omnyo-gate=x; Path=/; Secure"],
          ],
        }),
    );

    const page = await ownerPage(OWNER_HOST);

    expect(page.status).toBe(200);
    expect(page.setCookies).toEqual(["theme=dark; Path=/; Secure"]);
  });
});

describe("transport and opener policy", () => {
  it("does not let the owner's server replace the relay's Strict-Transport-Security", async () => {
    serve(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "strict-transport-security": "max-age=0" },
        }),
    );

    for (const path of [PREVIEW_PATH, "/install.sh"]) {
      const response = await send(h.port, {
        host: OWNER_HOST,
        path,
        forwardedFor: nextVisitorIp(),
      });

      expect(response.status, path).toBe(200);
      expect(
        response.headers["strict-transport-security"],
        path,
      ).toBeUndefined();
    }

    const page = await ownerPage(OWNER_HOST);

    expect(page.status).toBe(200);
    expect(page.headers["strict-transport-security"]).toBeUndefined();
  });

  it("isolates the owner's app documents from cross-origin openers unless the app sets its own policy", async () => {
    serve(
      () =>
        new Response("<p>app</p>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const page = await ownerPage(OWNER_HOST);

    expect(page.status).toBe(200);
    expect(page.headers["cross-origin-opener-policy"]).toBe(
      "same-origin-allow-popups",
    );

    serve(
      () =>
        new Response("<p>app</p>", {
          status: 200,
          headers: {
            "content-type": "text/html",
            "cross-origin-opener-policy": "same-origin",
          },
        }),
    );

    expect(
      (await ownerPage(OWNER_HOST)).headers["cross-origin-opener-policy"],
    ).toBe("same-origin");

    serve(() => Response.json({ ok: true }));

    expect(
      (await ownerPage(OWNER_HOST, "/api/state", "application/json")).headers[
        "cross-origin-opener-policy"
      ],
    ).toBeUndefined();
  });

  it("leaves port shares and previews without an opener policy", async () => {
    serve(
      () =>
        new Response("<p>dev</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const shared = await ownerPage(PORT_SHARE_HOST);

    expect(shared.status).toBe(200);
    expect(shared.headers["cross-origin-opener-policy"]).toBeUndefined();

    const preview = await send(h.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: nextVisitorIp(),
    });

    expect(preview.status).toBe(200);
    expect(preview.headers["cross-origin-opener-policy"]).toBeUndefined();
  });
});

describe("WebSocket upgrades", () => {
  it("carry the relay's Strict-Transport-Security when the owner's server refuses them, and the relay's own refusals carry it too", async () => {
    h.tunnels.openWsStream = async () => ({
      kind: "refused",
      response: new Response("no\n", {
        status: 403,
        headers: { "strict-transport-security": "max-age=0" },
      }),
    });

    const refusedByOwner = await rawUpgrade(OWNER_HOST, {
      cookie: ownerCookie(OWNER_HOST),
      origin: `https://${OWNER_HOST}`,
    });

    expect(refusedByOwner.status).toBe(403);
    expect(refusedByOwner.headers["strict-transport-security"]).toBe(
      RELAY_STRICT_TRANSPORT_SECURITY,
    );

    const refusedByRelay = await rawUpgrade(OWNER_HOST, {
      origin: `https://${OWNER_HOST}`,
    });

    expect(refusedByRelay.status).not.toBe(101);
    expect(refusedByRelay.headers["strict-transport-security"]).toBe(
      RELAY_STRICT_TRANSPORT_SECURITY,
    );
  });

  it("never names a subprotocol the visitor did not offer", async () => {
    const accept = h.tunnels.openWsStream.bind(h.tunnels);

    h.tunnels.openWsStream = async (request) => {
      const opened = await accept(request);

      return opened.kind === "accepted"
        ? { ...opened, protocol: "owner-picked" }
        : opened;
    };

    const named = await rawUpgrade(OWNER_HOST, {
      cookie: ownerCookie(OWNER_HOST),
      origin: `https://${OWNER_HOST}`,
      "sec-websocket-protocol": "visitor-one, visitor-two",
    });

    expect(named.status).toBe(101);
    expect(named.headers["sec-websocket-protocol"]).toBeUndefined();

    h.tunnels.openWsStream = accept;

    const echoed = await rawUpgrade(OWNER_HOST, {
      cookie: ownerCookie(OWNER_HOST),
      origin: `https://${OWNER_HOST}`,
      "sec-websocket-protocol": "visitor-one, visitor-two",
    });

    expect(echoed.status).toBe(101);
    expect(echoed.headers["sec-websocket-protocol"]).toBe("visitor-one");
  });
});

describe("preview sandbox", () => {
  it("keeps the relay sandbox as its own policy whatever CSP the upstream sends", async () => {
    const variants: Array<Array<[string, string]>> = [
      [["content-security-policy", "sandbox allow-scripts allow-same-origin"]],
      [
        [
          "content-security-policy",
          "default-src *; sandbox allow-scripts allow-same-origin allow-top-navigation",
        ],
      ],
      [
        ["Content-Security-Policy", "sandbox allow-same-origin"],
        ["content-security-policy", "script-src *"],
      ],
      [
        [
          "content-security-policy",
          "sandbox allow-same-origin, sandbox allow-scripts",
        ],
      ],
      [["content-security-policy-report-only", "sandbox allow-same-origin"]],
    ];

    for (const upstream of variants) {
      serve(
        () =>
          new Response("<p>x</p>", {
            status: 200,
            headers: [["content-type", "text/html"], ...upstream],
          }),
      );

      const page = await send(h.port, {
        host: OWNER_HOST,
        path: PREVIEW_PATH,
        forwardedFor: nextVisitorIp(),
      });

      expect(page.status).toBe(200);
      expect(
        policies(page.headers["content-security-policy"]),
        JSON.stringify(upstream),
      ).toContain(RELAY_SANDBOX);
    }
  });

  it("sandboxes preview redirects, errors, 304, ranges and HEAD responses and strips Clear-Site-Data", async () => {
    const cases: Array<{ method: string; response: () => Response }> = [
      {
        method: "GET",
        response: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.test/" },
          }),
      },
      {
        method: "GET",
        response: () =>
          new Response("<p>missing</p>", {
            status: 404,
            headers: {
              "content-type": "text/html",
              "clear-site-data": '"cookies"',
            },
          }),
      },
      { method: "GET", response: () => new Response(null, { status: 304 }) },
      {
        method: "GET",
        response: () =>
          new Response("abc", {
            status: 206,
            headers: {
              "content-type": "text/html",
              "content-range": "bytes 0-2/10",
            },
          }),
      },
      {
        method: "HEAD",
        response: () =>
          new Response(null, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      },
    ];

    for (const entry of cases) {
      serve(entry.response);

      const page = await send(h.port, {
        host: OWNER_HOST,
        path: PREVIEW_PATH,
        method: entry.method,
        forwardedFor: nextVisitorIp(),
      });

      const label = `${entry.method} ${page.status}`;

      expect(
        policies(page.headers["content-security-policy"]),
        label,
      ).toContain(RELAY_SANDBOX);
      expect(page.headers["clear-site-data"], label).toBeUndefined();
    }
  });
});

describe("installer responses", () => {
  it("are plain text or an attachment with nosniff and a bare sandbox, whatever the origin sends", async () => {
    serve(() => {
      const headers = new Headers();
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("content-disposition", 'inline; filename="x.html"');
      headers.append("content-security-policy", "default-src *");
      headers.append("content-security-policy", "script-src 'unsafe-inline'");
      headers.set("x-content-type-options", "none");
      headers.set("clear-site-data", '"cookies"');

      return new Response("<script>alert(document.domain)</script>", {
        status: 200,
        headers,
      });
    });

    for (const path of [
      "/install.sh",
      "/install.ps1",
      "/install/version",
      "/m/ABCD-1234",
      "/m/ABCD-1234.ps1",
    ]) {
      const page = await send(h.port, {
        host: OWNER_HOST,
        path: `${path}?a=1`,
        headers: { accept: "text/html" },
        forwardedFor: nextVisitorIp(),
      });

      expect(page.status, path).toBe(200);
      expect(page.headers["content-type"], path).toBe(
        "text/plain; charset=utf-8",
      );
      expect(page.headers["x-content-type-options"], path).toBe("nosniff");
      expect(page.headers["content-security-policy"], path).toBe("sandbox");
      expect(page.headers["content-disposition"], path).toBeUndefined();
      expect(page.headers["clear-site-data"], path).toBeUndefined();
    }

    const tarball = await send(h.port, {
      host: OWNER_HOST,
      path: "/install/omnyo-app.tgz?name=x.html",
      headers: { accept: "text/html" },
      forwardedFor: nextVisitorIp(),
    });

    expect(tarball.headers["content-type"]).toBe("application/octet-stream");
    expect(tarball.headers["content-disposition"]).toBe(
      'attachment; filename="omnyo-app.tgz"',
    );
    expect(tarball.headers["content-security-policy"]).toBe("sandbox");

    for (const path of [
      "/install.sh/",
      "/INSTALL.SH",
      "//install.sh",
      "/m/ABCD-1234/",
      "/m/ABCD-1234.sh",
    ]) {
      const other = await send(h.port, {
        host: OWNER_HOST,
        path,
        headers: { accept: "text/html" },
        forwardedFor: nextVisitorIp(),
      });

      expect(other.status, path).not.toBe(200);
    }
  });
});

describe("well-known files on user addresses", () => {
  it("never serves an owner's well-known files to an anonymous client", async () => {
    serve(
      () =>
        new Response("Contact: mailto:attacker@evil.example\n", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );

    for (const host of [
      OWNER_HOST,
      PORT_SHARE_HOST,
      "sawyerphone.relay.test",
    ]) {
      for (const path of [
        "/.well-known/security.txt",
        "/security.txt",
        "/.well-known/apple-app-site-association",
        "/.well-known/assetlinks.json",
        "/.well-known/openid-configuration",
        "/.well-known/change-password",
        "/.well-known/acme-challenge/token",
        "/robots.txt",
      ]) {
        for (const accept of ["*/*", "text/html", "application/json"]) {
          const response = await send(h.port, {
            host,
            path,
            headers: { accept },
          });

          expect(response.body, `${host}${path} ${accept}`).not.toContain(
            "attacker@evil.example",
          );
        }
      }
    }

    expect(h.tunnels.httpRequests).toHaveLength(0);
  });

  it("sends reserved infrastructure names to the apex file", async () => {
    for (const host of [
      "www.relay.test",
      "api.relay.test",
      "auth.relay.test",
      "mail.relay.test",
    ]) {
      const response = await send(h.port, {
        host,
        path: "/.well-known/security.txt",
      });

      expect(response.status, host).toBe(301);
      expect(response.headers.location, host).toBe(
        `${APP_URL}/.well-known/security.txt`,
      );
    }
  });
});

describe("the relay's own plain-text refusals", () => {
  it("cannot be rendered as a page at an address nobody holds", async () => {
    for (const path of ["/", "/login", "/install.sh", PREVIEW_PATH]) {
      const response = await send(h.port, {
        host: "githab-login.relay.test",
        path,
        headers: { accept: "text/html" },
      });

      expect(response.status, path).toBe(404);
      expect(response.headers["content-type"], path).toContain("text/plain");
      expect(
        policies(response.headers["content-security-policy"]),
        path,
      ).toEqual(["sandbox; default-src 'none'"]);
      expect(response.headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  it("are sandboxed when a credential is refused", async () => {
    const response = await send(h.port, {
      host: OWNER_HOST,
      path: "/internal/ping",
      headers: { "x-omnyo-connect-machine": "not-a-credential" },
    });

    expect(response.status).toBe(403);
    expect(response.headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'",
    );
  });
});

describe("obsolete cookie headers", () => {
  it.each(["/install.sh", "/install/version"])(
    "never reaches a visitor of %s from the origin",
    async (path) => {
      serve(
        () =>
          new Response("ok", {
            headers: [
              ["set-cookie", "a=1; Path=/"],
              ["set-cookie2", "b=1; Version=1"],
            ],
          }),
      );

      const response = await send(h.port, {
        host: "sawyer.relay.test",
        path,
        forwardedFor: nextVisitorIp(),
      });

      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["set-cookie2"]).toBeUndefined();
    },
  );
});
