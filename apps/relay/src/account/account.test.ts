import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_CODE_TTL_MS,
  MAX_PER_ACCOUNT,
  connectCode,
  machine,
  resolveServerCredential,
  server,
  sha256Hex,
  user,
} from "@omnyo/connect-db";
import {
  LINK_EXPIRED_ROW_PRUNE_LIMIT,
  LINK_DELIVERY_GRACE_MS,
  LINK_EXPIRED_ROW_RETENTION_MS,
  LINK_POLL_INTERVAL_MS,
  approveServerLink,
  denyServerLink,
  getAccountMe,
  getLinkRequestView,
  linkRequestOrigin,
  pollServerLink,
  startServerLink,
  suggestServerLabel,
} from "./account.js";
import {
  type AccountRevocation,
  type Deps,
  claimHandle,
  suggestAvailableHandle,
  createConnectCode,
  disconnectServer,
  redeemConnectCode,
} from "./api.js";
import { CLIENT_IP_HEADER } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase, type RelayDb } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";

let database: RelayDatabase;

let db: RelayDb;

let closeTunnel: ReturnType<typeof vi.fn<(label: string) => Promise<void>>>;

let deps: Deps;

let revocations: AccountRevocation[];

const T0 = Date.UTC(2026, 8, 22, 12);

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  db = database.db;
  revocations = [];
  closeTunnel = vi.fn<(label: string) => Promise<void>>(async () => {});
  deps = {
    db,
    appUrl: "https://relay.example",
    serverUrlTemplate: "https://{label}.relay.example",
    closeTunnel,
    recordRevocation: (revocation) => revocations.push(revocation),
    tunnelConnected: null,
  };
});

afterEach(() => {
  database.close();
});

function seedUser(
  id: string,
  over: { githubLogin?: string; image?: string } = {},
): void {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: `Name ${id}`,
      email: `${id}@example.com`,
      emailVerified: true,
      image: over.image ?? null,
      githubLogin: over.githubLogin ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const ORIGIN = { clientIp: "203.0.113.7", location: "203.0.113.7" };

function startDeps(allow: (key: string) => boolean = () => true) {
  const keys: string[] = [];

  return {
    keys,
    deps: {
      ...deps,
      rateLimiter: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);

          return { success: allow(key) };
        },
      },
    },
  };
}

function startWith(clientName: unknown, now = T0) {
  return startServerLink(startDeps().deps, { clientName, ...ORIGIN }, now);
}

async function start(now = T0) {
  const started = await startWith("sawyer-mbp", now);

  if (started.status !== 200) throw new Error("link start failed");

  return started.body;
}

function linkRow(code: string) {
  return db.select().from(connectCode).where(eq(connectCode.code, code)).get();
}

function primaryServerId(userId: string): string {
  const row = db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.userId, userId))
    .get();

  if (!row) throw new Error("no server");

  return row.id;
}

