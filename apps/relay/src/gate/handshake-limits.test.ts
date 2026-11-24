import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import { NONCE_COOKIE } from "./cookies.js";
import {
  BASE_DOMAIN,
  type Harness,
  SESSION_COOKIE,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { AUTHORIZE_PATH, CALLBACK_PATH, newNonce } from "./handshake.js";

const SHARED_IP = "198.51.100.40";

const OTHER_IP = "198.51.100.41";

const TENANT_HOST = `sawyer.${BASE_DOMAIN}`;

const BURST = RELAY_RATE_LIMITS.gateHandshake.limit;

let h: Harness;

let sessionToken: string;

beforeEach(async () => {
  h = await startHarness();
  const owner = h.addUser("sawyer");
  h.addServer(owner.id, "sawyer");
  h.tunnels.connect("sawyer");
  sessionToken = h.addSession(owner.id).sessionToken;
});

afterEach(async () => {
  await h.close();
});

function authorizePath(digest: string): string {
  const params = new URLSearchParams({
    host: TENANT_HOST,
    return: "/",
    n: digest,
  });

  return `${AUTHORIZE_PATH}?${params.toString()}`;
}

function authorize(digest: string, ip: string, signedIn: boolean) {
  return send(h.port, {
    host: BASE_DOMAIN,
    path: authorizePath(digest),
    forwardedFor: ip,
    headers: signedIn ? { cookie: `${SESSION_COOKIE}=${sessionToken}` } : {},
  });
}

async function floodFrom(ip: string, host: string, path: string) {
  for (let index = 0; index < BURST + 5; index += 1) {
    await send(h.port, { host, path, forwardedFor: ip });
  }
}

describe("the gate handshake under a shared address", () => {
  it("still authorizes a signed-in owner after anonymous junk from the same address", async () => {
    await floodFrom(SHARED_IP, BASE_DOMAIN, `${AUTHORIZE_PATH}?junk=1`);

    expect((await authorize(newNonce().digest, SHARED_IP, false)).status).toBe(
      429,
    );

    const owner = await authorize(newNonce().digest, SHARED_IP, true);

    expect(owner.status).toBe(302);
    expect(String(owner.headers.location)).toContain(CALLBACK_PATH);
  });

  it("limits a signed-in session's own authorize requests", async () => {
    for (let index = 0; index < BURST; index += 1) {
      expect(
        (await authorize(newNonce().digest, `198.51.100.${index + 50}`, true))
          .status,
      ).toBe(302);
    }

    expect((await authorize(newNonce().digest, OTHER_IP, true)).status).toBe(
      429,
    );
  });

  it("redeems a valid code after failed redemptions from the same address", async () => {
    const nonce = newNonce();
    const authorized = await authorize(nonce.digest, OTHER_IP, true);
    const location = new URL(String(authorized.headers.location));

    await floodFrom(SHARED_IP, TENANT_HOST, `${CALLBACK_PATH}?code=junk`);

    expect(
      (
        await send(h.port, {
          host: TENANT_HOST,
          path: `${CALLBACK_PATH}?code=junk`,
          forwardedFor: SHARED_IP,
        })
      ).status,
    ).toBe(429);

    const redeemed = await send(h.port, {
      host: TENANT_HOST,
      path: `${location.pathname}${location.search}`,
      forwardedFor: SHARED_IP,
      headers: { cookie: `${NONCE_COOKIE}=${nonce.nonce}` },
    });

    expect(redeemed.status).not.toBe(429);
    expect(redeemed.status).toBeLessThan(400);
  });
});
