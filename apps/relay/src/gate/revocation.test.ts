import { request as httpRequest } from "node:http";
import type { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { session } from "@omnyo/connect-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOCATION_SWEEP_INTERVAL_MS } from "../contracts.js";
import {
  GATE_COOKIE,
  NONCE_COOKIE,
  SECURE_DESKTOP_SESSION_COOKIE,
} from "./cookies.js";
import {
  type Harness,
  SESSION_COOKIE,
  type TestUser,
  cookiePair,
  cookieValue,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import {
  DESKTOP_KEY_LABEL,
  derivePurposeKey,
  signToken,
} from "./signed-token.js";

const ALICE_HOST = "alice.relay.test";

const HTML = { accept: "text/html" };

let h: Harness;

let alice: TestUser;

beforeEach(async () => {
  h = await startHarness();
  alice = h.addUser("alice");
  h.addServer(alice.id, "alice");
  h.tunnels.connect("alice");
});

afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

async function signIn(): Promise<string> {
  const start = await send(h.port, {
    host: ALICE_HOST,
    path: "/",
    headers: HTML,
  });

  const authorize = new URL(start.headers.location ?? "");

  const authorized = await send(h.port, {
    host: authorize.host,
    path: `${authorize.pathname}${authorize.search}`,
    headers: { ...HTML, cookie: `${SESSION_COOKIE}=${alice.sessionToken}` },
  });

  const callback = new URL(authorized.headers.location ?? "");

  const finished = await send(h.port, {
    host: ALICE_HOST,
    path: `${callback.pathname}${callback.search}`,
    headers: {
      ...HTML,
      cookie: `${NONCE_COOKIE}=${cookieValue(start.setCookies, NONCE_COOKIE) ?? ""}`,
    },
  });

  return cookiePair(
    finished.setCookies.find((cookie) =>
      cookie.startsWith(`${GATE_COOKIE}=`),
    ) ?? "",
  );
}

function closeOf(socket: WebSocket | null): Promise<number> {
  if (socket === null) throw new Error("the WebSocket did not open");

  return new Promise((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
}

function streamingRequest(
  cookie: string,
): Promise<{ firstChunk: Promise<void>; closed: Promise<boolean> }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: h.port,
        path: "/api/v1/events",
        headers: {
          host: ALICE_HOST,
          cookie,
          "x-forwarded-for": "198.51.100.7",
        },
      },
      (response) => {
        const firstChunk = new Promise<void>((chunkResolve) =>
          response.once("data", () => chunkResolve()),
        );

        const closed = new Promise<boolean>((closeResolve) =>
          response.once("close", () => closeResolve(response.complete)),
        );

        response.on("error", () => undefined);
        response.resume();
        resolve({ firstChunk, closed });
      },
    );

    outgoing.on("error", () => undefined);
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("machine revocation", () => {
  it("closes the machine tunnel, refuses its next request within 1 s and journals the revoke", async () => {
    const mac = h.addMachine(alice.id, "alice-mac");

    const dial = await openWs(h.port, {
      host: "alice-mac.relay.test",
      path: "/__tunnel?v=1",
      headers: { authorization: `Bearer ${mac.credential}` },
    });

    expect(dial.status).toBe(101);
    const routingKey = h.tunnels.attachments[0]?.routingKey ?? "";
    expect(routingKey).toMatch(/^alice-mac:[0-9a-f]{32}$/u);

    const machineHeaders = { "x-omnyo-connect-machine": mac.credential };
    expect(
      (
        await send(h.port, {
          host: ALICE_HOST,
          path: "/api/v1/hosts",
          headers: machineHeaders,
        })
      ).status,
    ).toBe(200);

    const desktop = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/desktop-session",
      method: "POST",
      headers: machineHeaders,
    });

    const issued = (
      JSON.parse(desktop.body) as { cookie: { name: string; value: string } }
    ).cookie;

    const desktopCookie = `${issued.name}=${issued.value}`;
    expect(
      (
        await send(h.port, {
          host: ALICE_HOST,
          path: "/api/v1/threads",
          headers: { cookie: desktopCookie },
        })
      ).status,
    ).toBe(200);

    const bound = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/realtime",
      headers: machineHeaders,
    });

    expect(bound.kind).toBe("open");
    const boundClosed = closeOf(bound.socket);

    const startedAt = performance.now();
    expect(h.gate.revokeMachine({ userId: alice.id, machineId: mac.id })).toBe(
      true,
    );

    const next = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/hosts",
      headers: machineHeaders,
    });

    expect(next.status).toBe(403);
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    const viaCookie = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/threads",
      headers: { cookie: desktopCookie },
    });

    expect(viaCookie.status).toBe(401);

    expect(await boundClosed).toBe(1008);
    expect(h.tunnels.closed).toContainEqual({
      routingKey,
      reason: "revoked by owner",
    });
    expect(h.journal.entries()).toEqual([
      {
        v: 1,
        kind: "machine",
        id: mac.id,
        userId: alice.id,
        at: h.clock.now(),
      },
    ]);

    const redial = await openWs(h.port, {
      host: "alice-mac.relay.test",
      path: "/__tunnel?v=1",
      headers: { authorization: `Bearer ${mac.credential}` },
    });

    expect(redial.status).toBe(403);
    expect(h.gate.revokeMachine({ userId: alice.id, machineId: mac.id })).toBe(
      false,
    );
    expect(h.journal.entries()).toHaveLength(1);
  });

  it("journals a server disconnect and closes its tunnel", async () => {
    const box = h.addServer(alice.id, "alice-box");

    const response = await send(h.port, {
      host: ALICE_HOST,
      path: "/api/connect/disconnect",
      method: "POST",
      headers: { "x-omnyo-connect-machine": box.credential },
    });

    expect(response.status).toBe(200);
    expect(h.tunnels.closed).toContainEqual({
      routingKey: "alice-box",
      reason: "revoked by owner",
    });
    expect(h.journal.entries()).toMatchObject([
      { kind: "server", id: box.id, userId: alice.id },
    ]);
  });
});