describe("startServerLink", () => {
  it("issues a device code and a user code stored as an unowned server-link row", async () => {
    const started = await start();
    expect(started.deviceCode).toMatch(/^omdev_[a-z0-9]{32}$/u);
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    expect(started.verificationUrl).toBe(
      `https://relay.example/link?code=${started.userCode}`,
    );
    expect(started.expiresAt).toBe(T0 + CONNECT_CODE_TTL_MS);
    expect(started.intervalMs).toBe(LINK_POLL_INTERVAL_MS);

    expect(linkRow(started.userCode)).toMatchObject({
      purpose: "server-link",
      userId: null,
      serverId: null,
      clientName: "sawyer-mbp",
      requestLocation: "203.0.113.7",
      deviceCodeHash: await sha256Hex(started.deviceCode),
    });
  });

  it("rejects missing or oversized client names", async () => {
    for (const name of ["", 42, "x".repeat(101), "\u202e\u0007 \u200f"]) {
      expect(await startWith(name)).toEqual({
        status: 400,
        body: { error: "invalid-client-name" },
      });
    }

    expect((await startWith("x".repeat(100))).status).toBe(200);
  });

  it("strips control and bidi-control characters from the client name", async () => {
    const started = await startWith(" \u202eomnyo\u0007 desktop\u2066\u200f\n");

    if (started.status !== 200) throw new Error("link start failed");
    expect(linkRow(started.body.userCode)?.clientName).toBe("omnyo desktop");
    const apostrophe = await startWith("Sawyer’s MacBook Pro");

    if (apostrophe.status !== 200) throw new Error("link start failed");
    expect(linkRow(apostrophe.body.userCode)?.clientName).toBe(
      "Sawyer’s MacBook Pro",
    );
  });

  it("answers 429 per client IP once the rate limiter refuses", async () => {
    const { deps: limited, keys } = startDeps((key) => key !== "198.51.100.9");

    const refused = await startServerLink(
      limited,
      { clientName: "Omnyo", clientIp: "198.51.100.9", location: null },
      T0,
    );

    expect(refused).toEqual({ status: 429, body: { error: "rate-limited" } });
    expect(db.select().from(connectCode).all()).toHaveLength(0);

    const admitted = await startServerLink(
      limited,
      { clientName: "Omnyo", clientIp: "203.0.113.7", location: null },
      T0,
    );

    expect(admitted.status).toBe(200);
    expect(keys).toEqual(["198.51.100.9", "203.0.113.7"]);
  });

  it("prunes a bounded batch of long-expired, unapproved link requests", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    const staleAt =
      T0 - LINK_EXPIRED_ROW_RETENTION_MS - CONNECT_CODE_TTL_MS - 1;

    const stale = LINK_EXPIRED_ROW_PRUNE_LIMIT + 3;

    for (let index = 0; index < stale; index += 1) {
      expect((await startWith(`stale-${index}`, staleAt)).status).toBe(200);
    }

    const approvedOld = await start(staleAt);
    await approveServerLink(
      deps,
      "u1",
      approvedOld.userCode,
      { kind: "existing", serverId: primaryServerId("u1") },
      staleAt,
    );
    const recentlyExpired = await start(T0 - CONNECT_CODE_TTL_MS - 1);

    const fresh = await start(T0);

    const remaining = db
      .select({ code: connectCode.code })
      .from(connectCode)
      .all()
      .map((row) => row.code);

    expect(remaining).toHaveLength(3 + 3);
    expect(remaining).toEqual(
      expect.arrayContaining([
        approvedOld.userCode,
        recentlyExpired.userCode,
        fresh.userCode,
      ]),
    );
  });
});

describe("linkRequestOrigin", () => {
  it("uses the relay-derived client IP and shows it to the approver", () => {
    expect(
      linkRequestOrigin(
        new Headers({
          [CLIENT_IP_HEADER]: "203.0.113.7",
          "cf-connecting-ip": "198.51.100.1",
        }),
      ),
    ).toEqual({ clientIp: "203.0.113.7", location: "203.0.113.7" });
    expect(
      linkRequestOrigin(new Headers({ [CLIENT_IP_HEADER]: "2001:db8::7" })),
    ).toEqual({ clientIp: "2001:db8::7", location: "2001:db8::7" });
  });

  it("refuses a request without a valid derived client IP", () => {
    expect(linkRequestOrigin(new Headers())).toBeNull();
    expect(
      linkRequestOrigin(new Headers({ "x-forwarded-for": "203.0.113.7" })),
    ).toBeNull();
    expect(
      linkRequestOrigin(new Headers({ [CLIENT_IP_HEADER]: "unknown" })),
    ).toBeNull();
  });
});

