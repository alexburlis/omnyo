import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machine } from "@omnyo/connect-db";
import { eq } from "drizzle-orm";
import {
  createConnectCode,
  createMachineCodeForServerCredential,
  createServer,
  disconnectServer,
  redeemConnectCode,
  redeemMachineCode,
  removeServer,
  revokeMachineForServerCredential,
} from "../account/api.js";
import {
  approveServerLink,
  getLinkRequestView,
  startServerLink,
} from "../account/account.js";
import { accountDepsFrom } from "../account/deps.js";
import { desktopSessionCookieName } from "./cookies.js";
import {
  type Harness,
  type TestServer,
  type TestUser,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { assignMachineLabel } from "./machine-label.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";
import { resolveLabel } from "./resolve.js";

const HOME_HOST = "sawyer.relay.test";

const LAPTOP_HOST = "sawyer-laptop.relay.test";

const LATE_HOST = "sawyer-late.relay.test";

const START = Date.UTC(2020, 0, 1);

let h: Harness;

let owner: TestUser;

let home: TestServer;

let laptop: TestServer;

let visitorIndex = 0;

beforeEach(async () => {
  h = await startHarness({ start: START });
  owner = h.addUser("sawyer");
  home = h.addServer(owner.id, "sawyer");
  laptop = h.addServer(owner.id, "sawyer-laptop");
  h.tunnels.connect("sawyer");
  h.tunnels.connect("sawyer-laptop");
});

afterEach(async () => {
  await h.close();
});

function accountDeps() {
  return accountDepsFrom({
    config: h.config,
    database: h.database,
    tunnels: h.tunnels,
    revocations: { record() {} },
  });
}

async function pairDevice(
  server: TestServer,
): Promise<{ machineId: string; credential: string }> {
  const deps = accountDeps();

  const minted = await createMachineCodeForServerCredential(
    deps,
    server.credential,
  );

  if ("status" in minted) throw new Error(`setup: ${minted.error}`);
  const redeemed = await redeemMachineCode(deps, minted.code, null);

  if ("error" in redeemed) throw new Error(`setup: ${redeemed.error}`);

  return { machineId: redeemed.machineId, credential: redeemed.credential };
}

function nextVisitorIp(): string {
  visitorIndex += 1;

  return `203.0.113.${(visitorIndex % 250) + 1}`;
}

function withCredential(host: string, path: string, credential: string) {
  return send(h.port, {
    host,
    path,
    forwardedFor: nextVisitorIp(),
    headers: { [MACHINE_CREDENTIAL_HEADER]: credential },
  });
}

async function desktopCookie(credential: string): Promise<string> {
  const minted = await send(h.port, {
    host: HOME_HOST,
    path: "/api/connect/desktop-session",
    method: "POST",
    forwardedFor: nextVisitorIp(),
    headers: { [MACHINE_CREDENTIAL_HEADER]: credential },
  });

  expect(minted.status).toBe(200);

  const body = JSON.parse(minted.body) as {
    cookie: { name: string; value: string };
  };

  expect(body.cookie.name).toBe(desktopSessionCookieName(h.config.appUrl));

  return `${body.cookie.name}=${body.cookie.value}`;
}

function withCookie(host: string, cookie: string, path = "/api/v1/threads") {
  return send(h.port, {
    host,
    path,
    forwardedFor: nextVisitorIp(),
    headers: { cookie, accept: "application/json" },
  });
}

function deviceAddress(machineId: string, name: string): string {
  const label = assignMachineLabel(h.database.db, machineId, name);
  const resolved = label === null ? null : resolveLabel(h.database.db, label);

  if (label === null || resolved === null) throw new Error("setup: label");
  h.tunnels.connect(resolved.routingKey);

  return `${label}--3000.relay.test`;
}

function addLateServer(): TestServer {
  h.clock.advance(60_000);
  const late = h.addServer(owner.id, "sawyer-late");
  h.tunnels.connect("sawyer-late");

  return late;
}

async function removeLaptop(): Promise<void> {
  expect(await disconnectServer(accountDeps(), owner.id, laptop.id)).toEqual({
    ok: true,
  });
  expect(await removeServer(accountDeps(), owner.id, laptop.id)).toEqual({
    ok: true,
  });
}

const GRANTED_LINK_LIMITER = { limit: async () => ({ success: true }) };

describe("a removed server's address, recreated while a pre-binding device still runs", () => {
  it("never hands the device to the requester, by /link or by the dashboard", async () => {
    const legacy = h.addMachine(owner.id, null);

    expect(
      (await withCredential(LAPTOP_HOST, "/install/version", legacy.credential))
        .status,
    ).toBe(200);

    await removeLaptop();

    const deps = accountDeps();

    const started = await startServerLink(
      { ...deps, rateLimiter: GRANTED_LINK_LIMITER },
      { clientName: "laptop", clientIp: "198.51.100.7", location: null },
      h.clock.now(),
    );

    if (started.status !== 200) throw new Error("setup: link start");
    const { userCode } = started.body;

    const view = await getLinkRequestView(
      deps,
      owner.id,
      userCode,
      5,
      h.clock.now(),
    );

    if (view.state !== "choose-server") throw new Error("setup: link view");
    expect(view.suggestedLabel).not.toBe("sawyer-laptop");
    expect(view.suggestedLabel).toMatch(/^sawyer-laptop-[a-z0-9]{4}$/u);

    expect(
      await approveServerLink(
        deps,
        owner.id,
        userCode,
        { kind: "new", label: "sawyer-laptop" },
        h.clock.now(),
      ),
    ).toEqual({ error: "label-retired" });

    h.clock.advance(60_000);

    const recreated = await createServer(deps, owner.id, "sawyer-laptop");

    if (!("ok" in recreated)) throw new Error(`setup: ${recreated.error}`);

    const issued = await createConnectCode(deps, owner.id, {
      serverId: recreated.server.id,
    });

    if ("error" in issued) throw new Error(`setup: ${issued.error}`);
    const redeemed = await redeemConnectCode(deps, issued.code);

    if ("error" in redeemed) throw new Error(`setup: ${redeemed.error}`);
    h.tunnels.connect("sawyer-laptop");

    const forwarded = h.tunnels.httpRequests.length;

    const refused = await withCredential(
      LAPTOP_HOST,
      "/install/version",
      legacy.credential,
    );

    expect(refused.status).toBe(403);
    expect(
      (await withCredential(LAPTOP_HOST, "/internal/ping", legacy.credential))
        .status,
    ).toBe(403);
    expect(
      (await withCookie(LAPTOP_HOST, await desktopCookie(legacy.credential)))
        .status,
    ).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);

    expect(
      (await withCredential(HOME_HOST, "/install/version", legacy.credential))
        .status,
    ).toBe(200);
  });
});

