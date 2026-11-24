import { request as httpRequest } from "node:http";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machine, server } from "@omnyo/connect-db";
import { deleteRelayUser, suspendUser, unsuspendUser } from "../user-blocks.js";
import { ACCESS_REVOKED_REASON } from "./gate.js";
import { issueGateCookie } from "./gate-cookie.js";
import {
  type Harness,
  type TestMachine,
  type TestServer,
  type TestUser,
  cookiePair,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { TUNNEL_OFFLINE_HEADER } from "./protocol-headers.js";
import {
  GATE_KEY_LABEL,
  derivePurposeKey,
  randomToken,
  sha256HexOf,
} from "./signed-token.js";

const LABEL = "mallory";

const HOST = `${LABEL}.relay.test`;

const DEVICE_LABEL = "malloryphone";

const PORT_SHARE_HOST = `${DEVICE_LABEL}--3000.relay.test`;

const PREVIEW_PATH = "/preview-content/p1/cap1/index.html";

let h: Harness;

let owner: TestUser;

let paired: TestServer;

let device: TestMachine;

let visitorIndex = 0;

beforeEach(async () => {
  h = await startHarness();
  owner = h.addUser(LABEL);
  paired = h.addServer(owner.id, LABEL);
  device = h.addMachine(owner.id, DEVICE_LABEL);
});

afterEach(async () => {
  await h.close();
});

function nextVisitorIp(): string {
  visitorIndex += 1;

  return `203.0.113.${(visitorIndex % 250) + 1}`;
}

async function dial(host: string, credential: string) {
  const dialed = await openWs(h.port, {
    host,
    path: "/__tunnel",
    headers: { authorization: `Bearer ${credential}` },
  });

  return dialed;
}

function ownerCookie(host: string): string {
  return cookiePair(
    issueGateCookie(
      derivePurposeKey(h.config.betterAuthSecret, GATE_KEY_LABEL),
      {
        userId: owner.id,
        host,
        sessionId: owner.sessionId,
        sessionExpiresAt: h.clock.now() + 24 * 60 * 60 * 1000,
      },
      h.clock.now(),
    ).setCookie,
  );
}

function anonymous(path: string, host = HOST) {
  return send(h.port, { host, path, forwardedFor: nextVisitorIp() });
}

function ownerRequest(host: string, path = "/", accept = "application/json") {
  return send(h.port, {
    host,
    path,
    forwardedFor: nextVisitorIp(),
    headers: { cookie: ownerCookie(host), accept },
  });
}

function revokeServerRow(): void {
  h.database.db
    .update(server)
    .set({ credentialHash: null, revokedAt: new Date(h.clock.now()) })
    .where(eq(server.id, paired.id))
    .run();
}

function forwardedPaths(): string[] {
  return [
    ...h.tunnels.httpRequests.map((request) => request.path),
    ...h.tunnels.wsRequests.map((request) => request.path),
  ];
}

function closedKeys(): string[] {
  return h.tunnels.closed.map((entry) => entry.routingKey);
}

function holdOrigin(): { signal: () => AbortSignal | null } {
  let originSignal: AbortSignal | null = null;

  h.tunnels.origin = (request) => {
    originSignal = request.signal;

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512).fill(120));
        },
      }),
      { status: 200 },
    );
  };

  return { signal: () => originSignal };
}

function openStream(
  path: string,
): Promise<{ status: number; ended: Promise<"ended" | "aborted"> }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: h.port,
        method: "GET",
        path,
        headers: { host: HOST, "x-forwarded-for": nextVisitorIp() },
      },
      (response) => {
        const ended = new Promise<"ended" | "aborted">((settle) => {
          response.once("end", () => settle("ended"));
          response.once("aborted", () => settle("aborted"));
          response.once("error", () => settle("aborted"));
        });

        response.once("data", () =>
          resolve({ status: response.statusCode ?? 0, ended }),
        );
      },
    );

    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("a tunnel attached when its owner is suspended", () => {
  it("is closed by the next sweep, and the address stops answering", async () => {
    const dialed = await dial(HOST, paired.credential);

    expect(dialed.kind).toBe("open");
    expect((await anonymous(PREVIEW_PATH)).status).toBe(200);

    suspendUser(h.database.db, {
      userId: owner.id,
      reason: "phishing",
      now: h.clock.now(),
    });

    expect(closedKeys()).toEqual([]);
    h.gate.sweep();

    expect(closedKeys()).toEqual([LABEL]);
    expect(h.tunnels.closed[0]?.reason).toBe(ACCESS_REVOKED_REASON);
    expect((await anonymous(PREVIEW_PATH)).status).toBe(404);
    expect((await dial(HOST, paired.credential)).status).toBe(404);

    dialed.socket?.terminate();
  });

  it("is not served after unsuspend, because the server must pair again", async () => {
    const dialed = await dial(HOST, paired.credential);
    const forwardedBefore = forwardedPaths().length;

    suspendUser(h.database.db, {
      userId: owner.id,
      reason: "account takeover",
      now: h.clock.now(),
    });
    h.gate.sweep();
    unsuspendUser(h.database.db, { userId: owner.id, now: h.clock.now() });

    expect((await dial(HOST, paired.credential)).status).toBe(403);
    expect((await anonymous(PREVIEW_PATH)).status).toBe(503);
    expect(forwardedPaths()).toHaveLength(forwardedBefore);

    dialed.socket?.terminate();
  });
});

