import { eq, isNull, sql } from "drizzle-orm";
import { MAX_MACHINES_PER_USER, MAX_SERVERS_PER_USER } from "../contracts.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectCode,
  labelClaim,
  machine,
  server,
  sha256Hex,
  user,
} from "@omnyo/connect-db";
import { liveMachineByHash } from "../gate/resolve.js";
import {
  type AccountRevocation,
  type Deps,
  MAX_PENDING_MACHINE_CODES,
  checkAvailability,
  claimHandle,
  createConnectCode,
  createMachineCodeForServerCredential,
  lookupMachineCodeForServerCredential,
  listMachinesForServerCredential,
  createServer,
  disconnectServer,
  removeServer,
  getAccountState,
  redeemConnectCode,
  redeemMachineCode,
  resolveServerUrlTemplate,
  revokeMachineForServerCredential,
  revokeMachine,
  MAX_DEVICE_PAIRINGS_PER_SERVER_PER_DAY,
} from "./api.js";
import { openRelayDatabase, type RelayDatabase, type RelayDb } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";

let database: RelayDatabase;

let db: RelayDb;

let closeTunnel: ReturnType<typeof vi.fn<(subdomain: string) => Promise<void>>>;

let deps: Deps;

let revocations: AccountRevocation[];

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  db = database.db;
  revocations = [];
  closeTunnel = vi.fn<(subdomain: string) => Promise<void>>(async () => {});
  deps = {
    db,
    appUrl: "https://relay.example",
    serverUrlTemplate: "https://{label}.relay.example",
    closeTunnel,
    recordRevocation: (revocation) => revocations.push(revocation),
    tunnelConnected: null,
  };
});

describe("resolveServerUrlTemplate", () => {
  it("accepts the local HTTP port without changing production defaults", () => {
    expect(resolveServerUrlTemplate(undefined, "relay.example")).toBe(
      "https://{label}.relay.example",
    );
    expect(
      resolveServerUrlTemplate(
        "http://{label}.omnyo.localhost:8787",
        "omnyo.localhost",
      ),
    ).toBe("http://{label}.omnyo.localhost:8787");
    expect(() =>
      resolveServerUrlTemplate("https://example.com/{label}", "example.com"),
    ).toThrow("under BASE_DOMAIN");
    expect(() =>
      resolveServerUrlTemplate(
        "https://{label}.attacker.example",
        "relay.example",
      ),
    ).toThrow("under BASE_DOMAIN");
  });
});

afterEach(() => {
  database.close();
});

function seedUser(id: string, githubLogin?: string): void {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: "Test",
      email: `${id}@example.com`,
      emailVerified: true,
      githubLogin: githubLogin ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("claimHandle", () => {
  it("creates the profile and the primary server (subdomain = handle)", async () => {
    seedUser("u1");
    const r = await claimHandle(deps, "u1", "Sawyer");
    expect(r).toEqual({ ok: true, handle: "sawyer" });

    const rows = db.select().from(server).where(eq(server.userId, "u1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].subdomain).toBe("sawyer");
    expect(rows[0].name).toBe("default");
  });

  it("rejects reserved, malformed, and already-taken labels", async () => {
    seedUser("u1");
    seedUser("u2");
    expect(await claimHandle(deps, "u1", "admin")).toEqual({
      error: "reserved",
    });
    expect(await claimHandle(deps, "u1", "foo--bar")).toEqual({
      error: "invalid-format",
    });
    expect(await claimHandle(deps, "u1", "ab")).toEqual({ error: "too-short" });

    await claimHandle(deps, "u1", "sawyer");
    expect(await claimHandle(deps, "u2", "sawyer")).toEqual({ error: "taken" });
  });

  it.each([
    "omnyo",
    "omnyohq",
    "stg",
    "healthcheck",
    "github",
    "abuse",
    "install",
    "postmaster",
    "omnyo-login",
    "my-0mnyo",
    "slashnew-auth",
    "github-login",
  ])("refuses the relay-reserved label %s", async (label) => {
    seedUser("u1");
    expect(await claimHandle(deps, "u1", label)).toEqual({
      error: "reserved",
    });
    expect(await checkAvailability(deps, label.toUpperCase())).toEqual({
      available: false,
      reason: "invalid",
      error: "reserved",
    });
    expect(
      db.select().from(server).where(eq(server.userId, "u1")).all(),
    ).toHaveLength(0);
  });

  it("refuses a second claim for the same account", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    expect(await claimHandle(deps, "u1", "sawyer2")).toEqual({
      error: "already-claimed",
    });
  });
});

describe("checkAvailability", () => {
  it("reports free, invalid, and taken labels distinctly", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    expect(await checkAvailability(deps, "sawyer-desktop")).toEqual({
      available: true,
      label: "sawyer-desktop",
    });
    expect(await checkAvailability(deps, "admin")).toEqual({
      available: false,
      reason: "invalid",
      error: "reserved",
    });
    expect(await checkAvailability(deps, "sawyer")).toEqual({
      available: false,
      reason: "taken",
      namespace: "handle",
    });
  });
});

describe("createServer (connect another Omnyo server)", () => {
  it("claims a new label and holds it as an offline row", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const r = await createServer(deps, "u1", "sawyer-desktop");
    expect("ok" in r && r.ok).toBe(true);

    if ("ok" in r) {
      expect(r.server.subdomain).toBe("sawyer-desktop");
      expect(r.server.isPrimary).toBe(false);
      expect(r.server.connected).toBe(false);
      expect(r.server.serverUrl).toBe("https://sawyer-desktop.relay.example");
    }
  });

  it("enforces the per-account server cap", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    for (let i = 1; i < MAX_SERVERS_PER_USER; i++) {
      expect("ok" in (await createServer(deps, "u1", `sawyer-${i}`))).toBe(
        true,
      );
    }

    expect(
      db.select().from(server).where(eq(server.userId, "u1")).all(),
    ).toHaveLength(MAX_SERVERS_PER_USER);
    expect(await createServer(deps, "u1", "sawyer-over")).toEqual({
      error: "server-limit",
    });
  });

  it.each([
    "omnyo",
    "omnyohq",
    "stg",
    "healthcheck",
    "github",
    "abuse",
    "install",
    "postmaster",
    "omnyo-login",
    "my-0mnyo",
    "slashnew-auth",
    "github-login",
  ])(
    "refuses the relay-reserved label %s for another server",
    async (label) => {
      seedUser("u1");
      await claimHandle(deps, "u1", "sawyer");
      expect(await createServer(deps, "u1", label)).toEqual({
        error: "reserved",
      });
    },
  );

  it("rejects a label already taken by another server", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await createServer(deps, "u1", "sawyer-desktop");
    expect(await createServer(deps, "u1", "sawyer-desktop")).toEqual({
      error: "taken",
    });
  });
});

