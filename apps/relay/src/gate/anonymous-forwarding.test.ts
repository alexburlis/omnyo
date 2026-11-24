import { connect } from "node:net";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { SmartRouter } from "hono/router/smart-router";
import { TrieRouter } from "hono/router/trie-router";
import { getPath } from "hono/utils/url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TunnelHttpRequest } from "../contracts.js";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import {
  GATE_COOKIE,
  LEGACY_SECURE_DESKTOP_SESSION_COOKIE,
  NONCE_COOKIE,
  SECURE_DESKTOP_SESSION_COOKIE,
} from "./cookies.js";
import { INSTALLER_PATHS, isInstallerPath } from "./gate.js";
import { issueGateCookie } from "./gate-cookie.js";
import {
  type Harness,
  cookiePair,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import {
  GATE_AUTH_HEADER,
  GATE_CONTROLLED_HEADERS,
  GATE_MACHINE_ID_HEADER,
  MACHINE_CREDENTIAL_HEADER,
} from "./protocol-headers.js";
import { GATE_KEY_LABEL, derivePurposeKey } from "./signed-token.js";

const OWNER_HOST = "sawyer.relay.test";

const PREVIEW_PATH = /^\/preview-content\/[^/]+\/[^/]+(?:\/.*)?$/u;

const VISITOR_FORWARDING_HEADERS: Record<string, string> = {
  forwarded: "for=6.6.6.6;host=evil.example;proto=http",
  "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "http",
  "x-forwarded-port": "80",
  "x-forwarded-prefix": "/evil",
  "x-real-ip": "7.7.7.7",
  "true-client-ip": "8.8.8.8",
  "cf-connecting-ip": "9.9.9.9",
};

const CLASSIFIED_PATHS = [
  "/preview-content/a/b/../../api/v1/hosts",
  "/preview-content/a/b/%2e%2e/%2e%2e/api/v1/hosts",
  "/preview-content/a/b/%2E%2E/%2E%2E/api/v1/hosts",
  "/preview-content/a/b/.%2e/.%2e/api/v1/hosts",
  "/preview-content/a/b/..;/..;/api/v1/hosts",
  "/preview-content/a/b%2F..%2F..%2Fapi%2Fv1%2Fhosts",
  "/preview-content/a/b/%252e%252e/%252e%252e/api/v1/hosts",
  "/preview-content//a/api/v1/hosts",
  "/preview-content/a",
  "/Preview-Content/a/b/c",
  "/install.sh/../api/v1/hosts",
  "/install.sh/",
  "/install.sh;x",
  "/install.sh%2F..%2Fapi",
  "/INSTALL.SH",
  "/install/version/../../api/v1/hosts",
  "/install/%2e%2e/api/v1/hosts",
  "/install.sh?x=/../api/v1",
  "/install.sh.",
  "/m/ABCD-1234/../../api/v1/hosts",
  "/m/ABCD-1234%2F..%2F..%2Fapi",
  "/m/%2e%2e/api/v1/hosts",
  "/m/",
  "/m/ABCD-1234/",
  "/m/ABCD-1234.ps1/x",
  "/m/ABCD-1234.sh",
  "/M/ABCD-1234",
];

const RAW_TARGETS = [
  "/preview-content\\a\\b\\..\\..\\api\\v1\\hosts",
  "/preview-content/a/b#/../../api/v1/hosts",
  "http://sawyer.relay.test/preview-content/a/b/../../api/v1/hosts",
  "https://sawyer.relay.test/api/v1/hosts",
  "http://other.relay.test/install.sh",
];

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  const owner = h.addUser("sawyer");
  h.addServer(owner.id, "sawyer");
  h.tunnels.connect("sawyer");
});

afterEach(async () => {
  await h.close();
});

function rawRequest(head: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(h.port, "127.0.0.1");
    socket.on("data", () => socket.destroy());
    socket.on("error", reject);
    socket.on("close", () => resolve());
    socket.write(head);
  });
}

function anonymousForwards(): TunnelHttpRequest[] {
  return h.tunnels.httpRequests.filter(
    (request) => request.grant.kind === "anonymous",
  );
}

function inAnonymousSet(forwarded: TunnelHttpRequest): boolean {
  const pathname = new URL(forwarded.path, "http://upstream.test").pathname;

  return isInstallerPath(pathname) || PREVIEW_PATH.test(pathname);
}

