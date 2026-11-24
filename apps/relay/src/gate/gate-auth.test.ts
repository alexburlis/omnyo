import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, machine } from "@omnyo/connect-db";
import { eq } from "drizzle-orm";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import {
  GATE_COOKIE,
  NONCE_COOKIE,
  SECURE_DESKTOP_SESSION_COOKIE,
} from "./cookies.js";
import {
  APP_URL,
  type Harness,
  SESSION_COOKIE,
  type TestUser,
  cookiePair,
  cookieValue,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { issueGateCookie } from "./gate-cookie.js";
import { mintGateCode } from "./handshake.js";
import { validateReturn } from "./return-url.js";
import {
  DESKTOP_KEY_LABEL,
  GATE_KEY_LABEL,
  derivePurposeKey,
  signToken,
} from "./signed-token.js";

const ALICE_HOST = "alice.relay.test";

const HTML = { accept: "text/html,application/xhtml+xml" };

let h: Harness;

let alice: TestUser;

let bob: TestUser;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  h = await startHarness();
  alice = h.addUser("alice");
  bob = h.addUser("bob");
  h.addServer(alice.id, "alice");
  h.addServer(bob.id, "bob");
  h.tunnels.connect("alice");
});

afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  await h.close();
});

function sessionCookie(member: TestUser): string {
  return `${SESSION_COOKIE}=${member.sessionToken}`;
}

async function startAt(path: string, host = ALICE_HOST) {
  const response = await send(h.port, { host, path, headers: HTML });
  const location = new URL(response.headers.location ?? "");
  const nonce = cookieValue(response.setCookies, NONCE_COOKIE);

  return { response, location, nonce };
}

async function authorizeAs(member: TestUser, authorize: URL) {
  return send(h.port, {
    host: authorize.host,
    path: `${authorize.pathname}${authorize.search}`,
    headers: {
      ...HTML,
      cookie: sessionCookie(member),
      "sec-fetch-site": "same-site",
    },
  });
}

async function signIn(
  member: TestUser,
  host = ALICE_HOST,
  path = "/",
): Promise<string> {
  const start = await startAt(path, host);
  const authorized = await authorizeAs(member, start.location);
  const callback = new URL(authorized.headers.location ?? "");

  const finished = await send(h.port, {
    host,
    path: `${callback.pathname}${callback.search}`,
    headers: { ...HTML, cookie: `${NONCE_COOKIE}=${start.nonce ?? ""}` },
  });

  const gate = finished.setCookies.find((cookie) =>
    cookie.startsWith(`${GATE_COOKIE}=`),
  );

  if (gate === undefined)
    throw new Error(`handshake failed with ${finished.status}`);

  return cookiePair(gate);
}