describe("createConnectCode (per-server minting + reuse)", () => {
  async function primaryId(userId: string): Promise<string> {
    const rows = db
      .select()
      .from(server)
      .where(eq(server.userId, userId))
      .all();

    return rows[0].id;
  }

  it("mints a server-pair code bound to the requested server", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");

    if (!("ok" in desktop)) throw new Error("setup");

    const r = await createConnectCode(deps, "u1", {
      serverId: desktop.server.id,
    });

    if ("error" in r) throw new Error(r.error);
    expect(r.serverUrl).toBe("https://sawyer-desktop.relay.example");
    expect(r.serverId).toBe(desktop.server.id);

    const row = db
      .select()
      .from(connectCode)
      .where(eq(connectCode.code, r.code))
      .get();

    expect(row?.serverId).toBe(desktop.server.id);
    expect(row?.purpose).toBe("server-pair");
  });

  it("reuses an unexpired code instead of re-minting when reuse=true", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const id = await primaryId("u1");

    const first = await createConnectCode(deps, "u1", {
      serverId: id,
      reuse: true,
    });

    const second = await createConnectCode(deps, "u1", {
      serverId: id,
      reuse: true,
    });

    if ("error" in first || "error" in second) throw new Error("mint failed");
    expect(second.code).toBe(first.code);
    expect(db.select().from(connectCode).all()).toHaveLength(1);
  });

  it("mints a fresh code when reuse is not requested", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const id = await primaryId("u1");
    const first = await createConnectCode(deps, "u1", { serverId: id });
    const second = await createConnectCode(deps, "u1", { serverId: id });

    if ("error" in first || "error" in second) throw new Error("mint failed");
    expect(second.code).not.toBe(first.code);
    expect(db.select().from(connectCode).all()).toHaveLength(2);
  });
});

describe("redeemConnectCode (multi-server routing label)", () => {
  it("returns the redeemed server's subdomain, not the account handle", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");

    if (!("ok" in desktop)) throw new Error("setup");

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    expect(primary?.credentialHash).toBeNull();

    const minted = await createConnectCode(deps, "u1", {
      serverId: desktop.server.id,
    });

    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);

    if ("error" in result)
      throw new Error(`${result.error} (${result.status})`);

    expect(result.handle).toBe("sawyer-desktop");
    expect(result.serverId).toBe(desktop.server.id);
    expect(result.tunnelUrl).toBe(
      "wss://sawyer-desktop.relay.example/__tunnel",
    );
    expect(result.credential.startsWith("omnyocred_")).toBe(true);

    const second = db
      .select()
      .from(server)
      .where(eq(server.id, desktop.server.id))
      .get();

    expect(second?.credentialHash).toBe(await sha256Hex(result.credential));
    expect(second?.revokedAt).toBeNull();

    const primaryAfter = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    expect(primaryAfter?.credentialHash).toBeNull();
  });

  it("returns the primary handle when redeeming a primary-server code", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    const minted = await createConnectCode(deps, "u1", {
      serverId: primary!.id,
    });

    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);

    if ("error" in result)
      throw new Error(`${result.error} (${result.status})`);

    expect(result.handle).toBe("sawyer");
    expect(result.tunnelUrl).toBe("wss://sawyer.relay.example/__tunnel");
  });

  it("returns a ws tunnel URL for local Cloud", async () => {
    deps.serverUrlTemplate = "http://{label}.omnyo.localhost:42745";
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    const minted = await createConnectCode(deps, "u1", {
      serverId: primary!.id,
    });

    if ("error" in minted) throw new Error(minted.error);

    const result = await redeemConnectCode(deps, minted.code);

    if ("error" in result) throw new Error(result.error);
    expect(result.tunnelUrl).toBe("ws://sawyer.omnyo.localhost:42745/__tunnel");
  });
});