function upstreamRouter(): SmartRouter<string> {
  const router = new SmartRouter<string>({
    routers: [new RegExpRouter(), new TrieRouter()],
  });

  const all = (path: string, handler: string) => {
    for (const method of ["GET", "HEAD", "POST"])
      router.add(method, path, handler);
  };

  for (const path of INSTALLER_PATHS) router.add("GET", path, "installer");
  router.add("GET", "/m/:code", "installer");
  router.add("GET", "/install/*", "install-410");
  all("/api/v1/*", "privileged");
  all("/internal/*", "privileged");
  all("/private-updates/:channel/:platform/:file", "privileged");
  router.add("POST", "/preview/:id/access", "privileged");
  router.add("GET", "/preview/:id", "privileged");
  router.add("GET", "/preview/:id/*", "privileged");
  all("/preview-content/:id/:cap/*", "preview");
  router.add("GET", "*", "static-shell");

  return router;
}

function firstHandler(
  router: SmartRouter<string>,
  method: string,
  path: string,
): string {
  const matched = router.match(method === "HEAD" ? "GET" : method, path);
  const handlers = matched[0] as unknown as Array<[string, unknown]>;

  return handlers[0]?.[0] ?? "not-found";
}

describe("anonymous path classification", () => {
  it("applies the existing anonymous request limit before forwarding a Sentry webhook", async () => {
    const request = {
      host: OWNER_HOST,
      path: "/api/v1/plugins/sentry/http/webhook",
      method: "POST",
    };

    expect((await send(h.port, request)).status).toBe(200);

    for (let index = 1; index < RELAY_RATE_LIMITS.previewPerIp.limit; index++)
      await h.deps.rateLimits.previewPerIp.limit({ key: "198.51.100.7" });

    const blocked = await send(h.port, request);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(anonymousForwards()).toHaveLength(1);
  });

  it("forwards the exact Sentry webhook POST without granting other anonymous access", async () => {
    const path = "/api/v1/plugins/sentry/http/webhook";
    const body = '{ "action": "created", "data": {"issue": {"id": "42"}} }\n';
    const signature = "a".repeat(64);

    const response = await send(h.port, {
      host: OWNER_HOST,
      path,
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "sentry-hook-signature": signature,
        "sentry-hook-resource": "issue",
        "request-id": "delivery-42",
        "x-omnyo-gate-auth": "session",
      },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      method: "POST",
      path,
      grant: "anonymous",
      body,
      headers: {
        "sentry-hook-signature": signature,
        "sentry-hook-resource": "issue",
        "request-id": "delivery-42",
        "x-omnyo-gate-auth": "anonymous",
      },
    });

    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(
        (await send(h.port, { host: OWNER_HOST, path, method })).status,
      ).toBe(401);

    for (const other of [
      `${path}/`,
      `${path}/more`,
      `${path}.json`,
      "/api/v1/plugins/other/http/webhook",
      "/api/v1/plugins/sentry/http/status",
      "/api/v1/plugins/sentry/http/%77ebhook",
      "/api/v1/plugins/sentry/rpc",
    ])
      expect(
        (await send(h.port, { host: OWNER_HOST, path: other, method: "POST" }))
          .status,
      ).toBe(401);

    expect(
      (
        await send(h.port, {
          host: "sawyer--3000.relay.test",
          path,
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect((await openWs(h.port, { host: OWNER_HOST, path })).status).toBe(401);
    expect(anonymousForwards()).toHaveLength(1);
  });

  it("forwards anonymously only the installer paths and the preview capability path it classified", async () => {
    for (const path of CLASSIFIED_PATHS)
      await send(h.port, { host: OWNER_HOST, path });

    for (const target of RAW_TARGETS)
      await rawRequest(
        `GET ${target} HTTP/1.1\r\nhost: ${OWNER_HOST}\r\nx-forwarded-for: 198.51.100.7\r\nconnection: close\r\n\r\n`,
      );

    const forwards = anonymousForwards();

    expect(forwards.length).toBeGreaterThan(5);

    for (const forwarded of forwards) {
      expect(inAnonymousSet(forwarded), forwarded.path).toBe(true);
      expect(forwarded.path, forwarded.path).not.toMatch(
        /^\/(?:api|internal)/u,
      );
    }
  });

  it("lands every anonymous forward on an upstream preview or installer handler", async () => {
    for (const path of [
      "/preview-content/a/b/c",
      "/preview-content/a/b",
      "/preview-content/a/b/",
      "/preview-content/a/b%2F..%2F..%2Fapi%2Fv1%2Fhosts",
      "/preview-content/a%2F..%2F..%2Finternal%2Fws/b/c",
      "/preview-content/a/b/%252e%252e/%252e%252e/api/v1/hosts",
      "/preview-content/a/b/..;/..;/api/v1/hosts",
      "/preview-content/%2e/b/c",
      "/preview-content/a/b/c?x=/../../api/v1/hosts",
      "/install.sh",
      "/install.sh?x=/../api/v1",
      "/install/version",
      "/install/omnyo-app.tgz",
      "/m/ABCD-1234",
      "/m/abcd1234.ps1",
    ])
      await send(h.port, { host: OWNER_HOST, path });

    await send(h.port, {
      host: OWNER_HOST,
      path: "/install/version",
      method: "HEAD",
    });

    const router = upstreamRouter();

    const landed = anonymousForwards().map((forwarded) => {
      const url = new URL(`http://127.0.0.1:4000${forwarded.path}`);
      const path = getPath(new Request(url, { method: forwarded.method }));

      return [forwarded.path, firstHandler(router, forwarded.method, path)];
    });

    expect(landed.length).toBeGreaterThan(10);

    for (const [path, handler] of landed)
      expect(["preview", "installer"], path).toContain(handler);

    expect(firstHandler(router, "GET", "/api/v1/hosts")).toBe("privileged");
    expect(landed.some(([, handler]) => handler === "preview")).toBe(true);
    expect(landed.some(([, handler]) => handler === "installer")).toBe(true);
  });

  it("does not forward other methods, WebSocket upgrades or port-share targets anonymously", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of ["/preview-content/a/b/c", "/install.sh"]) {
        const refused = await send(h.port, { host: OWNER_HOST, path, method });

        expect(refused.status, `${method} ${path}`).toBe(401);
      }
    }

    for (const path of ["/preview-content/a/b/c", "/install.sh"]) {
      const socket = await openWs(h.port, { host: OWNER_HOST, path });

      expect(socket.status, path).toBe(401);
    }

    for (const path of [
      "/preview-content/a/b/c",
      "/install.sh",
      "/install/omnyo-app.tgz",
    ]) {
      const portShare = await send(h.port, {
        host: "sawyer--3000.relay.test",
        path,
      });

      expect(portShare.status, path).not.toBe(200);
    }

    expect(h.tunnels.httpRequests).toHaveLength(0);
    expect(h.tunnels.wsRequests).toHaveLength(0);
  });
});