describe("visitor handshake", () => {
  it("redirects an HTML request without a cookie to /relay/authorize and sets a host-only nonce", async () => {
    const { response, location, nonce } = await startAt("/projects?tab=1");

    expect(response.status).toBe(302);
    expect(location.origin).toBe(APP_URL);
    expect(location.pathname).toBe("/relay/authorize");
    expect(location.searchParams.get("host")).toBe(ALICE_HOST);
    expect(location.searchParams.get("return")).toBe("/projects?tab=1");
    expect(location.searchParams.get("n")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const attributes = response.setCookies[0] ?? "";
    expect(attributes).toMatch(/; Path=\//u);
    expect(attributes).toMatch(/; Secure/u);
    expect(attributes).toMatch(/; HttpOnly/u);
    expect(attributes).toMatch(/; SameSite=Lax/u);
    expect(attributes).toMatch(/; Max-Age=600/u);
    expect(attributes).not.toMatch(/domain=/iu);
  });

  it("answers non-HTML requests without a cookie with 401 and the reauth header", async () => {
    const response = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { accept: "application/json" },
    });

    expect(response.status).toBe(401);
    expect(response.headers["x-omnyo-gate-reauth"]).toBe("1");
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });

  it("lets the owner complete the handshake and reach the origin as a session", async () => {
    const start = await startAt("/projects?tab=1");
    const authorized = await authorizeAs(alice, start.location);
    const callback = new URL(authorized.headers.location ?? "");

    expect(authorized.status).toBe(302);
    expect(callback.origin).toBe(`https://${ALICE_HOST}`);
    expect(callback.pathname).toBe("/__omnyo/callback");
    expect(callback.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const finished = await send(h.port, {
      host: ALICE_HOST,
      path: `${callback.pathname}${callback.search}`,
      headers: { ...HTML, cookie: `${NONCE_COOKIE}=${start.nonce ?? ""}` },
    });

    expect(finished.status).toBe(302);
    expect(finished.headers.location).toBe(
      `https://${ALICE_HOST}/projects?tab=1`,
    );

    const gate =
      finished.setCookies.find((cookie) =>
        cookie.startsWith(`${GATE_COOKIE}=`),
      ) ?? "";

    expect(gate).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax/u);
    expect(gate).not.toMatch(/domain=/iu);
    expect(
      finished.setCookies.some(
        (cookie) =>
          cookie.startsWith(`${NONCE_COOKIE}=;`) &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);

    const page = await send(h.port, {
      host: ALICE_HOST,
      path: "/projects?tab=1",
      headers: { ...HTML, cookie: cookiePair(gate) },
    });

    expect(page.status).toBe(200);

    const echoed = JSON.parse(page.body) as {
      path: string;
      headers: Record<string, string>;
      grant: string;
    };

    expect(echoed.path).toBe("/projects?tab=1");
    expect(echoed.grant).toBe("session");
    expect(echoed.headers["x-omnyo-gate-auth"]).toBe("session");
    expect(echoed.headers["x-omnyo-gate-machine-id"]).toBeUndefined();
  });

  it("refuses a second user at the apex and at the gate", async () => {
    const start = await startAt("/");
    const authorized = await authorizeAs(bob, start.location);

    expect(authorized.status).toBe(403);
    expect(authorized.body).toContain("isn't your server");

    const key = derivePurposeKey(h.config.betterAuthSecret, GATE_KEY_LABEL);

    const forged = issueGateCookie(
      key,
      {
        userId: bob.id,
        host: ALICE_HOST,
        sessionId: bob.sessionId,
        sessionExpiresAt: h.clock.now() + 3_600_000,
      },
      h.clock.now(),
    );

    const page = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      headers: { ...HTML, cookie: cookiePair(forged.setCookie) },
    });

    expect(page.status).toBe(403);
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });

  it("rejects reused, expired, foreign-host and nonce-less codes", async () => {
    const start = await startAt("/");
    const authorized = await authorizeAs(alice, start.location);
    const callback = new URL(authorized.headers.location ?? "");
    const path = `${callback.pathname}${callback.search}`;
    const nonceCookie = `${NONCE_COOKIE}=${start.nonce ?? ""}`;

    const withoutNonce = await send(h.port, {
      host: ALICE_HOST,
      path,
      headers: HTML,
    });

    expect(withoutNonce.status).toBe(403);

    const reused = await send(h.port, {
      host: ALICE_HOST,
      path,
      headers: { ...HTML, cookie: nonceCookie },
    });

    expect(reused.status).toBe(400);

    const second = await authorizeAs(alice, start.location);
    const secondCallback = new URL(second.headers.location ?? "");

    const wrongNonce = await send(h.port, {
      host: ALICE_HOST,
      path: `${secondCallback.pathname}${secondCallback.search}`,
      headers: { ...HTML, cookie: `${NONCE_COOKIE}=${"A".repeat(43)}` },
    });

    expect(wrongNonce.status).toBe(403);

    const third = await authorizeAs(alice, start.location);
    const thirdCallback = new URL(third.headers.location ?? "");
    h.clock.advance(61_000);

    const expired = await send(h.port, {
      host: ALICE_HOST,
      path: `${thirdCallback.pathname}${thirdCallback.search}`,
      headers: { ...HTML, cookie: nonceCookie },
    });

    expect(expired.status).toBe(400);

    h.addServer(alice.id, "alice-lab");

    const foreign = mintGateCode(
      h.database.db,
      {
        userId: alice.id,
        host: "alice-lab.relay.test",
        sessionId: alice.sessionId,
        return: "/",
        n: start.location.searchParams.get("n") ?? "",
      },
      h.clock.now(),
    );

    const misplaced = await send(h.port, {
      host: ALICE_HOST,
      path: `/__omnyo/callback?code=${foreign}`,
      headers: { ...HTML, cookie: nonceCookie },
    });

    expect(misplaced.status).toBe(403);
    expect(
      misplaced.setCookies.some((cookie) =>
        cookie.startsWith(`${GATE_COOKIE}=`),
      ),
    ).toBe(false);
  });

  it("rejects open-redirect return values at the apex and at the gate", async () => {
    const hostile = [
      "//evil.test",
      "/\\evil.test",
      "/%09/evil.test",
      "/%09%5Cevil.test",
      "https://evil.test",
    ];

    const origin = `https://${ALICE_HOST}`;

    for (const value of hostile)
      expect(validateReturn(value, origin)).toBeNull();
    expect(validateReturn("/projects?q=a%2Fb", origin)).toBe(
      "/projects?q=a%2Fb",
    );
    expect(validateReturn("/projects?q=a%20b", origin)).toBeNull();

    const { location } = await startAt("/");

    for (const value of hostile) {
      const authorize = new URL(location);
      authorize.searchParams.set("return", value);
      const response = await authorizeAs(alice, authorize);
      expect(response.status, value).toBe(400);
    }

    for (const value of hostile.slice(0, 4)) {
      const response = await send(h.port, {
        host: ALICE_HOST,
        path: value,
        headers: HTML,
      });

      expect(response.status, value).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("ignores tossed platform session cookies on a tenant host", async () => {
    const tossed = [
      `${SESSION_COOKIE}=${alice.sessionToken}`,
      `__Secure-__Host-omnyo.session_token=${alice.sessionToken}`,
      `better-auth.session_token=${alice.sessionToken}`,
      `__Secure-better-auth.session_token=${alice.sessionToken}`,
    ];

    for (const cookie of tossed) {
      const response = await send(h.port, {
        host: ALICE_HOST,
        path: "/",
        headers: { ...HTML, cookie },
      });

      expect(response.status, cookie).toBe(302);
      expect(response.headers.location).toContain("/relay/authorize");
    }

    const { location } = await startAt("/");

    const viaTossedName = await send(h.port, {
      host: location.host,
      path: `${location.pathname}${location.search}`,
      headers: {
        ...HTML,
        cookie: `__Secure-__Host-omnyo.session_token=${alice.sessionToken}`,
      },
    });

    expect(viaTossedName.status).toBe(302);
    expect(viaTossedName.headers.location).toContain("/sign-in");
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });
});

describe("same-origin and framing", () => {
  it("refuses same-site cross-origin mutations and framing, and allows same-origin requests", async () => {
    const cookie = await signIn(alice);

    const crossPost = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      method: "POST",
      body: "{}",
      headers: {
        cookie,
        origin: "https://mallory.relay.test",
        "sec-fetch-site": "same-site",
        "content-type": "application/json",
      },
    });

    expect(crossPost.status).toBe(403);

    const framed = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      headers: {
        ...HTML,
        cookie,
        "sec-fetch-site": "same-site",
        "sec-fetch-dest": "iframe",
      },
    });

    expect(framed.status).toBe(403);

    const foreignOrigin = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie, origin: "https://bob.relay.test" },
    });

    expect(foreignOrigin.status).toBe(403);
    expect(h.tunnels.httpRequests).toHaveLength(0);

    const samePost = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      method: "POST",
      body: '{"title":"x"}',
      headers: {
        cookie,
        origin: `https://${ALICE_HOST}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });

    expect(samePost.status).toBe(200);
    expect((JSON.parse(samePost.body) as { body: string }).body).toBe(
      '{"title":"x"}',
    );

    const bare = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      method: "POST",
      body: "{}",
      headers: { cookie },
    });

    expect(bare.status).toBe(200);
  });

  it("refuses a WebSocket with a foreign Origin and allows one without Origin", async () => {
    const cookie = await signIn(alice);

    const foreign = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/realtime",
      headers: { cookie, origin: "https://mallory.relay.test" },
    });

    expect(foreign.kind).toBe("refused");
    expect(foreign.status).toBe(403);

    const native = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/realtime",
      headers: { cookie },
    });

    expect(native.kind).toBe("open");

    const echoed = await new Promise<string>((resolve) => {
      native.socket?.once("message", (data) => resolve(String(data)));
      native.socket?.send("ping");
    });

    expect(echoed).toBe("ping");
    expect(h.tunnels.wsRequests[0]?.headers).toContainEqual([
      "x-omnyo-gate-auth",
      "session",
    ]);
    native.socket?.close();

    const sameOrigin = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/realtime",
      headers: { cookie, origin: `https://${ALICE_HOST}` },
    });

    expect(sameOrigin.kind).toBe("open");
    sameOrigin.socket?.close();
  });

  it("adds framing headers to cookie-authenticated responses and strips Clear-Site-Data", async () => {
    const cookie = await signIn(alice);

    h.tunnels.origin = () =>
      new Response("<p>hi</p>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "script-src 'self'",
          "clear-site-data": '"cookies"',
        },
      });

    const page = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      headers: { ...HTML, cookie },
    });

    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self'",
    );
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(page.headers["clear-site-data"]).toBeUndefined();
  });
});