describe("disconnectServer (server-scoped)", () => {
  it("clears only the target server's credential and closes only its tunnel", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");

    if (!("ok" in desktop)) throw new Error("setup");

    db.update(server).set({ credentialHash: "hash", revokedAt: null }).run();

    const r = await disconnectServer(deps, "u1", desktop.server.id);
    expect(r).toEqual({ ok: true });
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(closeTunnel).toHaveBeenCalledWith("sawyer-desktop");
    expect(revocations).toEqual([
      {
        kind: "server",
        id: desktop.server.id,
        userId: "u1",
        credentialHash: "hash",
      },
    ]);

    const target = db
      .select()
      .from(server)
      .where(eq(server.id, desktop.server.id))
      .get();

    expect(target?.credentialHash).toBeNull();
    expect(target?.revokedAt).not.toBeNull();

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    expect(primary?.credentialHash).toBe("hash");
    expect(primary?.revokedAt).toBeNull();
  });

  it("refuses a server the caller does not own", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "other");

    const victim = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "other"))
      .get();

    expect(await disconnectServer(deps, "u1", victim!.id)).toEqual({
      error: "not-found",
    });
    expect(closeTunnel).not.toHaveBeenCalled();
  });
});

describe("removeServer (delete a never-paired row)", () => {
  it("deletes a never-paired secondary and frees its subdomain for re-claim", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");

    if (!("ok" in desktop)) throw new Error("setup");

    expect(await removeServer(deps, "u1", desktop.server.id)).toEqual({
      ok: true,
    });
    expect(
      db.select().from(server).where(eq(server.id, desktop.server.id)).get(),
    ).toBeUndefined();

    expect(await checkAvailability(deps, "sawyer-desktop")).toEqual({
      available: false,
      reason: "taken",
      namespace: "subdomain",
    });
    expect(await checkAvailability(deps, "sawyer-desktop", "u1")).toEqual({
      available: true,
      label: "sawyer-desktop",
    });

    expect(
      db.select().from(server).where(eq(server.subdomain, "sawyer")).get(),
    ).toBeDefined();
  });

  it("refuses to remove the primary (account handle) row", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    const primary = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    expect(await removeServer(deps, "u1", primary!.id)).toEqual({
      error: "is-primary",
    });
    expect(
      db.select().from(server).where(eq(server.id, primary!.id)).get(),
    ).toBeDefined();
  });

  it("refuses to remove a still-connected secondary (disconnect first)", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const desktop = await createServer(deps, "u1", "sawyer-desktop");

    if (!("ok" in desktop)) throw new Error("setup");
    db.update(server)
      .set({ credentialHash: "hash", revokedAt: null })
      .where(eq(server.id, desktop.server.id))
      .run();

    expect(await removeServer(deps, "u1", desktop.server.id)).toEqual({
      error: "connected",
    });
    expect(
      db.select().from(server).where(eq(server.id, desktop.server.id)).get(),
    ).toBeDefined();
  });

  it("refuses a server the caller does not own", async () => {
    seedUser("u1");
    seedUser("u2");
    await claimHandle(deps, "u1", "sawyer");
    await claimHandle(deps, "u2", "other");

    const victim = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "other"))
      .get();

    expect(await removeServer(deps, "u1", victim!.id)).toEqual({
      error: "not-found",
    });
  });
});

describe("getAccountState (adaptive single / multi)", () => {
  it("returns an empty account before a handle is claimed", async () => {
    seedUser("u1", "sawyerhood");
    const state = await getAccountState(deps, "u1");
    expect(state.handle).toBeNull();
    expect(state.servers).toHaveLength(0);
    expect(state.githubLogin).toBe("sawyerhood");
    expect(state.maxServers).toBe(MAX_SERVERS_PER_USER);
  });

  it("returns one server, flagged primary, after a claim", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const state = await getAccountState(deps, "u1");
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]).toMatchObject({
      subdomain: "sawyer",
      isPrimary: true,
      connected: false,
      online: false,
      serverUrl: "https://sawyer.relay.example",
    });
  });

  it("lists multiple servers with the primary first", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await createServer(deps, "u1", "sawyer-desktop");
    await createServer(deps, "u1", "sawyer-studio");

    const state = await getAccountState(deps, "u1");
    expect(state.servers.map((s) => s.subdomain)).toEqual([
      "sawyer",
      "sawyer-desktop",
      "sawyer-studio",
    ]);
    expect(state.servers[0].isPrimary).toBe(true);
    expect(state.servers.slice(1).every((s) => !s.isPrimary)).toBe(true);
  });

  it("marks a server online only when credentialed and freshly seen", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    db.update(server)
      .set({ credentialHash: "hash", revokedAt: null, lastSeenAt: new Date() })
      .run();
    const online = (await getAccountState(deps, "u1")).servers[0];
    expect(online.connected).toBe(true);
    expect(online.online).toBe(true);

    db.update(server)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
      .run();
    const stale = (await getAccountState(deps, "u1")).servers[0];
    expect(stale.connected).toBe(true);
    expect(stale.online).toBe(false);
  });
});

