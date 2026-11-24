import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { session } from "@omnyo/connect-db";
import { SESSION_EXPIRES_IN_MS } from "../auth/auth-service.js";
import { GATE_COOKIE } from "./cookies.js";
import { issueGateCookie } from "./gate-cookie.js";
import {
  APP_URL,
  type Harness,
  cookieValue,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { AUTHORIZE_PATH } from "./handshake.js";
import { GATE_REAUTH_HEADER } from "./protocol-headers.js";
import { GATE_KEY_LABEL, derivePurposeKey } from "./signed-token.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const HOST = "sawyer.relay.test";

let h: Harness;

beforeEach(async () => {
  h = await startHarness({ productionAuth: true });
});

afterEach(async () => {
  await h.close();
});

function sessionExpiry(sessionId: string): number {
  const row = h.database.db
    .select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.id, sessionId))
    .get();

  if (row === undefined) throw new Error("session row missing");

  return row.expiresAt.getTime();
}

describe("sliding renewal (P10)", () => {
  it("keeps a daily user signed in for ten days, then sends an idle user back through the handshake", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");

    const gateKey = derivePurposeKey(h.config.betterAuthSecret, GATE_KEY_LABEL);

    const first = issueGateCookie(
      gateKey,
      {
        userId: owner.id,
        host: HOST,
        sessionId: owner.sessionId,
        sessionExpiresAt: sessionExpiry(owner.sessionId),
      },
      h.clock.now(),
    );

    let gateCookie = cookieValue([first.setCookie], GATE_COOKIE) ?? "";
    expect(gateCookie).not.toBe("");

    for (let day = 1; day <= 10; day += 1) {
      h.clock.advance(DAY_MS);

      const page = await send(h.port, {
        host: HOST,
        path: "/",
        headers: {
          accept: "text/html",
          cookie: `${GATE_COOKIE}=${gateCookie}`,
        },
      });

      expect(page.status, `day ${day} page`).toBe(200);
      const reissued = cookieValue(page.setCookies, GATE_COOKIE);
      expect(reissued, `day ${day} reissue`).not.toBeNull();
      expect(
        page.setCookies.find((line) => line.startsWith(`${GATE_COOKIE}=`)),
        `day ${day} cookie expiry`,
      ).toContain(
        `Expires=${new Date(h.clock.now() + SESSION_EXPIRES_IN_MS).toUTCString()}`,
      );
      gateCookie = reissued ?? gateCookie;

      expect(sessionExpiry(owner.sessionId), `day ${day} session`).toBe(
        h.clock.now() + SESSION_EXPIRES_IN_MS,
      );

      const api = await send(h.port, {
        host: HOST,
        path: "/api/state",
        headers: {
          accept: "application/json",
          cookie: `${GATE_COOKIE}=${gateCookie}`,
        },
      });

      expect(api.status, `day ${day} fetch`).toBe(200);
    }

    h.clock.advance(8 * DAY_MS);

    const navigation = await send(h.port, {
      host: HOST,
      path: "/",
      headers: { accept: "text/html", cookie: `${GATE_COOKIE}=${gateCookie}` },
    });

    expect(navigation.status).toBe(302);
    expect(new URL(String(navigation.headers.location)).origin).toBe(
      new URL(APP_URL).origin,
    );
    expect(new URL(String(navigation.headers.location)).pathname).toBe(
      AUTHORIZE_PATH,
    );

    const idleFetch = await send(h.port, {
      host: HOST,
      path: "/api/state",
      headers: {
        accept: "application/json",
        cookie: `${GATE_COOKIE}=${gateCookie}`,
      },
    });

    expect(idleFetch.status).toBe(401);
    expect(idleFetch.headers[GATE_REAUTH_HEADER]).toBe("1");
  });
});
