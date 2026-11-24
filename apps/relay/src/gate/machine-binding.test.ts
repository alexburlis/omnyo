import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMachineCodeForServerCredential,
  disconnectServer,
  redeemMachineCode,
  removeServer,
} from "../account/api.js";
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
import {
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  MACHINE_CREDENTIAL_HEADER,
} from "./protocol-headers.js";
import { resolveLabel } from "./resolve.js";

const HOME_HOST = "sawyer.relay.test";

const OTHER_HOST = "sawyer-two.relay.test";

let h: Harness;

let owner: TestUser;

let home: TestServer;

let other: TestServer;

let visitorIndex = 0;

beforeEach(async () => {
  h = await startHarness();
  owner = h.addUser("sawyer");
  home = h.addServer(owner.id, "sawyer");
  other = h.addServer(owner.id, "sawyer-two");
  h.tunnels.connect("sawyer");
  h.tunnels.connect("sawyer-two");
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
    host: OTHER_HOST,
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

function lastForward(): { host: string; auth: string; machineId: string } {
  const request = h.tunnels.httpRequests.at(-1);

  const header = (name: string) =>
    request?.headers.find(([key]) => key === name)?.[1] ?? "";

  return {
    host: request?.routingKey ?? "",
    auth: header(GATE_AUTH_HEADER),
    machineId: header(GATE_MACHINE_ID_HEADER),
  };
}

function deviceAddress(machineId: string, name: string): string {
  const label = assignMachineLabel(h.database.db, machineId, name);
  const resolved = label === null ? null : resolveLabel(h.database.db, label);

  if (label === null || resolved === null) throw new Error("setup: label");
  h.tunnels.connect(resolved.routingKey);

  return `${label}--3000.relay.test`;
}

describe("a device paired from one server's code", () => {
  it("is accepted at that server's address and refused at the owner's other server", async () => {
    const device = await pairDevice(home);

    expect(
      (await withCredential(HOME_HOST, "/internal/ping", device.credential))
        .status,
    ).toBe(200);
    expect(lastForward()).toEqual({
      host: "sawyer",
      auth: "machine",
      machineId: device.machineId,
    });

    const forwarded = h.tunnels.httpRequests.length;

    const refused = await withCredential(
      OTHER_HOST,
      "/internal/ping",
      device.credential,
    );

    expect(refused.status).toBe(403);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("cannot reach the other server through a desktop cookie minted from its credential", async () => {
    const device = await pairDevice(home);
    const cookie = await desktopCookie(device.credential);

    expect((await withCookie(HOME_HOST, cookie)).status).toBe(200);
    expect(lastForward()).toMatchObject({ host: "sawyer", auth: "machine" });

    const forwarded = h.tunnels.httpRequests.length;
    const refused = await withCookie(OTHER_HOST, cookie);

    expect(refused.status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("is refused on the other server's installer paths and accepted on its own", async () => {
    const device = await pairDevice(home);

    expect(
      (await withCredential(HOME_HOST, "/install/version", device.credential))
        .status,
    ).toBe(200);

    const forwarded = h.tunnels.httpRequests.length;

    expect(
      (await withCredential(OTHER_HOST, "/install/version", device.credential))
        .status,
    ).toBe(403);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("opens its own device address but not another device's", async () => {
    const pixel = await pairDevice(home);
    const tablet = await pairDevice(home);
    const pixelShare = deviceAddress(pixel.machineId, "sawyerpixel");
    const pixelCookie = await desktopCookie(pixel.credential);
    const tabletCookie = await desktopCookie(tablet.credential);

    expect((await withCookie(pixelShare, pixelCookie, "/")).status).toBe(200);
    expect(lastForward()).toMatchObject({
      auth: "machine",
      machineId: pixel.machineId,
    });

    const forwarded = h.tunnels.httpRequests.length;

    expect((await withCookie(pixelShare, tabletCookie, "/")).status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("is revoked with its server, so it is accepted nowhere, not even at its own address", async () => {
    const device = await pairDevice(other);
    const share = deviceAddress(device.machineId, "sawyerlaptop");
    const cookie = await desktopCookie(device.credential);

    expect(await disconnectServer(accountDeps(), owner.id, other.id)).toEqual({
      ok: true,
    });
    expect(await removeServer(accountDeps(), owner.id, other.id)).toEqual({
      ok: true,
    });

    expect(
      (await withCredential(HOME_HOST, "/internal/ping", device.credential))
        .status,
    ).toBe(403);
    expect((await withCookie(HOME_HOST, cookie)).status).toBe(401);
    expect((await withCookie(share, cookie, "/")).status).toBe(404);
  });

  it("keeps an in-flight request at its own server open across sweeps", async () => {
    const device = await pairDevice(home);
    let originSignal: AbortSignal | null = null;

    h.tunnels.origin = (request) => {
      originSignal = request.signal;

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64).fill(120));
          },
        }),
        { status: 200 },
      );
    };

    const response = await new Promise<{ destroy(): void }>(
      (resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: h.port,
            path: "/internal/events",
            headers: {
              host: HOME_HOST,
              "x-forwarded-for": nextVisitorIp(),
              [MACHINE_CREDENTIAL_HEADER]: device.credential,
            },
          },
          (incoming) => incoming.once("data", () => resolve(incoming)),
        );

        outgoing.on("error", reject);
        outgoing.end();
      },
    );

    h.gate.sweep();

    expect(h.gate.openStreams()).toBe(1);
    expect((originSignal as AbortSignal | null)?.aborted).toBe(false);

    response.destroy();
  });
});

describe("a device paired before servers recorded their devices", () => {
  it("keeps working at every server of its owner, by credential and by cookie", async () => {
    const legacy = h.addMachine(owner.id, null);
    const cookie = await desktopCookie(legacy.credential);

    for (const host of [HOME_HOST, OTHER_HOST]) {
      expect(
        (await withCredential(host, "/internal/ping", legacy.credential))
          .status,
        host,
      ).toBe(200);
      expect((await withCookie(host, cookie)).status, host).toBe(200);
    }
  });

  it("is still refused at another account's server", async () => {
    const stranger = h.addUser("stranger");
    h.addServer(stranger.id, "stranger");
    h.tunnels.connect("stranger");
    const legacy = h.addMachine(owner.id, null);

    expect(
      (
        await withCredential(
          "stranger.relay.test",
          "/internal/ping",
          legacy.credential,
        )
      ).status,
    ).toBe(403);
  });
});

describe("a desktop cookie minted from a server's credential", () => {
  it("opens that server's address and not the owner's other servers", async () => {
    const cookie = await desktopCookie(other.credential);

    expect((await withCookie(OTHER_HOST, cookie)).status).toBe(200);
    expect(lastForward()).toMatchObject({
      host: "sawyer-two",
      auth: "session",
    });

    const forwarded = h.tunnels.httpRequests.length;

    expect((await withCookie(HOME_HOST, cookie)).status).toBe(401);
    expect(
      (
        await send(h.port, {
          host: HOME_HOST,
          path: "/",
          forwardedFor: nextVisitorIp(),
          headers: { cookie, accept: "text/html", "sec-fetch-site": "none" },
        })
      ).status,
    ).not.toBe(200);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("opens the addresses of devices that belong to that server only", async () => {
    const own = await pairDevice(other);
    const foreign = await pairDevice(home);
    const legacy = h.addMachine(owner.id, null);
    const ownShare = deviceAddress(own.machineId, "sawyerlaptop");
    const foreignShare = deviceAddress(foreign.machineId, "sawyertablet");
    const legacyShare = deviceAddress(legacy.id, "sawyerdesk");
    const cookie = await desktopCookie(other.credential);

    expect((await withCookie(ownShare, cookie, "/")).status).toBe(200);
    expect((await withCookie(legacyShare, cookie, "/")).status).toBe(200);

    const forwarded = h.tunnels.httpRequests.length;

    expect((await withCookie(foreignShare, cookie, "/")).status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });

  it("stops working at its address once that server is removed", async () => {
    const cookie = await desktopCookie(other.credential);

    expect(await disconnectServer(accountDeps(), owner.id, other.id)).toEqual({
      ok: true,
    });

    const forwarded = h.tunnels.httpRequests.length;

    expect((await withCookie(OTHER_HOST, cookie)).status).not.toBe(200);
    expect((await withCookie(HOME_HOST, cookie)).status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(forwarded);
  });
});