describe("getAccountState with tunnel objects as the liveness source", () => {
  it("reports servers and labelled machines online from their tunnel objects, not from last_seen_at", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await createServer(deps, "u1", "sawyer-desktop");
    await createServer(deps, "u1", "sawyer-unpaired");
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const fresh = new Date();
    db.update(server)
      .set({ credentialHash: "hash", revokedAt: null, lastSeenAt: stale })
      .where(eq(server.subdomain, "sawyer"))
      .run();
    db.update(server)
      .set({ credentialHash: "hash-2", revokedAt: null, lastSeenAt: fresh })
      .where(eq(server.subdomain, "sawyer-desktop"))
      .run();
    db.insert(machine)
      .values([
        {
          id: "machine-tunnel",
          userId: "u1",
          subdomain: "air",
          credentialHash: "hash-air",
          lastSeenAt: stale,
          createdAt: new Date(1),
        },
        {
          id: "machine-requests",
          userId: "u1",
          credentialHash: "hash-requests",
          lastSeenAt: fresh,
          createdAt: new Date(2),
        },
        {
          id: "machine-gone",
          userId: "u1",
          subdomain: "gone",
          credentialHash: "hash-gone",
          lastSeenAt: stale,
          createdAt: new Date(3),
        },
      ])
      .run();

    const machineRoutingKeys = Object.fromEntries(
      db
        .select()
        .from(labelClaim)
        .where(eq(labelClaim.kind, "machine"))
        .all()
        .map((claim) => [claim.label, `${claim.label}:${claim.generation}`]),
    );

    const airKey = machineRoutingKeys.air;
    const goneKey = machineRoutingKeys.gone;

    if (airKey === undefined || goneKey === undefined) {
      throw new Error("expected label claims for both labelled machines");
    }

    const asked: string[] = [];

    const answers: Record<string, boolean> = {
      sawyer: true,
      "sawyer-desktop": false,
      [airKey]: true,
      [goneKey]: false,
    };

    const state = await getAccountState(
      {
        ...deps,
        tunnelConnected: async (routingKey) => {
          asked.push(routingKey);

          return answers[routingKey] ?? null;
        },
      },
      "u1",
    );

    expect(
      Object.fromEntries(state.servers.map((s) => [s.subdomain, s.online])),
    ).toEqual({
      sawyer: true,
      "sawyer-desktop": false,
      "sawyer-unpaired": false,
    });
    expect(
      Object.fromEntries(state.machines.map((m) => [m.id, m.online])),
    ).toEqual({
      "machine-tunnel": true,
      "machine-requests": true,
      "machine-gone": false,
    });
    expect(asked.sort()).toEqual(
      [airKey, goneKey, "sawyer", "sawyer-desktop"].sort(),
    );
  });
});

describe("pairing code purposes", () => {
  it("refuses a machine code at the server redeem endpoint and leaves it usable for the machine", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const pair = await createConnectCode(deps, "u1", {});

    if ("error" in pair) throw new Error(pair.error);
    const paired = await redeemConnectCode(deps, pair.code);

    if ("error" in paired) throw new Error(paired.error);

    const machineCode = await createMachineCodeForServerCredential(
      deps,
      paired.credential,
    );

    if ("status" in machineCode) throw new Error(machineCode.error);

    expect(await redeemConnectCode(deps, machineCode.code)).toEqual({
      error: "invalid-code",
      status: 404,
    });

    const row = db
      .select()
      .from(server)
      .where(eq(server.subdomain, "sawyer"))
      .get();

    expect(row?.credentialHash).toBe(await sha256Hex(paired.credential));

    const redeemed = await redeemMachineCode(deps, machineCode.code, null);
    expect("error" in redeemed).toBe(false);
  });
});

describe("device pairings a server credential can make", () => {
  it(`stop at ${MAX_DEVICE_PAIRINGS_PER_SERVER_PER_DAY} a day for that server, even when each device is revoked, and leave the owner's other pairings alone`, async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");

    const credentialFor = async (label: string) => {
      const created = await createServer(deps, "u1", label);

      if (!("ok" in created)) throw new Error("server setup failed");
      const credential = `bbcred_${label}`;
      db.update(server)
        .set({ credentialHash: await sha256Hex(credential), revokedAt: null })
        .where(eq(server.id, created.server.id))
        .run();

      return credential;
    };

    const credential = await credentialFor("sawyer-phished");

    for (
      let index = 0;
      index < MAX_DEVICE_PAIRINGS_PER_SERVER_PER_DAY;
      index += 1
    ) {
      const minted = await createMachineCodeForServerCredential(
        deps,
        credential,
      );

      if ("status" in minted) throw new Error(minted.error);
      const redeemed = await redeemMachineCode(deps, minted.code, null);

      if ("error" in redeemed) throw new Error(redeemed.error);
      expect(
        await revokeMachineForServerCredential(
          deps,
          credential,
          redeemed.machineId,
        ),
      ).toEqual({ ok: true });
    }

    expect(
      await createMachineCodeForServerCredential(deps, credential),
    ).toEqual({ error: "pairing-limit", status: 429 });

    expect(
      await createMachineCodeForServerCredential(
        deps,
        await credentialFor("sawyer-own"),
      ),
    ).toMatchObject({ code: expect.any(String) });
  });
});