describe("sign-out", () => {
  it("redirects the next request and closes open WebSockets and streaming responses within 20 s", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stopSweep = h.gate.startRevocationSweep();
    const cookie = await signIn();

    h.tunnels.origin = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          },
          pull: () => new Promise<void>(() => undefined),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    const socket = await openWs(h.port, {
      host: ALICE_HOST,
      path: "/api/v1/realtime",
      headers: { cookie },
    });

    expect(socket.kind).toBe("open");
    const socketClosed = closeOf(socket.socket);
    const stream = await streamingRequest(cookie);
    await stream.firstChunk;
    expect(h.gate.openStreams()).toBe(2);

    h.database.db.delete(session).where(eq(session.id, alice.sessionId)).run();

    const next = await send(h.port, {
      host: ALICE_HOST,
      path: "/",
      headers: { ...HTML, cookie },
    });

    expect(next.status).toBe(302);
    expect(next.headers.location).toContain("/relay/authorize");

    vi.advanceTimersByTime(REVOCATION_SWEEP_INTERVAL_MS - 1);
    expect(h.gate.openStreams()).toBe(2);

    vi.advanceTimersByTime(1);
    expect(await socketClosed).toBe(1008);
    expect(await stream.closed).toBe(false);
    expect(h.gate.openStreams()).toBe(0);
    expect(REVOCATION_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(20_000);
    stopSweep();
  });
});

describe("desktop cookies", () => {
  it("refuses a desktop cookie without a grant", async () => {
    const key = derivePurposeKey(h.config.betterAuthSecret, DESKTOP_KEY_LABEL);
    const now = h.clock.now();

    const grantless = signToken(key, {
      typ: "desktop",
      userId: alice.id,
      iat: now,
      exp: now + 3_600_000,
    });

    const legacy = signToken(key, {
      userId: alice.id,
      expiresAt: now + 3_600_000,
    });

    for (const value of [grantless, legacy]) {
      const response = await send(h.port, {
        host: ALICE_HOST,
        path: "/api/v1/threads",
        headers: { cookie: `${SECURE_DESKTOP_SESSION_COOKIE}=${value}` },
      });

      expect(response.status).toBe(401);
    }

    expect(h.tunnels.httpRequests).toHaveLength(0);
  });
});