describe("link flow", () => {
  it("goes pending, then approved with a new server", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();

    expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
      status: 200,
      body: { status: "pending" },
    });

    const view = await getLinkRequestView(
      deps,
      "u1",
      started.userCode.toLowerCase(),
      MAX_PER_ACCOUNT,
      T0,
    );

    expect(view).toMatchObject({
      state: "choose-server",
      handle: "sawyer",
      suggestedLabel: "sawyer-sawyer-mbp",
      request: {
        userCode: started.userCode,
        clientName: "sawyer-mbp",
        requestedAt: T0,
        location: "203.0.113.7",
      },
    });

    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "new", label: "sawyer-laptop" },
        T0 + 1_000,
      ),
    ).toEqual({ ok: true, serverUrl: "https://sawyer-laptop.relay.example" });

    const approved = await pollServerLink(
      deps,
      started.deviceCode,
      T0 + LINK_POLL_INTERVAL_MS,
    );

    if (approved.status !== 200 || approved.body.status !== "approved") {
      throw new Error(`expected approval, got ${JSON.stringify(approved)}`);
    }

    expect(approved.body).toMatchObject({
      handle: "sawyer-laptop",
      serverUrl: "https://sawyer-laptop.relay.example",
      tunnelUrl: "wss://sawyer-laptop.relay.example/__tunnel",
    });
    expect(approved.body.credential).toMatch(/^omnyocred_/u);

    const resolved = await resolveServerCredential(
      db,
      approved.body.credential,
    );

    expect(resolved?.server.id).toBe(approved.body.serverId);
    expect(resolved?.server.subdomain).toBe("sawyer-laptop");
    expect(resolved?.userId).toBe("u1");
    expect(closeTunnel).not.toHaveBeenCalled();
    expect(
      await getLinkRequestView(
        deps,
        "u1",
        started.userCode,
        MAX_PER_ACCOUNT,
        T0,
      ),
    ).toEqual({
      state: "approved",
      serverUrl: "https://sawyer-laptop.relay.example",
    });
  });

  it("never moves a connected server's credential or address to a link", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    db.update(server)
      .set({ credentialHash: await sha256Hex("bbcred_old") })
      .where(eq(server.id, primary))
      .run();
    const started = await start();

    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primary },
        T0,
      ),
    ).toEqual({ error: "reconnect-from-dashboard" });
    expect(linkRow(started.userCode)?.approvedAt).toBeNull();
    expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
      status: 200,
      body: { status: "pending" },
    });
    expect((await resolveServerCredential(db, "bbcred_old"))?.server.id).toBe(
      primary,
    );
    expect(closeTunnel).not.toHaveBeenCalled();

    const view = await getLinkRequestView(
      deps,
      "u1",
      started.userCode,
      MAX_PER_ACCOUNT,
      T0,
    );

    expect(view).toMatchObject({
      state: "choose-server",
      servers: [],
      usedServers: 1,
    });
  });

  it("leaves a server that was connected before to the dashboard", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const first = await start();
    await approveServerLink(
      deps,
      "u1",
      first.userCode,
      { kind: "existing", serverId: primary },
      T0,
    );
    expect((await pollServerLink(deps, first.deviceCode, T0)).status).toBe(200);
    expect(await disconnectServer(deps, "u1", primary)).toEqual({ ok: true });

    const second = await start(T0 + 1);

    expect(
      await approveServerLink(
        deps,
        "u1",
        second.userCode,
        { kind: "existing", serverId: primary },
        T0 + 1,
      ),
    ).toEqual({ error: "reconnect-from-dashboard" });
    expect(linkRow(second.userCode)?.approvedAt).toBeNull();

    const issued = await createConnectCode(deps, "u1", { serverId: primary });

    if ("error" in issued) throw new Error(issued.error);
    const redeemed = await redeemConnectCode(deps, issued.code);

    if ("error" in redeemed) throw new Error(redeemed.error);
    expect(
      (await resolveServerCredential(db, redeemed.credential))?.server.id,
    ).toBe(primary);
  });

  it("refuses to deliver onto a server that was paired after the approval", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "existing", serverId: primary },
      T0,
    );
    db.update(server)
      .set({ credentialHash: await sha256Hex("bbcred_owner") })
      .where(eq(server.id, primary))
      .run();

    expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
      status: 403,
      body: { error: "denied" },
    });
    expect((await resolveServerCredential(db, "bbcred_owner"))?.server.id).toBe(
      primary,
    );
    expect(closeTunnel).not.toHaveBeenCalled();
  });

  describe("a never-connected server that a pre-binding device would belong to", () => {
    async function seedLegacyDevice(
      userId: string,
      serverId: string,
      offsetMs: number,
    ) {
      const row = db
        .select({ createdAt: server.createdAt })
        .from(server)
        .where(eq(server.id, serverId))
        .get();

      if (!row) throw new Error("no server");

      db.insert(machine)
        .values({
          id: `legacy-${offsetMs}`,
          userId,
          credentialHash: `hash-legacy-${offsetMs}`,
          createdAt: new Date(row.createdAt.getTime() + offsetMs),
        })
        .run();
    }

    it("is not offered by the link page and cannot be approved", async () => {
      seedUser("u1");
      await claimHandle(deps, "u1", "sawyer");
      const primary = primaryServerId("u1");
      await seedLegacyDevice("u1", primary, 1000);
      const started = await start();

      expect(
        await approveServerLink(
          deps,
          "u1",
          started.userCode,
          { kind: "existing", serverId: primary },
          T0,
        ),
      ).toEqual({ error: "reconnect-from-dashboard" });
      expect(linkRow(started.userCode)?.approvedAt).toBeNull();

      expect(
        await getLinkRequestView(
          deps,
          "u1",
          started.userCode,
          MAX_PER_ACCOUNT,
          T0,
        ),
      ).toMatchObject({
        state: "choose-server",
        servers: [],
        usedServers: 1,
      });
    });

    it("gets no credential when the device appears after the approval", async () => {
      seedUser("u1");
      await claimHandle(deps, "u1", "sawyer");
      const primary = primaryServerId("u1");
      const started = await start();
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primary },
        T0,
      );
      await seedLegacyDevice("u1", primary, 1000);

      expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
        status: 403,
        body: { error: "denied" },
      });

      expect(
        db
          .select({ credentialHash: server.credentialHash })
          .from(server)
          .where(eq(server.id, primary))
          .get()?.credentialHash,
      ).toBeNull();
    });

    it("is still offered when its only pre-binding device is older than it", async () => {
      seedUser("u1");
      await claimHandle(deps, "u1", "sawyer");
      const primary = primaryServerId("u1");
      await seedLegacyDevice("u1", primary, -1000);
      const started = await start();

      expect(
        await approveServerLink(
          deps,
          "u1",
          started.userCode,
          { kind: "existing", serverId: primary },
          T0,
        ),
      ).toMatchObject({ ok: true });
    });
  });

  it("lets a user without a handle claim one before approving", async () => {
    seedUser("u1", { githubLogin: "Sawyer-Hood" });
    const started = await start();

    expect(
      await getLinkRequestView(
        deps,
        "u1",
        started.userCode,
        MAX_PER_ACCOUNT,
        T0,
      ),
    ).toMatchObject({
      state: "claim-handle",
      suggestedHandle: "sawyer-hood",
      serverUrlTemplate: "https://{label}.relay.example",
    });
    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "new", label: "sawyer-laptop" },
        T0,
      ),
    ).toEqual({ error: "no-handle" });

    await claimHandle(deps, "u1", "sawyer-hood");

    const view = await getLinkRequestView(
      deps,
      "u1",
      started.userCode,
      MAX_PER_ACCOUNT,
      T0,
    );

    if (view.state !== "choose-server") throw new Error("expected choice");
    expect(view.servers).toHaveLength(1);
    expect(view.servers[0]).toMatchObject({
      subdomain: "sawyer-hood",
      isPrimary: true,
      connected: false,
    });

    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: view.servers[0].id },
        T0,
      ),
    ).toEqual({ ok: true, serverUrl: "https://sawyer-hood.relay.example" });
    const approved = await pollServerLink(deps, started.deviceCode, T0);
    expect(approved).toMatchObject({
      status: 200,
      body: { status: "approved", handle: "sawyer-hood" },
    });
    expect(closeTunnel).not.toHaveBeenCalled();
  });

  it("refuses a second approval, including from a different account", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "mallory");
    const started = await start();

    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primaryServerId("u1") },
        T0,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await approveServerLink(
        deps,
        "u2",
        started.userCode,
        { kind: "existing", serverId: primaryServerId("u2") },
        T0,
      ),
    ).toEqual({ error: "used" });
    expect(
      await getLinkRequestView(
        deps,
        "u2",
        started.userCode,
        MAX_PER_ACCOUNT,
        T0,
      ),
    ).toEqual({ state: "used" });
    expect(
      await approveServerLink(
        deps,
        "u2",
        started.userCode,
        { kind: "new", label: "mallory-steal" },
        T0,
      ),
    ).toEqual({ error: "used" });
    expect(
      db
        .select()
        .from(server)
        .where(eq(server.subdomain, "mallory-steal"))
        .get(),
    ).toBeUndefined();
  });

  it("does not let an account approve onto another account's server", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "mallory");
    const started = await start();
    expect(
      await approveServerLink(
        deps,
        "u2",
        started.userCode,
        { kind: "existing", serverId: primaryServerId("u1") },
        T0,
      ),
    ).toEqual({ error: "not-found" });
    expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
      status: 200,
      body: { status: "pending" },
    });
  });

  it("still delivers a code approved before it expired", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "new", label: "sawyer-laptop" },
      T0 + CONNECT_CODE_TTL_MS - 1,
    );

    const late = await pollServerLink(
      deps,
      started.deviceCode,
      T0 + CONNECT_CODE_TTL_MS + LINK_POLL_INTERVAL_MS,
    );

    if (late.status !== 200 || late.body.status !== "approved") {
      throw new Error(`expected approval, got ${JSON.stringify(late)}`);
    }

    expect(
      (await resolveServerCredential(db, late.body.credential))?.server
        .subdomain,
    ).toBe("sawyer-laptop");
  });

  it("stops delivering an approved code once the delivery grace after expiry has passed", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "new", label: "sawyer-laptop" },
      T0,
    );

    expect(
      await pollServerLink(
        deps,
        started.deviceCode,
        T0 + CONNECT_CODE_TTL_MS + LINK_DELIVERY_GRACE_MS,
      ),
    ).toEqual({ status: 410, body: { error: "expired" } });
  });

  it("denies an approved, unpolled code when another link connects the server first", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const first = await start();
    const second = await start(T0 + 1);

    for (const started of [first, second]) {
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primary },
        T0 + 2,
      );
    }

    const delivered = await pollServerLink(deps, second.deviceCode, T0 + 2);

    if (delivered.status !== 200 || delivered.body.status !== "approved") {
      throw new Error("expected approval");
    }

    expect(await pollServerLink(deps, first.deviceCode, T0 + 5_000)).toEqual({
      status: 403,
      body: { error: "denied" },
    });
    expect(
      await resolveServerCredential(db, delivered.body.credential),
    ).not.toBeNull();
  });

  it("denies an approved, unpolled code when the dashboard pairs the server again", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "existing", serverId: primary },
      T0,
    );
    const issued = await createConnectCode(deps, "u1", { serverId: primary });

    if ("error" in issued) throw new Error(issued.error);
    const redeemed = await redeemConnectCode(deps, issued.code);

    if ("error" in redeemed) throw new Error(redeemed.error);

    expect(await pollServerLink(deps, started.deviceCode, T0 + 5_000)).toEqual({
      status: 403,
      body: { error: "denied" },
    });
    expect(
      await resolveServerCredential(db, redeemed.credential),
    ).not.toBeNull();
  });

  it("refuses to deliver when the server was disconnected after approval", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "existing", serverId: primary },
      T0,
    );
    expect(await disconnectServer(deps, "u1", primary)).toEqual({ ok: true });

    expect(
      await pollServerLink(deps, started.deviceCode, T0 + CONNECT_CODE_TTL_MS),
    ).toEqual({ status: 403, body: { error: "denied" } });
    expect(
      db.select().from(server).where(eq(server.id, primary)).get(),
    ).toMatchObject({ credentialHash: null, revokedAt: expect.any(Date) });
  });

  it("re-delivers a fresh credential when a poll response is lost", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();
    await approveServerLink(
      deps,
      "u1",
      started.userCode,
      { kind: "new", label: "sawyer-laptop" },
      T0,
    );
    const lost = await pollServerLink(deps, started.deviceCode, T0);

    if (lost.status !== 200 || lost.body.status !== "approved") {
      throw new Error("expected approval");
    }

    closeTunnel.mockClear();

    const retried = await pollServerLink(
      deps,
      started.deviceCode,
      T0 + LINK_POLL_INTERVAL_MS,
    );

    if (retried.status !== 200 || retried.body.status !== "approved") {
      throw new Error(`expected re-delivery, got ${JSON.stringify(retried)}`);
    }

    expect(retried.body).toMatchObject({
      serverId: lost.body.serverId,
      handle: "sawyer-laptop",
    });
    expect(retried.body.credential).not.toBe(lost.body.credential);
    expect(await resolveServerCredential(db, lost.body.credential)).toBeNull();
    expect(
      (await resolveServerCredential(db, retried.body.credential))?.server.id,
    ).toBe(lost.body.serverId);
    expect(closeTunnel).toHaveBeenCalledWith("sawyer-laptop");

    expect(
      await pollServerLink(deps, started.deviceCode, T0 + CONNECT_CODE_TTL_MS),
    ).toEqual({ status: 409, body: { error: "already-used" } });
    expect(
      (await resolveServerCredential(db, retried.body.credential))?.server.id,
    ).toBe(lost.body.serverId);
  });

  it("does not re-deliver once the owner paired the server again or disconnected it", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    const first = await start();
    await approveServerLink(
      deps,
      "u1",
      first.userCode,
      { kind: "existing", serverId: primary },
      T0,
    );
    expect((await pollServerLink(deps, first.deviceCode, T0)).status).toBe(200);

    const issued = await createConnectCode(deps, "u1", { serverId: primary });

    if ("error" in issued) throw new Error(issued.error);
    const repaired = await redeemConnectCode(deps, issued.code);

    if ("error" in repaired) throw new Error(repaired.error);

    expect(
      await pollServerLink(deps, first.deviceCode, T0 + LINK_POLL_INTERVAL_MS),
    ).toEqual({ status: 409, body: { error: "already-used" } });
    expect(
      (await resolveServerCredential(db, repaired.credential))?.server.id,
    ).toBe(primary);

    expect(await disconnectServer(deps, "u1", primary)).toEqual({ ok: true });
    expect(
      await pollServerLink(
        deps,
        first.deviceCode,
        T0 + 2 * LINK_POLL_INTERVAL_MS,
      ),
    ).toEqual({ status: 403, body: { error: "denied" } });
    expect(
      db.select().from(server).where(eq(server.id, primary)).get(),
    ).toMatchObject({ credentialHash: null });
  });

  it("expires after ten minutes for polling and approval", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();
    const expired = T0 + CONNECT_CODE_TTL_MS;

    expect(
      await getLinkRequestView(
        deps,
        "u1",
        started.userCode,
        MAX_PER_ACCOUNT,
        expired,
      ),
    ).toEqual({ state: "expired" });
    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primaryServerId("u1") },
        expired,
      ),
    ).toEqual({ error: "expired" });
    expect(await pollServerLink(deps, started.deviceCode, expired)).toEqual({
      status: 410,
      body: { error: "expired" },
    });
  });

  it("reports denial to the polling Omnyo client", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start();

    expect(await denyServerLink(deps, started.userCode, T0)).toEqual({
      ok: true,
    });
    expect(await pollServerLink(deps, started.deviceCode, T0)).toEqual({
      status: 403,
      body: { error: "denied" },
    });
    expect(await denyServerLink(deps, started.userCode, T0)).toEqual({
      error: "denied",
    });
    expect(
      await approveServerLink(
        deps,
        "u1",
        started.userCode,
        { kind: "existing", serverId: primaryServerId("u1") },
        T0,
      ),
    ).toEqual({ error: "denied" });
    expect(
      await getLinkRequestView(
        deps,
        "u1",
        started.userCode,
        MAX_PER_ACCOUNT,
        T0,
      ),
    ).toEqual({ state: "denied" });
  });

  it("answers slow-down when polled faster than the interval", async () => {
    const started = await start();
    expect((await pollServerLink(deps, started.deviceCode, T0)).status).toBe(
      200,
    );
    expect(await pollServerLink(deps, started.deviceCode, T0 + 500)).toEqual({
      status: 429,
      body: { error: "slow-down" },
    });
    expect(
      await pollServerLink(
        deps,
        started.deviceCode,
        T0 + LINK_POLL_INTERVAL_MS - 1,
      ),
    ).toEqual({ status: 429, body: { error: "slow-down" } });
    expect(
      (
        await pollServerLink(
          deps,
          started.deviceCode,
          T0 + LINK_POLL_INTERVAL_MS,
        )
      ).status,
    ).toBe(200);
  });

  it("rejects unknown device codes", async () => {
    expect(await pollServerLink(deps, "omdev_unknown", T0)).toEqual({
      status: 404,
      body: { error: "invalid-code" },
    });
    expect(await pollServerLink(deps, undefined, T0)).toEqual({
      status: 404,
      body: { error: "invalid-code" },
    });
    expect(
      await getLinkRequestView(deps, "u1", "ZZZZ-ZZZZ", MAX_PER_ACCOUNT, T0),
    ).toEqual({ state: "invalid" });
  });

  it("never redeems an approved link code through the pairing endpoint", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const started = await start(Date.now());
    await approveServerLink(deps, "u1", started.userCode, {
      kind: "existing",
      serverId: primaryServerId("u1"),
    });
    expect(await redeemConnectCode(deps, started.userCode)).toEqual({
      error: "invalid-code",
      status: 404,
    });
  });
});