describe("server-authenticated machine-code round trip", () => {
  it.each(["Pixel 9 Pro", null])(
    "mints for the exact server and redeems a device named %s",
    async (deviceName) => {
      seedUser("u1");
      await claimHandle(deps, "u1", "sawyer");
      const target = await createServer(deps, "u1", "sawyer-desktop");

      if (!("ok" in target)) throw new Error("server setup failed");
      const serverCredential = "bbcred_server_owned";
      db.update(server)
        .set({
          credentialHash: await sha256Hex(serverCredential),
          revokedAt: null,
        })
        .where(eq(server.id, target.server.id))
        .run();

      const minted = await createMachineCodeForServerCredential(
        deps,
        serverCredential,
      );

      if ("status" in minted) throw new Error(minted.error);
      expect(minted.serverUrl).toBe("https://sawyer-desktop.relay.example");

      expect(
        await lookupMachineCodeForServerCredential(
          deps,
          serverCredential,
          minted.code,
        ),
      ).toEqual({ consumed: false, machineId: null });
      const redeemed = await redeemMachineCode(deps, minted.code, deviceName);

      if ("error" in redeemed) throw new Error(redeemed.error);
      expect(
        await lookupMachineCodeForServerCredential(
          deps,
          serverCredential,
          minted.code,
        ),
      ).toEqual({ consumed: true, machineId: redeemed.machineId });
      expect(
        await lookupMachineCodeForServerCredential(deps, "bogus", minted.code),
      ).toMatchObject({ status: 401 });
      const other = await createServer(deps, "u1", "sawyer-other");

      if (!("ok" in other)) throw new Error("server setup failed");
      db.update(server)
        .set({ credentialHash: await sha256Hex("bbcred_other") })
        .where(eq(server.id, other.server.id))
        .run();
      expect(
        await lookupMachineCodeForServerCredential(
          deps,
          "bbcred_other",
          minted.code,
        ),
      ).toMatchObject({ status: 404 });
      expect(redeemed.credential.startsWith("omnyocm_")).toBe(true);
      expect(redeemed.serverUrl).toBe("https://sawyer-desktop.relay.example");
      expect(db.select().from(machine).all()).toHaveLength(1);
      expect((await getAccountState(deps, "u1")).machines).toEqual([
        expect.objectContaining({ id: redeemed.machineId, name: deviceName }),
      ]);
      await expect(
        revokeMachineForServerCredential(
          deps,
          serverCredential,
          redeemed.machineId,
        ),
      ).resolves.toEqual({ ok: true });
      expect(
        db
          .select()
          .from(machine)
          .where(eq(machine.id, redeemed.machineId))
          .get()?.revokedAt,
      ).not.toBeNull();
      const revokedAt = db.select().from(machine).get()?.revokedAt;

      await expect(
        revokeMachineForServerCredential(
          deps,
          serverCredential,
          redeemed.machineId,
        ),
      ).resolves.toEqual({ ok: true });
      await expect(
        revokeMachineForServerCredential(
          deps,
          "bbcred_other",
          redeemed.machineId,
        ),
      ).resolves.toEqual({ error: "not-found", status: 404 });

      expect(db.select().from(machine).get()?.revokedAt).toEqual(revokedAt);
      await expect(
        revokeMachineForServerCredential(deps, serverCredential, "missing"),
      ).resolves.toEqual({ error: "not-found", status: 404 });
      seedUser("foreign");
      db.insert(machine)
        .values({
          id: "foreign-device",
          userId: "foreign",
          credentialHash: "foreign-hash",
          createdAt: new Date(),
          revokedAt: new Date(),
        })
        .run();
      await expect(
        revokeMachineForServerCredential(
          deps,
          serverCredential,
          "foreign-device",
        ),
      ).resolves.toEqual({ error: "not-found", status: 404 });

      for (const token of ["", "bogus"]) {
        await expect(
          revokeMachineForServerCredential(deps, token, redeemed.machineId),
        ).resolves.toEqual({ error: "unauthorized", status: 401 });
      }

      db.update(server)
        .set({ revokedAt: new Date() })
        .where(eq(server.id, target.server.id))
        .run();
      await expect(
        revokeMachineForServerCredential(
          deps,
          serverCredential,
          redeemed.machineId,
        ),
      ).resolves.toEqual({ error: "unauthorized", status: 401 });
      await expect(
        redeemMachineCode(deps, minted.code, null),
      ).resolves.toMatchObject({
        error: "already-used",
        status: 409,
      });
    },
  );

  it("rejects a bogus server credential", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    await expect(
      createMachineCodeForServerCredential(deps, "bbcred_bogus"),
    ).resolves.toEqual({ error: "unauthorized", status: 401 });
  });

  it("lets only the server a device is bound to revoke it, and a device paired before binding only the servers that existed before it", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const pairedServers: { id: string; credential: string }[] = [];

    for (const label of ["sawyer-desktop", "sawyer-extra"]) {
      const created = await createServer(deps, "u1", label);

      if (!("ok" in created)) throw new Error("server setup failed");
      const credential = `bbcred_${label}`;
      db.update(server)
        .set({ credentialHash: await sha256Hex(credential), revokedAt: null })
        .where(eq(server.id, created.server.id))
        .run();
      pairedServers.push({ id: created.server.id, credential });
    }

    const [owning, extra] = pairedServers;

    if (owning === undefined || extra === undefined) {
      throw new Error("server setup failed");
    }

    const minted = await createMachineCodeForServerCredential(
      deps,
      owning.credential,
    );

    if ("status" in minted) throw new Error(minted.error);
    const bound = await redeemMachineCode(deps, minted.code, null);

    if ("error" in bound) throw new Error(bound.error);

    await expect(
      revokeMachineForServerCredential(deps, extra.credential, bound.machineId),
    ).resolves.toEqual({ error: "not-found", status: 404 });
    expect(
      db.select().from(machine).where(eq(machine.id, bound.machineId)).get()
        ?.revokedAt,
    ).toBeNull();

    db.insert(machine)
      .values({
        id: "legacy-device",
        userId: "u1",
        credentialHash: "legacy-hash",
        createdAt: new Date(Date.now() + 1_000),
      })
      .run();

    await expect(
      revokeMachineForServerCredential(deps, extra.credential, "legacy-device"),
    ).resolves.toEqual({ ok: true });
    expect(
      db.select().from(machine).where(eq(machine.id, "legacy-device")).get()
        ?.revokedAt,
    ).not.toBeNull();

    await expect(
      revokeMachineForServerCredential(
        deps,
        owning.credential,
        bound.machineId,
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("dashboard machine recovery", () => {
  it("lists active machines and revokes only the owner's selected credential", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-owner",
          userId: "u1",
          name: "lost laptop",
          subdomain: "lost-laptop",
          credentialHash: "hash-owner",
          lastSeenAt: now,
          createdAt: now,
        },
        {
          id: "machine-other",
          userId: "u2",
          credentialHash: "hash-other",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "lost-generation" })
      .where(eq(labelClaim.label, "lost-laptop"))
      .run();

    expect((await getAccountState(deps, "u1")).machines).toEqual([
      {
        id: "machine-owner",
        name: "lost laptop",
        subdomain: "lost-laptop",
        online: true,
        lastSeenAt: now.getTime(),
        createdAt: now.getTime(),
      },
    ]);
    await expect(revokeMachine(deps, "u1", "machine-other")).resolves.toEqual({
      error: "not-found",
    });
    await expect(revokeMachine(deps, "u1", "machine-owner")).resolves.toEqual({
      ok: true,
    });
    expect(closeTunnel).toHaveBeenCalledWith("lost-laptop:lost-generation");
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(revocations).toEqual([
      { kind: "machine", id: "machine-owner", userId: "u1" },
    ]);
    expect((await getAccountState(deps, "u1")).machines).toEqual([]);
    await expect(revokeMachine(deps, "u1", "machine-owner")).resolves.toEqual({
      ok: true,
    });
    expect(revocations).toHaveLength(1);
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-owner")).get()
        ?.subdomain,
    ).toBeNull();
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-other")).get()
        ?.revokedAt,
    ).toBeNull();
  });

  it("marks a machine online only when freshly seen, offline when stale", async () => {
    seedUser("u1");
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000);
    db.insert(machine)
      .values([
        {
          id: "machine-fresh",
          userId: "u1",
          subdomain: "fresh-machine",
          credentialHash: "hash-fresh",
          lastSeenAt: now,
          createdAt: new Date(now.getTime() - 2000),
        },
        {
          id: "machine-stale",
          userId: "u1",
          subdomain: "stale-machine",
          credentialHash: "hash-stale",
          lastSeenAt: stale,
          createdAt: new Date(now.getTime() - 1000),
        },
        {
          id: "machine-unlabeled",
          userId: "u1",
          credentialHash: "hash-unlabeled",
          createdAt: now,
        },
      ])
      .run();

    const machines = (await getAccountState(deps, "u1")).machines;
    expect(machines.map((m) => [m.id, m.subdomain, m.online])).toEqual([
      ["machine-fresh", "fresh-machine", true],
      ["machine-stale", "stale-machine", false],
      ["machine-unlabeled", null, false],
    ]);
  });

  it("keeps a revoked label pinned when tunnel close fails", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-a",
          userId: "u1",
          subdomain: "shared-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-b",
          userId: "u2",
          credentialHash: "hash-b",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "shared-machine"))
      .run();
    closeTunnel.mockRejectedValueOnce(new Error("close unavailable"));

    await expect(revokeMachine(deps, "u1", "machine-a")).resolves.toEqual({
      error: "tunnel-close-failed",
    });
    expect(
      db.select().from(machine).where(eq(machine.id, "machine-a")).get()
        ?.subdomain,
    ).toBe("shared-machine");
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).toThrow(/unique constraint/iu);
  });

  it("retries a failed machine close during the reachable account-state sweep", async () => {
    seedUser("u1");
    seedUser("u2");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-retry",
          userId: "u1",
          subdomain: "retry-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-new",
          userId: "u1",
          credentialHash: "hash-b",
          createdAt: now,
        },
        {
          id: "machine-other",
          userId: "u2",
          credentialHash: "hash-c",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "retry-machine"))
      .run();
    closeTunnel.mockRejectedValueOnce(new Error("close unavailable"));

    await expect(revokeMachine(deps, "u1", "machine-retry")).resolves.toEqual({
      error: "tunnel-close-failed",
    });
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    await getAccountState(deps, "u1");
    expect(closeTunnel).toHaveBeenCalledTimes(2);
    expect(
      db
        .select()
        .from(labelClaim)
        .where(eq(labelClaim.label, "retry-machine"))
        .get(),
    ).toBeUndefined();
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "retry-machine" })
        .where(eq(machine.id, "machine-other"))
        .run(),
    ).toThrow(/relay label retired/u);
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "retry-machine" })
        .where(eq(machine.id, "machine-new"))
        .run(),
    ).not.toThrow();
  });

  it("does not release a label until delayed close confirms, then gives the account's next device a new generation", async () => {
    seedUser("u1");
    const now = new Date();
    db.insert(machine)
      .values([
        {
          id: "machine-a",
          userId: "u1",
          subdomain: "shared-machine",
          credentialHash: "hash-a",
          createdAt: now,
        },
        {
          id: "machine-b",
          userId: "u1",
          credentialHash: "hash-b",
          createdAt: now,
        },
      ])
      .run();
    db.update(labelClaim)
      .set({ generation: "generation-a" })
      .where(eq(labelClaim.label, "shared-machine"))
      .run();
    let confirmClose: (() => void) | undefined;
    closeTunnel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmClose = resolve;
        }),
    );

    const revocation = revokeMachine(deps, "u1", "machine-a");
    await vi.waitFor(() => expect(closeTunnel).toHaveBeenCalledTimes(1));
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).toThrow(/unique constraint/iu);

    confirmClose?.();
    await expect(revocation).resolves.toEqual({ ok: true });
    expect(() =>
      db
        .update(machine)
        .set({ subdomain: "shared-machine" })
        .where(eq(machine.id, "machine-b"))
        .run(),
    ).not.toThrow();
    expect(db.select().from(labelClaim).get()).toMatchObject({
      ownerId: "machine-b",
      generation: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
  });
});