describe("a device bound to a server the owner removes", () => {
  it("is revoked with the server, so it no longer lists the account's servers", async () => {
    const bound = await pairDevice(laptop);

    const listedBefore = await withCredential(
      HOME_HOST,
      "/api/connect/servers",
      bound.credential,
    );

    expect(listedBefore.status).toBe(200);

    await removeLaptop();

    expect(
      h.database.db
        .select({ revokedAt: machine.revokedAt })
        .from(machine)
        .where(eq(machine.id, bound.machineId))
        .get()?.revokedAt,
    ).not.toBeNull();
    expect(
      (
        await withCredential(
          HOME_HOST,
          "/api/connect/servers",
          bound.credential,
        )
      ).status,
    ).toBe(401);
  });

  it("leaves the owner's other devices alone", async () => {
    const bound = await pairDevice(home);
    await removeLaptop();

    expect(
      (await withCredential(HOME_HOST, "/install/version", bound.credential))
        .status,
    ).toBe(200);
  });
});

describe("the server list a device credential reads", () => {
  it("names only the server a bound device belongs to", async () => {
    const bound = await pairDevice(laptop);

    const listed = await withCredential(
      HOME_HOST,
      "/api/connect/servers",
      bound.credential,
    );

    expect(listed.status).toBe(200);
    expect(
      (
        JSON.parse(listed.body) as { servers: { handle: string }[] }
      ).servers.map((entry) => entry.handle),
    ).toEqual(["sawyer-laptop"]);
  });

  it("names only the servers that existed when a pre-binding device paired", async () => {
    const legacy = h.addMachine(owner.id, null);
    addLateServer();

    const listed = await withCredential(
      HOME_HOST,
      "/api/connect/servers",
      legacy.credential,
    );

    expect(
      (JSON.parse(listed.body) as { servers: { handle: string }[] }).servers
        .map((entry) => entry.handle)
        .sort(),
    ).toEqual(["sawyer", "sawyer-laptop"]);
  });
});

