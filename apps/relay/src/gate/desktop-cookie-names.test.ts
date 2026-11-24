import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machine, server } from "@omnyo/connect-db";
import {
  MACHINE_CREDENTIAL_PREFIX,
  SERVER_CREDENTIAL_PREFIX,
  generateToken,
} from "../account/tokens.js";
import {
  LEGACY_SECURE_DESKTOP_SESSION_COOKIE,
  SECURE_DESKTOP_SESSION_COOKIE,
  isPlatformCookie,
} from "./cookies.js";
import {
  type Harness,
  type TestServer,
  type TestUser,
  cookieValue,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { verifyMachineCredential, verifyServerCredential } from "./resolve.js";
import { sha256HexOf } from "./signed-token.js";

const ALICE_HOST = "alice.relay.test";

const MACHINE_HEADER = "x-omnyo-connect-machine";

interface MintedCookie {
  name: string;
  value: string;
  domain: string;
}

let h: Harness;

let alice: TestUser;

let aliceServer: TestServer;

beforeEach(async () => {
  h = await startHarness();
  alice = h.addUser("alice");
  aliceServer = h.addServer(alice.id, "alice");
  h.tunnels.connect("alice");
});

afterEach(async () => {
  await h.close();
});

async function mint(): Promise<MintedCookie> {
  const response = await send(h.port, {
    host: ALICE_HOST,
    path: "/api/connect/desktop-session",
    method: "POST",
    headers: { [MACHINE_HEADER]: aliceServer.credential },
  });

  expect(response.status).toBe(200);

  return (JSON.parse(response.body) as { cookie: MintedCookie }).cookie;
}

function reach(cookie: string) {
  return send(h.port, {
    host: ALICE_HOST,
    path: "/projects",
    headers: { cookie },
  });
}

describe("desktop session cookie names", () => {
  it("mints the cookie under the Omnyo name", async () => {
    const minted = await mint();

    expect(minted.name).toBe("__Secure-omnyo-connect.desktop_session");
    expect(minted.name).toBe(SECURE_DESKTOP_SESSION_COOKIE);
    expect(minted.domain).toBe(".relay.test");
  });

  it("accepts the Omnyo name without touching cookies", async () => {
    const minted = await mint();
    const response = await reach(`${minted.name}=${minted.value}`);

    expect(response.status).toBe(200);
    expect(response.setCookies).toEqual([]);
  });

  it("accepts the earlier name, reissues under the Omnyo name and expires the earlier cookie", async () => {
    const minted = await mint();

    const response = await reach(
      `${LEGACY_SECURE_DESKTOP_SESSION_COOKIE}=${minted.value}`,
    );

    expect(response.status).toBe(200);

    const reissued = cookieValue(
      response.setCookies,
      SECURE_DESKTOP_SESSION_COOKIE,
    );

    expect(reissued).not.toBeNull();

    const expired = response.setCookies.find((cookie) =>
      cookie.startsWith(`${LEGACY_SECURE_DESKTOP_SESSION_COOKIE}=;`),
    );

    expect(expired).toContain("Max-Age=0");
    expect(expired).toContain("Domain=.relay.test");

    const followUp = await reach(
      `${SECURE_DESKTOP_SESSION_COOKIE}=${reissued ?? ""}`,
    );

    expect(followUp.status).toBe(200);
    expect(followUp.setCookies).toEqual([]);
  });

  it("prefers a valid Omnyo cookie and expires an earlier cookie sent beside it", async () => {
    const minted = await mint();

    const response = await reach(
      `${LEGACY_SECURE_DESKTOP_SESSION_COOKIE}=stale; ${minted.name}=${minted.value}`,
    );

    expect(response.status).toBe(200);
    expect(response.setCookies).toHaveLength(1);
    expect(response.setCookies[0]).toContain(
      `${LEGACY_SECURE_DESKTOP_SESSION_COOKIE}=;`,
    );
  });

  it("falls back to a valid earlier cookie when the Omnyo cookie is invalid", async () => {
    const minted = await mint();

    const response = await reach(
      `${SECURE_DESKTOP_SESSION_COOKIE}=stale; ${LEGACY_SECURE_DESKTOP_SESSION_COOKIE}=${minted.value}`,
    );

    expect(response.status).toBe(200);
    expect(
      cookieValue(response.setCookies, SECURE_DESKTOP_SESSION_COOKIE),
    ).not.toBeNull();
  });

  it("refuses an invalid cookie under either name", async () => {
    for (const name of [
      SECURE_DESKTOP_SESSION_COOKIE,
      LEGACY_SECURE_DESKTOP_SESSION_COOKIE,
    ]) {
      const response = await reach(`${name}=stale`);

      expect(response.status).toBe(401);
    }
  });

  it("keeps both names away from tenant servers", () => {
    for (const name of [
      "__Secure-omnyo-connect.desktop_session",
      "omnyo-connect.desktop_session",
      "__Host-omnyo-connect.desktop_session",
      "__Secure-bb-connect.desktop_session",
      "bb-connect.desktop_session",
    ]) {
      expect(isPlatformCookie(name)).toBe(true);
    }

    expect(isPlatformCookie("omnyo-theme")).toBe(false);
  });
});

describe("credential prefixes", () => {
  it("issues Omnyo prefixes", () => {
    expect(SERVER_CREDENTIAL_PREFIX).toBe("omnyocred_");
    expect(MACHINE_CREDENTIAL_PREFIX).toBe("omnyocm_");
  });

  it.each(["omnyocred_", "bbcred_"])(
    "verifies a server credential issued as %s",
    (prefix) => {
      const credential = generateToken(prefix);

      h.database.db
        .insert(server)
        .values({
          id: randomUUID(),
          userId: alice.id,
          name: "second",
          subdomain: `second-${prefix.length}`,
          credentialHash: sha256HexOf(credential),
          version: null,
          lastSeenAt: null,
          createdAt: new Date(h.clock.now()),
          revokedAt: null,
        })
        .run();

      expect(verifyServerCredential(h.database.db, credential)?.userId).toBe(
        alice.id,
      );
    },
  );

  it.each(["omnyocm_", "bbcm_"])(
    "verifies a machine credential issued as %s",
    (prefix) => {
      const credential = generateToken(prefix);

      h.database.db
        .insert(machine)
        .values({
          id: randomUUID(),
          userId: alice.id,
          name: "phone",
          subdomain: null,
          credentialHash: sha256HexOf(credential),
          lastSeenAt: null,
          createdAt: new Date(h.clock.now()),
          revokedAt: null,
        })
        .run();

      expect(verifyMachineCredential(h.database.db, credential)?.userId).toBe(
        alice.id,
      );
    },
  );
});