describe("a revoked server before any sweep runs", () => {
  beforeEach(async () => {
    expect((await dial(HOST, paired.credential)).kind).toBe("open");
    suspendUser(h.database.db, {
      userId: owner.id,
      reason: "account takeover",
      now: h.clock.now(),
    });
    unsuspendUser(h.database.db, { userId: owner.id, now: h.clock.now() });
    owner = { ...owner, ...h.addSession(owner.id) };
  });

  it("answers anonymous previews and installer downloads as offline without reaching the tunnel", async () => {
    for (const path of [PREVIEW_PATH, "/install.sh", "/install/version"]) {
      const response = await anonymous(path);

      expect(response.status, path).toBe(503);
      expect(response.headers[TUNNEL_OFFLINE_HEADER], path).toBe("1");
    }

    expect(forwardedPaths()).toEqual([]);
  });

  it("shows its signed-in owner the offline page and forwards nothing", async () => {
    const page = await ownerRequest(HOST, "/", "text/html");

    expect(page.status).toBe(503);
    expect(page.headers["content-type"]).toContain("text/html");
    expect((await ownerRequest(HOST, "/api/v1/threads")).status).toBe(503);
    expect(forwardedPaths()).toEqual([]);
  });

  it("refuses the owner's WebSocket as offline", async () => {
    const opened = await openWs(h.port, {
      host: HOST,
      path: "/realtime",
      headers: {
        cookie: ownerCookie(HOST),
        origin: `https://${HOST}`,
      },
    });

    expect(opened).toMatchObject({ kind: "refused", status: 503 });
    expect(forwardedPaths()).toEqual([]);
  });
});

describe("a tunnel dialed with a credential that is no longer the server's", () => {
  it("is closed on the next request after the server is paired again elsewhere", async () => {
    const stale = await dial(HOST, paired.credential);

    expect(stale.kind).toBe("open");
    h.database.db
      .update(server)
      .set({ credentialHash: sha256HexOf(randomToken()), revokedAt: null })
      .where(eq(server.id, paired.id))
      .run();

    const preview = await anonymous(PREVIEW_PATH);

    expect(preview.status).toBe(503);
    expect(forwardedPaths()).toEqual([]);
    expect(closedKeys()).toEqual([LABEL]);

    stale.socket?.terminate();
  });

  it("is closed by the sweep even when nobody visits", async () => {
    const stale = await dial(HOST, paired.credential);

    revokeServerRow();
    h.gate.sweep();

    expect(closedKeys()).toEqual([LABEL]);

    stale.socket?.terminate();
  });

  it("keeps a tunnel whose credential is still live", async () => {
    const live = await dial(HOST, paired.credential);

    h.gate.sweep();
    h.gate.sweep();

    expect(closedKeys()).toEqual([]);
    expect((await anonymous(PREVIEW_PATH)).status).toBe(200);

    live.socket?.terminate();
  });
});

describe("tunnels whose row disappears or is revoked by another process", () => {
  it("closes the server's tunnel after delete-user", async () => {
    const dialed = await dial(HOST, paired.credential);

    deleteRelayUser(h.database.db, { userId: owner.id, now: h.clock.now() });
    h.gate.sweep();

    expect(closedKeys()).toEqual([LABEL]);

    dialed.socket?.terminate();
  });

  it("closes a revoked device's tunnel and refuses its port shares", async () => {
    const dialed = await dial(`${DEVICE_LABEL}.relay.test`, device.credential);

    expect(dialed.kind).toBe("open");
    const routingKey = h.tunnels.attachments[0]?.routingKey ?? "";

    expect((await ownerRequest(PORT_SHARE_HOST)).status).toBe(200);
    h.database.db
      .update(machine)
      .set({ revokedAt: new Date(h.clock.now()) })
      .where(eq(machine.id, device.id))
      .run();

    const refused = await ownerRequest(PORT_SHARE_HOST);

    expect(refused.status).toBe(503);
    expect(h.tunnels.httpRequests).toHaveLength(1);

    h.gate.sweep();

    expect(closedKeys()).toEqual([routingKey]);

    dialed.socket?.terminate();
  });
});

describe("streams in flight when the owner is suspended", () => {
  for (const path of ["/install/omnyo-app.tgz", PREVIEW_PATH]) {
    it(`closes an anonymous ${path} download at the next sweep`, async () => {
      h.tunnels.connect(LABEL);
      const origin = holdOrigin();
      const stream = await openStream(path);

      expect(stream.status).toBe(200);
      expect(h.gate.openStreams()).toBe(1);

      suspendUser(h.database.db, {
        userId: owner.id,
        reason: "malware",
        now: h.clock.now(),
      });
      h.gate.sweep();

      expect(await stream.ended).toBe("aborted");
      expect(origin.signal()?.aborted).toBe(true);
      expect(origin.signal()?.reason).toBe(ACCESS_REVOKED_REASON);
      expect(h.gate.openStreams()).toBe(0);
    });
  }

  it("leaves an anonymous download running while the owner is in good standing", async () => {
    h.tunnels.connect(LABEL);
    const origin = holdOrigin();
    const stream = await openStream("/install/omnyo-app.tgz");

    h.gate.sweep();

    expect(origin.signal()?.aborted).toBe(false);
    expect(h.gate.openStreams()).toBe(1);

    revokeServerRow();
    h.gate.sweep();

    expect(await stream.ended).toBe("aborted");
    expect(h.gate.openStreams()).toBe(0);
  });
});