describe("device limit", () => {
  it("refuses a new device code once the account has the maximum active devices", async () => {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const pair = await createConnectCode(deps, "u1", {});

    if ("error" in pair) throw new Error(pair.error);
    const paired = await redeemConnectCode(deps, pair.code);

    if ("error" in paired) throw new Error(paired.error);
    db.insert(machine)
      .values(
        Array.from({ length: MAX_MACHINES_PER_USER }, (_, index) => ({
          id: `machine-${index}`,
          userId: "u1",
          credentialHash: `hash-${index}`,
          createdAt: new Date(index + 1),
        })),
      )
      .run();

    expect(
      await createMachineCodeForServerCredential(deps, paired.credential),
    ).toEqual({ error: "machine-limit", status: 409 });

    db.update(machine)
      .set({ revokedAt: new Date() })
      .where(eq(machine.id, "machine-0"))
      .run();

    expect(
      await createMachineCodeForServerCredential(deps, paired.credential),
    ).toMatchObject({ code: expect.any(String) });
  });
});

describe("device pairing under load", () => {
  async function pairedServer(): Promise<{ id: string; credential: string }> {
    seedUser("u1");
    await claimHandle(deps, "u1", "sawyer");
    const pair = await createConnectCode(deps, "u1", {});

    if ("error" in pair) throw new Error(pair.error);
    const paired = await redeemConnectCode(deps, pair.code);

    if ("error" in paired) throw new Error(paired.error);

    return { id: paired.serverId, credential: paired.credential };
  }

  async function mint(credential: string): Promise<string> {
    const minted = await createMachineCodeForServerCredential(deps, credential);

    if ("status" in minted) throw new Error(minted.error);

    return minted.code;
  }

  it("admits exactly one device when parallel redeems race for the last slot", async () => {
    const paired = await pairedServer();
    db.insert(machine)
      .values(
        Array.from({ length: MAX_MACHINES_PER_USER - 1 }, (_, index) => ({
          id: `machine-${index}`,
          userId: "u1",
          credentialHash: `hash-${index}`,
          createdAt: new Date(index + 1),
        })),
      )
      .run();

    const codes = await Promise.all(
      Array.from({ length: 10 }, () => mint(paired.credential)),
    );

    const results = await Promise.all(
      codes.map((code) => redeemMachineCode(deps, code, "parallel")),
    );

    expect(results.filter((result) => "credential" in result)).toHaveLength(1);
    expect(results.filter((result) => "error" in result)).toEqual(
      Array.from({ length: 9 }, () => ({
        error: "machine-limit",
        status: 409,
      })),
    );
    expect(
      db.select().from(machine).where(isNull(machine.revokedAt)).all(),
    ).toHaveLength(MAX_MACHINES_PER_USER);
  });

  it("binds a paired device to the server that minted its code, even after that server is gone", async () => {
    const paired = await pairedServer();

    const redeemed = await redeemMachineCode(
      deps,
      await mint(paired.credential),
      "laptop",
    );

    if ("error" in redeemed) throw new Error(redeemed.error);
    const hash = await sha256Hex(redeemed.credential);

    expect(liveMachineByHash(db, hash)?.boundServerId).toBe(paired.id);

    db.delete(server).where(eq(server.id, paired.id)).run();
    db.insert(machine)
      .values({
        id: "legacy",
        userId: "u1",
        credentialHash: "legacy-hash",
        createdAt: new Date(),
      })
      .run();

    expect(liveMachineByHash(db, hash)?.boundServerId).toBe(paired.id);
    expect(liveMachineByHash(db, "legacy-hash")?.boundServerId).toBeNull();
  });

  it("caps the device codes an account can hold unredeemed", async () => {
    const paired = await pairedServer();
    const codes: string[] = [];

    for (let index = 0; index < MAX_PENDING_MACHINE_CODES; index += 1) {
      codes.push(await mint(paired.credential));
    }

    expect(
      await createMachineCodeForServerCredential(deps, paired.credential),
    ).toEqual({ error: "too-many-codes", status: 429 });

    const [first] = codes;

    if (first === undefined) throw new Error("no code minted");
    expect("credential" in (await redeemMachineCode(deps, first, null))).toBe(
      true,
    );
    const other = await createServer(deps, "u1", "sawyer-other");

    if (!("ok" in other)) throw new Error("server setup failed");
    db.update(server)
      .set({ credentialHash: await sha256Hex("bbcred_other"), revokedAt: null })
      .where(eq(server.id, other.server.id))
      .run();
    expect(
      await createMachineCodeForServerCredential(deps, "bbcred_other"),
    ).toMatchObject({ code: expect.any(String) });
  });
});