describe("address suggestions", () => {
  it("offers the GitHub name when it is free and allowed", async () => {
    expect(await suggestAvailableHandle(deps.db, "Sawyer-Hood")).toBe(
      "sawyer-hood",
    );
  });

  it("generates a name when the GitHub name is short, reserved, taken or missing", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer-hood");

    expect(await suggestAvailableHandle(deps.db, "abc")).toMatch(
      /^abc-[a-z0-9]{4}$/u,
    );
    expect(await suggestAvailableHandle(deps.db, "admin")).toMatch(
      /^admin-[a-z0-9]{4}$/u,
    );
    expect(await suggestAvailableHandle(deps.db, "Sawyer_Hood")).toMatch(
      /^sawyer-hood-[a-z0-9]{4}$/u,
    );
    expect(await suggestAvailableHandle(deps.db, "github-fan")).toMatch(
      /^member-[a-z0-9]{4}$/u,
    );
    expect(await suggestAvailableHandle(deps.db, null)).toMatch(
      /^member-[a-z0-9]{4}$/u,
    );
  });

  it("refuses a name shorter than five characters", async () => {
    seedUser("u1");

    expect(await claimHandle(deps, "u1", "abcd")).toEqual({
      error: "too-short",
    });
  });

  it("offers a generated name that the claim accepts", async () => {
    seedUser("u1", { githubLogin: "abc" });
    const suggestion = await suggestAvailableHandle(deps.db, "abc");

    expect(await claimHandle(deps, "u1", suggestion)).toEqual({
      ok: true,
      handle: suggestion,
    });
  });
});