describe("a device paired before servers recorded their devices", () => {
  it("is refused at a server created after it by credential and by cookie", async () => {
    const legacy = h.addMachine(owner.id, null);
    const cookie = await desktopCookie(legacy.credential);
    addLateServer();

    for (const host of [HOME_HOST, LAPTOP_HOST]) {
      expect(
        (await withCredential(host, "/install/version", legacy.credential))
          .status,
        host,
      ).toBe(200);
      expect((await withCookie(host, cookie)).status, host).toBe(200);
    }

    const forwarded = h.tunnels.httpRequests.length;

    for (const path of ["/install/version", "/internal/ping"]) {
      expect(
        (await withCredential(LATE_HOST, path, legacy.credential)).status,
        path,
      ).toBe(403);
    }

    expect((await withCookie(LATE_HOST, cookie)).status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("is refused at a server created after it even when the owner's older servers stay", async () => {
    const early = h.addMachine(owner.id, null);
    addLateServer();
    h.clock.advance(60_000);
    const later = h.addMachine(owner.id, null);

    expect(
      (await withCredential(LATE_HOST, "/install/version", early.credential))
        .status,
    ).toBe(403);
    expect(
      (await withCredential(LATE_HOST, "/install/version", later.credential))
        .status,
    ).toBe(200);
  });
});

describe("a desktop cookie minted from a server credential", () => {
  it("opens the addresses of pre-binding devices only for servers that existed before them", async () => {
    const legacy = h.addMachine(owner.id, null);
    const late = addLateServer();
    const share = deviceAddress(legacy.id, "sawyerdesk");

    const forwarded = h.tunnels.httpRequests.length;

    expect(
      (await withCookie(share, await desktopCookie(late.credential), "/"))
        .status,
    ).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);

    for (const server of [home, laptop]) {
      expect(
        (await withCookie(share, await desktopCookie(server.credential), "/"))
          .status,
      ).toBe(200);
    }
  });

  it("does not open the address of a device that belongs to another server", async () => {
    const boundToLaptop = await pairDevice(laptop);
    const share = deviceAddress(boundToLaptop.machineId, "sawyerphone");
    const forwarded = h.tunnels.httpRequests.length;

    expect(
      (await withCookie(share, await desktopCookie(home.credential), "/"))
        .status,
    ).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
    expect(
      (await withCookie(share, await desktopCookie(laptop.credential), "/"))
        .status,
    ).toBe(200);
  });
});

describe("a server credential revoking a device", () => {
  it("revokes a pre-binding device of a server that existed before it", async () => {
    const legacy = h.addMachine(owner.id, null);

    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        home.credential,
        legacy.id,
      ),
    ).toEqual({ ok: true });

    expect(
      (await withCredential(HOME_HOST, "/install/version", legacy.credential))
        .status,
    ).toBe(403);

    expect(
      h.database.db
        .select({ revokedAt: machine.revokedAt })
        .from(machine)
        .where(eq(machine.id, legacy.id))
        .get()?.revokedAt,
    ).not.toBeNull();
  });

  it("refuses a server created after the device and another server's bound device", async () => {
    const legacy = h.addMachine(owner.id, null);
    const bound = await pairDevice(laptop);
    const late = addLateServer();

    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        late.credential,
        legacy.id,
      ),
    ).toEqual({ error: "not-found", status: 404 });
    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        home.credential,
        bound.machineId,
      ),
    ).toEqual({ error: "not-found", status: 404 });

    for (const device of [legacy.credential, bound.credential]) {
      expect(
        (await withCredential(LAPTOP_HOST, "/install/version", device)).status,
      ).toBe(200);
    }
  });

  it("refuses another account's device", async () => {
    const stranger = h.addUser("stranger");
    const foreign = h.addMachine(stranger.id, null);

    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        home.credential,
        foreign.id,
      ),
    ).toEqual({ error: "not-found", status: 404 });
  });
});

describe("a connect code for a server with devices", () => {
  it("counts the live devices that belong to the server, connected or not", async () => {
    const legacy = h.addMachine(owner.id, null);
    await pairDevice(home);
    const elsewhere = await pairDevice(laptop);
    const gone = await pairDevice(home);

    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        home.credential,
        gone.machineId,
      ),
    ).toEqual({ ok: true });

    const connected = await createConnectCode(accountDeps(), owner.id, {
      serverId: home.id,
    });

    expect(connected).toMatchObject({
      replacesConnectedServer: true,
      takesOverDevices: 2,
    });

    expect(await disconnectServer(accountDeps(), owner.id, home.id)).toEqual({
      ok: true,
    });

    const disconnected = await createConnectCode(accountDeps(), owner.id, {
      serverId: home.id,
    });

    expect(disconnected).toMatchObject({
      replacesConnectedServer: false,
      takesOverDevices: 2,
    });

    const reused = await createConnectCode(accountDeps(), owner.id, {
      serverId: home.id,
      reuse: true,
    });

    expect(reused).toMatchObject({ takesOverDevices: 2 });

    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        laptop.credential,
        elsewhere.machineId,
      ),
    ).toEqual({ ok: true });
    expect(
      await revokeMachineForServerCredential(
        accountDeps(),
        laptop.credential,
        legacy.id,
      ),
    ).toEqual({ ok: true });

    expect(
      await createConnectCode(accountDeps(), owner.id, { serverId: home.id }),
    ).toMatchObject({ takesOverDevices: 1 });
  });

  it("counts no pre-binding device for a server created after it", async () => {
    h.addMachine(owner.id, null);
    const late = addLateServer();

    expect(
      await createConnectCode(accountDeps(), owner.id, { serverId: late.id }),
    ).toMatchObject({ takesOverDevices: 0 });
  });
});