describe("headers on forwarded requests", () => {
  it("marks preview and installer forwards anonymous and strips forged gate and forwarding headers", async () => {
    const forged: Record<string, string> = { ...VISITOR_FORWARDING_HEADERS };

    for (const name of GATE_CONTROLLED_HEADERS) {
      if (name !== MACHINE_CREDENTIAL_HEADER) forged[name] = "forged";
    }

    forged[GATE_AUTH_HEADER] = "session";
    forged.cookie =
      "__Secure-omnyo-connect.desktop_session=d; __Host-omnyo-gate=g; __Secure-better-auth.session_token=s; tenant=1";

    for (const path of [
      "/preview-content/a/b/c",
      "/install.sh",
      "/install/omnyo-app.tgz",
    ]) {
      await send(h.port, {
        host: OWNER_HOST,
        path,
        headers: forged,
        forwardedFor: "6.6.6.6, 198.51.100.44",
      });
    }

    const forwards = anonymousForwards();

    expect(forwards).toHaveLength(3);

    for (const forwarded of forwards) {
      const headers = new Map(forwarded.headers);

      expect(headers.get(GATE_AUTH_HEADER), forwarded.path).toBe("anonymous");
      expect(
        forwarded.headers.filter(([name]) => name === GATE_AUTH_HEADER),
      ).toHaveLength(1);
      expect(headers.get("x-omnyo-client-ip")).toBe("198.51.100.44");
      expect(headers.has("x-forwarded-for")).toBe(false);
      expect(headers.get("cookie")).toBe("tenant=1");

      for (const name of Object.keys(VISITOR_FORWARDING_HEADERS))
        expect(headers.has(name), name).toBe(false);

      for (const name of GATE_CONTROLLED_HEADERS.filter(
        (header) => header !== GATE_AUTH_HEADER,
      ))
        expect(headers.has(name), name).toBe(false);
    }
  });

  it("forwards only the gate's own auth header and no visitor forwarding header on an owner machine request", async () => {
    const owner = h.addUser("dana");
    h.addServer(owner.id, "dana");
    h.tunnels.connect("dana");
    const phone = h.addMachine(owner.id, null);

    const response = await send(h.port, {
      host: "dana.relay.test",
      path: "/api/v1/status",
      headers: {
        ...VISITOR_FORWARDING_HEADERS,
        [MACHINE_CREDENTIAL_HEADER]: phone.credential,
        [GATE_AUTH_HEADER]: "session",
        [GATE_MACHINE_ID_HEADER]: "forged",
      },
    });

    expect(response.status).toBe(200);

    const forwarded = h.tunnels.httpRequests.at(-1);
    const headers = new Map(forwarded?.headers ?? []);

    expect(headers.get(GATE_AUTH_HEADER)).toBe("machine");
    expect(headers.get(GATE_MACHINE_ID_HEADER)).toBe(phone.id);
    expect(headers.has(MACHINE_CREDENTIAL_HEADER)).toBe(false);

    for (const name of Object.keys(VISITOR_FORWARDING_HEADERS))
      expect(headers.has(name), name).toBe(false);
  });

  it("refuses another account's machine credential on the owner's address without forwarding it", async () => {
    const stranger = h.addUser("mallory");
    const strangerPhone = h.addMachine(stranger.id, null);

    for (const path of ["/api/v1/status", "/internal/ws"]) {
      const refused = await send(h.port, {
        host: OWNER_HOST,
        path,
        headers: { [MACHINE_CREDENTIAL_HEADER]: strangerPhone.credential },
      });

      expect(refused.status, path).toBe(403);
    }

    const socket = await openWs(h.port, {
      host: OWNER_HOST,
      path: "/api/v1/events",
      headers: { [MACHINE_CREDENTIAL_HEADER]: strangerPhone.credential },
    });

    expect(socket.status).toBe(403);
    expect(h.tunnels.httpRequests).toHaveLength(0);
    expect(h.tunnels.wsRequests).toHaveLength(0);
  });

  it("refuses the owner's cookie-authenticated upgrade unless Origin is the address itself", async () => {
    const owner = h.addUser("dana");
    h.addServer(owner.id, "dana");
    h.tunnels.connect("dana");

    const issued = issueGateCookie(
      derivePurposeKey(h.config.betterAuthSecret, GATE_KEY_LABEL),
      {
        userId: owner.id,
        host: "dana.relay.test",
        sessionId: owner.sessionId,
        sessionExpiresAt: h.clock.now() + 24 * 60 * 60 * 1000,
      },
      h.clock.now(),
    );

    const cookie = cookiePair(issued.setCookie);

    for (const origin of ["null", "https://sawyer.relay.test"]) {
      const refused = await openWs(h.port, {
        host: "dana.relay.test",
        path: "/realtime",
        headers: { cookie, origin },
      });

      expect(refused.status, origin).toBe(403);
    }

    expect(h.tunnels.wsRequests).toHaveLength(0);

    const own = await openWs(h.port, {
      host: "dana.relay.test",
      path: "/realtime",
      headers: { cookie, origin: "https://dana.relay.test" },
    });

    expect(own.status).toBe(101);
    own.socket?.close();

    const explicitPort = await openWs(h.port, {
      host: "dana.relay.test:443",
      path: "/realtime",
      headers: { cookie, origin: "https://dana.relay.test" },
    });

    expect(explicitPort.status).toBe(101);
    explicitPort.socket?.close();
  });

  it("forwards only tenant cookies on a preview request", async () => {
    const carried = [
      [GATE_COOKIE, "g"],
      [NONCE_COOKIE, "n"],
      [SECURE_DESKTOP_SESSION_COOKIE, "d"],
      [LEGACY_SECURE_DESKTOP_SESSION_COOKIE, "l"],
      ["__host-omnyo.state", "s"],
      ["better-auth.x", "b"],
      ["tenant", "1"],
    ]
      .map((entry) => entry.join("="))
      .join("; ");

    const page = await send(h.port, {
      host: OWNER_HOST,
      path: "/preview-content/p1/cap1/index.html",
      headers: { cookie: carried },
    });

    const echoed = JSON.parse(page.body) as {
      grant: string;
      headers: Record<string, string>;
    };

    expect(page.status).toBe(200);
    expect(echoed.grant).toBe("anonymous");
    expect(echoed.headers.cookie).toBe("tenant=1");
  });
});