describe("tenant-host account routes", () => {
  it("answers on the tenant host with bearer credentials only and never forwards", async () => {
    const paired = h.addServer(alice.id, "alice-box");
    const cookie = await signIn(alice);

    const routes: Array<[string, string]> = [
      ["GET", "/api/connect/servers"],
      ["POST", "/api/connect/disconnect"],
      ["POST", "/api/connect/desktop-session"],
      ["POST", "/api/connect/machine-label"],
    ];

    for (const [method, path] of routes) {
      const viaCookie = await send(h.port, {
        host: ALICE_HOST,
        path,
        method,
        body: method === "POST" ? '{"desiredName":"x"}' : undefined,
        headers: {
          cookie,
          origin: `https://${ALICE_HOST}`,
          "sec-fetch-site": "same-origin",
        },
      });

      expect(viaCookie.status, path).toBe(401);
    }

    const servers = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/servers",
      headers: { "x-omnyo-connect-machine": paired.credential },
    });

    expect(servers.status).toBe(200);
    expect(
      (
        JSON.parse(servers.body) as {
          servers: Array<{ handle: string; live: boolean }>;
        }
      ).servers,
    ).toEqual(
      expect.arrayContaining([
        { handle: "alice-box", name: "alice-box", live: false },
      ]),
    );

    const desktop = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/desktop-session",
      method: "POST",
      headers: { "x-omnyo-connect-machine": paired.credential },
    });

    expect(desktop.status).toBe(200);

    const issued = (
      JSON.parse(desktop.body) as { cookie: { domain: string; name: string } }
    ).cookie;

    expect(issued.domain).toBe(".relay.test");
    expect(issued.name).toBe(SECURE_DESKTOP_SESSION_COOKIE);
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });

  it("forwards a machine-grant desktop cookie as machine with its ID and refuses a server grant at another server", async () => {
    const phone = h.addMachine(alice.id, null);
    const paired = h.addServer(alice.id, "alice-box");

    const issue = async (credential: string) => {
      const response = await send(h.port, {
        host: ALICE_HOST,
        path: "/api/connect/desktop-session",
        method: "POST",
        headers: { "x-omnyo-connect-machine": credential },
      });

      const cookie = (
        JSON.parse(response.body) as { cookie: { name: string; value: string } }
      ).cookie;

      return `${cookie.name}=${cookie.value}`;
    };

    const viaPhone = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie: await issue(phone.credential) },
    });

    const phoneHeaders = (
      JSON.parse(viaPhone.body) as { headers: Record<string, string> }
    ).headers;

    expect(viaPhone.status).toBe(200);
    expect(phoneHeaders["x-omnyo-gate-auth"]).toBe("machine");
    expect(phoneHeaders["x-omnyo-gate-machine-id"]).toBe(phone.id);
    expect(phoneHeaders.cookie).toBeUndefined();
    const firstSeen = h.clock.now();
    expect(
      h.database.db
        .select()
        .from(machine)
        .where(eq(machine.id, phone.id))
        .get()
        ?.lastSeenAt?.getTime(),
    ).toBe(firstSeen);

    h.clock.advance(30_000);
    const phoneCookie = await issue(phone.credential);
    await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie: phoneCookie },
    });
    expect(
      h.database.db
        .select()
        .from(machine)
        .where(eq(machine.id, phone.id))
        .get()
        ?.lastSeenAt?.getTime(),
    ).toBe(firstSeen);

    h.clock.advance(30_000);
    await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie: phoneCookie },
    });
    expect(
      h.database.db
        .select()
        .from(machine)
        .where(eq(machine.id, phone.id))
        .get()
        ?.lastSeenAt?.getTime(),
    ).toBe(h.clock.now());

    const viaServer = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie: await issue(paired.credential) },
    });

    expect(viaServer.status).toBe(401);
  });

  it("refuses a gate cookie presented as a desktop cookie, and the reverse", async () => {
    const gate = await signIn(alice);
    const gateValue = gate.slice(GATE_COOKIE.length + 1);

    const asDesktop = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/x",
      headers: { cookie: `${SECURE_DESKTOP_SESSION_COOKIE}=${gateValue}` },
    });

    expect(asDesktop.status).toBe(401);

    const phone = h.addMachine(alice.id, null);

    const desktop = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/desktop-session",
      method: "POST",
      headers: { "x-omnyo-connect-machine": phone.credential },
    });

    const desktopValue = (
      JSON.parse(desktop.body) as { cookie: { value: string } }
    ).cookie.value;

    const asGate = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/x",
      headers: { cookie: `${GATE_COOKIE}=${desktopValue}` },
    });

    expect(asGate.status).toBe(401);

    const desktopKey = derivePurposeKey(
      h.config.betterAuthSecret,
      DESKTOP_KEY_LABEL,
    );

    const typed = signToken(desktopKey, {
      typ: "gate",
      userId: alice.id,
      host: ALICE_HOST,
      grant: { kind: "session", sessionId: alice.sessionId },
      iat: h.clock.now(),
      exp: h.clock.now() + 60_000,
    });

    const wrongTyp = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/x",
      headers: { cookie: `${SECURE_DESKTOP_SESSION_COOKIE}=${typed}` },
    });

    expect(wrongTyp.status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });
});

