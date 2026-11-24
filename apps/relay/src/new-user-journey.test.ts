import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { user } from "@omnyo/connect-db";
import {
  type Deps,
  claimHandle,
  createConnectCode,
  createMachineCodeForServerCredential,
  getAccountState,
  redeemConnectCode,
  redeemMachineCode,
} from "./account/api.js";
import {
  BASE_DOMAIN,
  type Harness,
  send,
  startHarness,
} from "./gate/gate-test-harness.js";

const MACHINE_HEADER = "x-omnyo-connect-machine";

interface PairedUser {
  id: string;
  handle: string;
  host: string;
  serverCredential: string;
  deviceCredentials: string[];
}

let h: Harness;

let deps: Deps;

beforeEach(async () => {
  h = await startHarness();
  deps = {
    db: h.database.db,
    appUrl: `https://${BASE_DOMAIN}`,
    serverUrlTemplate: `https://{label}.${BASE_DOMAIN}`,
    closeTunnel: async () => {},
    recordRevocation: () => {},
    tunnelConnected: null,
  };
});

afterEach(async () => {
  await h.close();
});

function signedInGitHubUser(githubLogin: string): string {
  const id = randomUUID();
  const at = new Date(h.clock.now());

  h.database.db
    .insert(user)
    .values({
      id,
      name: githubLogin,
      email: `${id}@example.test`,
      emailVerified: true,
      image: null,
      githubLogin,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  return id;
}

async function pair(
  githubLogin: string,
  deviceNames: string[],
): Promise<PairedUser> {
  const id = signedInGitHubUser(githubLogin);
  const claimed = await claimHandle(deps, id, githubLogin.toLowerCase());

  if (!("ok" in claimed)) throw new Error(`claim failed: ${claimed.error}`);

  const issued = await createConnectCode(deps, id);

  if (!("code" in issued)) throw new Error(`no code: ${issued.error}`);

  const server = await redeemConnectCode(deps, issued.code);

  if (!("credential" in server)) throw new Error(`redeem: ${server.error}`);

  const deviceCredentials: string[] = [];

  for (const deviceName of deviceNames) {
    const machineCode = await createMachineCodeForServerCredential(
      deps,
      server.credential,
    );

    if (!("code" in machineCode))
      throw new Error(`no machine code: ${machineCode.error}`);

    const device = await redeemMachineCode(deps, machineCode.code, deviceName);

    if (!("credential" in device)) throw new Error(`device: ${device.error}`);

    expect(device.handle).toBe(claimed.handle);
    expect(device.serverUrl).toBe(`https://${claimed.handle}.${BASE_DOMAIN}`);
    deviceCredentials.push(device.credential);
  }

  h.tunnels.connect(claimed.handle);

  return {
    id,
    handle: claimed.handle,
    host: `${claimed.handle}.${BASE_DOMAIN}`,
    serverCredential: server.credential,
    deviceCredentials,
  };
}

async function sessionCookie(host: string, credential: string) {
  const response = await send(h.port, {
    host,
    path: "/api/connect/desktop-session",
    method: "POST",
    headers: { [MACHINE_HEADER]: credential },
  });

  if (response.status !== 200) return null;

  const { cookie } = JSON.parse(response.body) as {
    cookie: { name: string; value: string };
  };

  return `${cookie.name}=${cookie.value}`;
}

describe("a new user's journey without operator setup", () => {
  it("gives two new users their own address and several working devices each", async () => {
    const bob = await pair("Bob-Dev", ["phone", "laptop", "worker"]);
    const carol = await pair("carol", ["phone", "tablet"]);

    expect(bob.handle).toBe("bob-dev");
    expect(carol.handle).toBe("carol");
    expect(bob.serverCredential.startsWith("omnyocred_")).toBe(true);
    expect(new Set(bob.deviceCredentials).size).toBe(3);
    expect(
      bob.deviceCredentials.every((value) => value.startsWith("omnyocm_")),
    ).toBe(true);

    const bobState = await getAccountState(deps, bob.id);

    expect(bobState.handle).toBe("bob-dev");
    expect(bobState.servers).toHaveLength(1);
    expect(bobState.machines.map((machine) => machine.name).sort()).toEqual([
      "laptop",
      "phone",
      "worker",
    ]);
    expect((await getAccountState(deps, carol.id)).machines).toHaveLength(2);

    for (const credential of [bob.serverCredential, ...bob.deviceCredentials]) {
      const cookie = await sessionCookie(bob.host, credential);

      expect(cookie).not.toBeNull();

      const reached = await send(h.port, {
        host: bob.host,
        path: "/projects",
        headers: { cookie: cookie ?? "" },
      });

      expect(reached.status).toBe(200);
    }
  });

  it("keeps one user's devices out of another user's address", async () => {
    const bob = await pair("bobby", ["phone"]);
    const carol = await pair("carol", ["phone"]);

    const carolCookie = await sessionCookie(
      carol.host,
      carol.deviceCredentials[0] ?? "",
    );

    expect(carolCookie).not.toBeNull();

    const crossCookie = await send(h.port, {
      host: bob.host,
      path: "/projects",
      headers: { cookie: carolCookie ?? "" },
    });

    expect(crossCookie.status).toBe(401);

    const crossMint = await sessionCookie(
      bob.host,
      carol.deviceCredentials[0] ?? "",
    );

    const reached = await send(h.port, {
      host: bob.host,
      path: "/projects",
      headers: { cookie: crossMint ?? "" },
    });

    expect(reached.status).toBe(401);

    const taken = await claimHandle(deps, signedInGitHubUser("bobby"), "bobby");

    expect(taken).toEqual({ error: "taken" });
  });
});