describe("label suggestions", () => {
  it("derives valid server labels from hostnames", () => {
    expect(suggestServerLabel("sawyer", "Sawyer's MacBook Pro.local")).toBe(
      "sawyer-sawyer-s-macbook-pro-lo",
    );
    expect(suggestServerLabel("sawyer", "!!!")).toBe("sawyer-computer");
  });
});

describe("getAccountMe", () => {
  it("returns the account and server for a live credential", async () => {
    seedUser("u1", { githubLogin: "sawyerhood", image: "https://img/a.png" });
    await claimHandle(deps, "u1", "sawyer");
    const primary = primaryServerId("u1");
    db.update(server)
      .set({ credentialHash: await sha256Hex("bbcred_live") })
      .where(eq(server.id, primary))
      .run();

    expect(await getAccountMe(deps, "bbcred_live")).toEqual({
      status: 200,
      body: {
        userId: "u1",
        githubLogin: "sawyerhood",
        name: "Name u1",
        avatarUrl: "https://img/a.png",
        handle: "sawyer",
        serverId: primary,
        serverLabel: "sawyer",
        serverUrl: "https://sawyer.relay.example",
        tunnelUrl: "wss://sawyer.relay.example/__tunnel",
      },
    });
  });

  it("rejects revoked and unknown credentials", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    db.update(server)
      .set({
        credentialHash: await sha256Hex("bbcred_revoked"),
        revokedAt: new Date(),
      })
      .where(eq(server.id, primaryServerId("u1")))
      .run();
    expect(await getAccountMe(deps, "bbcred_revoked")).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(await getAccountMe(deps, "")).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });
});