describe("previews, installers and cookie hygiene", () => {
  it("passes GET on the preview capability path without a cookie and requires one for POST", async () => {
    h.tunnels.origin = (request) =>
      new Response(
        request.path.includes("wrong-cap") ? "no such preview" : "ok",
        {
          status: request.path.includes("wrong-cap") ? 404 : 200,
        },
      );

    const wrong = await send(h.port, {
      host: ALICE_HOST,
      path: "/preview-content/p1/wrong-cap/index.html",
      headers: { origin: "null" },
    });

    expect(wrong.status).toBe(404);
    expect(wrong.body).toBe("no such preview");
    expect(h.tunnels.httpRequests[0]?.grant).toEqual({ kind: "anonymous" });
    expect(
      h.tunnels.httpRequests[0]?.headers.some(
        ([name, value]) =>
          name === "x-omnyo-gate-auth" && value === "anonymous",
      ),
    ).toBe(true);

    const post = await send(h.port, {
      host: ALICE_HOST,
      path: "/preview-content/p1/cap/form",
      method: "POST",
      body: "x",
      headers: { origin: "null" },
    });

    expect(post.status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(1);
  });

  it("keeps platform cookies from the origin and drops unsafe tenant Set-Cookie headers", async () => {
    const gate = await signIn(alice);

    const tenantSetCookies = [
      "theme=dark; Path=/",
      "wide=1; Domain=relay.test; Path=/",
      `${GATE_COOKIE}=forged; Path=/; Secure`,
      "__Host-omnyo.session_token=forged; Path=/; Secure",
      "__Secure-omnyo.x=1; Path=/; Secure",
      "better-auth.session_token=forged; Path=/",
    ];

    h.tunnels.origin = async (request) => {
      const headers = new Headers({
        "x-cookie-seen": Object.fromEntries(request.headers).cookie ?? "",
      });

      for (const cookie of tenantSetCookies)
        headers.append("set-cookie", cookie);

      return new Response("ok", { headers });
    };

    const cookie = [
      gate,
      `${NONCE_COOKIE}=n`,
      `${SESSION_COOKIE}=s`,
      "__Secure-omnyo.other=1",
      "__Secure-__Host-omnyo.session_token=t",
      "better-auth.session_token=b",
      `${SECURE_DESKTOP_SESSION_COOKIE}=d`,
      "theme=light",
    ].join("; ");

    const page = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      headers: { ...HTML, cookie },
    });

    expect(page.headers["x-cookie-seen"]).toBe("theme=light");
    expect(page.setCookies).toEqual(["theme=dark; Path=/"]);
  });

  it("throttles the 31st installer download per IP without touching the owner's egress", async () => {
    h.tunnels.origin = () =>
      new Response("#!/bin/sh\necho install\n", { headers: { etag: '"v1"' } });
    const before = h.deps.egress.usage(alice.id).bytes;
    const statuses: number[] = [];

    for (
      let index = 0;
      index < RELAY_RATE_LIMITS.installerPerIp.limit + 1;
      index += 1
    ) {
      statuses.push(
        (
          await send(h.port, {
            host: ALICE_HOST,
            path: "/install.sh",
            forwardedFor: `10.9.9.${index}, 203.0.113.50`,
          })
        ).status,
      );
    }

    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(h.deps.egress.usage(alice.id).bytes).toBe(before);

    h.tunnels.origin = () =>
      new Response(null, { status: 304, headers: { etag: '"v1"' } });

    const cached = await send(h.port, {
      host: ALICE_HOST,
      path: "/install.sh",
      headers: { "if-none-match": '"v1"' },
      forwardedFor: "203.0.113.51",
    });

    expect(cached.status).toBe(304);
    expect(h.tunnels.httpRequests.at(-1)?.headers).toContainEqual([
      "if-none-match",
      '"v1"',
    ]);
  });

  it("counts proxied traffic in both directions towards the owner's egress", async () => {
    const cookie = await signIn(alice);
    h.tunnels.origin = async (request) =>
      new Response(`${await new Response(request.body).text()}!`);

    await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/echo",
      method: "POST",
      body: "x".repeat(1000),
      headers: { cookie },
    });

    expect(h.deps.egress.usage(alice.id).bytes).toBe(2001);
  });
});