describe("server paired device list", () => {
  it("lists only non-revoked devices owned by the requesting server", async () => {
    seedUser("devices-owner");
    seedUser("devices-other");
    const createdAt = new Date("2026-11-01T00:00:00Z");
    db.insert(server)
      .values({
        id: "list-server",
        userId: "devices-owner",
        subdomain: "list-server",
        name: "Server",
        credentialHash: await sha256Hex("device-list-credential"),
        createdAt,
      })
      .run();
    db.insert(server)
      .values({
        id: "other-list-server",
        userId: "devices-owner",
        subdomain: "other-list-server",
        name: "Other server",
        createdAt,
      })
      .run();
    const recent = new Date(createdAt.getTime() + 1000);
    const old = new Date(createdAt.getTime() - 1000);
    db.insert(machine)
      .values([
        {
          id: "bound",
          userId: "devices-owner",
          credentialHash: "bound-hash",
          name: "Phone",
          createdAt: old,
          lastSeenAt: recent,
        },
        {
          id: "legacy",
          userId: "devices-owner",
          credentialHash: "legacy-hash",
          createdAt: recent,
        },
        {
          id: "old",
          userId: "devices-owner",
          credentialHash: "old-hash",
          createdAt: old,
        },
        {
          id: "other-server",
          userId: "devices-owner",
          credentialHash: "other-server-hash",
          createdAt: recent,
        },
        {
          id: "revoked",
          userId: "devices-owner",
          credentialHash: "revoked-hash",
          createdAt: recent,
          revokedAt: recent,
        },
        {
          id: "other-user",
          userId: "devices-other",
          credentialHash: "other-user-hash",
          createdAt: recent,
        },
      ])
      .run();
    db.run(
      sql`INSERT INTO relay_machine_server (machine_id, server_id, created_at) VALUES ('bound', 'list-server', ${old.getTime()}), ('other-server', 'other-list-server', ${recent.getTime()})`,
    );

    expect(
      await listMachinesForServerCredential(deps, "device-list-credential"),
    ).toEqual({
      devices: [
        {
          id: "bound",
          name: "Phone",
          lastSeenAt: recent.getTime(),
          createdAt: old.getTime(),
        },
        {
          id: "legacy",
          name: null,
          lastSeenAt: null,
          createdAt: recent.getTime(),
        },
      ],
    });
    expect(await listMachinesForServerCredential(deps, "wrong")).toEqual({
      error: "unauthorized",
      status: 401,
    });
  });
});