describe("client IP, limits and hosts", () => {
  it("keys limits and audit rows on the derived address, not on forged headers", async () => {
    const forged = (index: number) => ({
      forwardedFor: `6.6.6.${index}, 203.0.113.77`,
      headers: {
        ...HTML,
        "x-real-ip": `7.7.7.${index}`,
        "cf-connecting-ip": `8.8.8.${index}`,
        "x-omnyo-client-ip": `9.9.9.${index}`,
      },
    });

    const cookie = await signIn(alice, ALICE_HOST, "/");
    h.tunnels.origin = (request) =>
      Response.json(Object.fromEntries(request.headers));

    const seen = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      ...forged(1),
      headers: { ...forged(1).headers, cookie },
    });

    const originHeaders = JSON.parse(seen.body) as Record<string, string>;
    expect(originHeaders["x-omnyo-client-ip"]).toBe("203.0.113.77");
    expect(originHeaders["x-real-ip"]).toBeUndefined();
    expect(originHeaders["cf-connecting-ip"]).toBeUndefined();
    expect(originHeaders["x-forwarded-for"]).toBeUndefined();

    for (
      let index = 0;
      index <= RELAY_RATE_LIMITS.failedBearer.limit;
      index += 1
    ) {
      await send(h.port, {
        host: ALICE_HOST,
        path: "/api/connect/servers",
        ...forged(index),
        headers: {
          ...forged(index).headers,
          "x-omnyo-connect-machine": "wrong",
        },
      });
    }

    const blocked = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/servers",
      ...forged(99),
      headers: { ...forged(99).headers, "x-omnyo-connect-machine": "wrong" },
    });

    expect(blocked.status).toBe(429);

    const other = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/servers",
      forwardedFor: "203.0.113.78",
      headers: { "x-omnyo-connect-machine": "wrong" },
    });

    expect(other.status).toBe(401);

    const audit = h.database.db
      .select({ ip: auditLog.ipAddress })
      .from(auditLog)
      .all();

    expect(new Set(audit.map((row) => row.ip))).toEqual(
      new Set(["203.0.113.77", "203.0.113.78"]),
    );
  });

  it("answers a throttled /__tunnel dial with 429", async () => {
    const paired = h.addServer(alice.id, "alice-box");
    const statuses: number[] = [];

    for (
      let index = 0;
      index <= RELAY_RATE_LIMITS.tunnelDialPerLabel.limit;
      index += 1
    ) {
      const dial = await openWs(h.port, {
        host: "alice-box.relay.test",
        path: "/__tunnel?v=1",
        headers: { authorization: `Bearer ${paired.credential}` },
      });

      statuses.push(dial.status);
      dial.socket?.terminate();
    }

    expect(statuses.slice(0, 12).every((status) => status === 101)).toBe(true);
    expect(statuses[12]).toBe(429);
    expect(h.tunnels.attachments[0]).toMatchObject({
      routingKey: "alice-box",
      owner: { kind: "server", serverId: paired.id },
      protocolVersion: 1,
    });

    const wrong = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/__tunnel?v=1",
      headers: { authorization: "Bearer wrong" },
    });

    expect(wrong.status).toBe(401);
  });

  it("answers 421 for hosts that are neither the apex nor a tenant, and serves healthcheck", async () => {
    for (const host of [
      "evil.test",
      "a.b.relay.test",
      "stg.relay.test",
      "x.stg.relay.test",
      "relay.test.evil.test",
      "alice.relay.test:444",
    ]) {
      const response = await send(h.port, { host, path: "/" });
      expect(response.status, host).toBe(421);
    }

    expect(
      (await send(h.port, { host: "healthcheck.relay.test", path: "/" }))
        .status,
    ).toBe(200);

    const reserved = await send(h.port, {
      host: "www.relay.test",
      path: "/dashboard?x=1",
    });

    expect(reserved.status).toBe(301);
    expect(reserved.headers.location).toBe(`${APP_URL}/dashboard?x=1`);
  });

  it("logs metadata only: no cookies, credentials, codes or tenant paths", async () => {
    const paired = h.addServer(alice.id, "alice-box");

    const cookie = await signIn(
      alice,
      ALICE_HOST,
      "/very/private/project?token=abc",
    );

    await send(h.port, {
      host: ALICE_HOST,
      path: "/very/private/project?token=abc",
      headers: { ...HTML, cookie },
    });
    await send(h.port, {
      host: ALICE_HOST,
      path: "/preview-content/id9/secretcap/app.js",
    });
    await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/servers",
      headers: { "x-omnyo-connect-machine": paired.credential },
    });

    const logged = JSON.stringify(h.logs);

    const values = [
      cookie.slice(GATE_COOKIE.length + 1),
      alice.sessionToken,
      paired.credential,
      "/very/private",
      "token=abc",
      "secretcap",
      "code=",
    ];

    for (const value of values) expect(logged).not.toContain(value);
    expect(
      h.logs.some(
        (record) =>
          record.event === "gate.stream" && record.fields.route === "proxy",
      ),
    ).toBe(true);
  });
});
