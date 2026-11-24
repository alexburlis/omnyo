import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, machine, server, user } from "@omnyo/connect-db";
import {
  type Deps,
  checkAvailability,
  claimHandle,
  createServer,
  disconnectServer,
  removeServer,
  revokeMachine,
} from "../account/api.js";
import { RELAY_LABEL_LIMIT_PER_ACCOUNT } from "../reserved-labels.js";
import { deleteRelayUser } from "../user-blocks.js";
import {
  APP_URL,
  type Harness,
  type TestUser,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { assignMachineLabel } from "./machine-label.js";
import { sha256HexOf } from "./signed-token.js";

let h: Harness;

let deps: Deps;

beforeEach(async () => {
  h = await startHarness();
  deps = {
    db: h.database.db,
    appUrl: APP_URL,
    serverUrlTemplate: "https://{label}.relay.test",
    closeTunnel: async () => {},
    recordRevocation: () => {},
    tunnelConnected: null,
  };
});

afterEach(async () => {
  await h.close();
});

function linkGitHub(userId: string, githubId: string): void {
  const at = new Date(h.clock.now());

  h.database.db
    .insert(account)
    .values({
      id: randomUUID(),
      accountId: githubId,
      providerId: "github",
      userId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

function addGitHubUser(handle: string, githubId: string): TestUser {
  const created = h.addUser(handle);
  linkGitHub(created.id, githubId);

  return created;
}

function addNewcomer(login: string, githubId: string): string {
  const id = randomUUID();
  const at = new Date(h.clock.now());

  h.database.db
    .insert(user)
    .values({
      id,
      name: login,
      email: `${id}@example.test`,
      emailVerified: true,
      image: null,
      githubLogin: login,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  linkGitHub(id, githubId);

  return id;
}

async function addAndRemoveServer(userId: string, label: string) {
  const created = await createServer(deps, userId, label);

  if (!("ok" in created)) throw new Error(`setup: ${created.error}`);
  h.database.db
    .update(server)
    .set({ credentialHash: sha256HexOf(`${label}-credential`) })
    .where(eq(server.id, created.server.id))
    .run();
  expect(await disconnectServer(deps, userId, created.server.id)).toEqual({
    ok: true,
  });
  expect(await removeServer(deps, userId, created.server.id)).toEqual({
    ok: true,
  });
}

describe("released addresses stay with the GitHub account that released them", () => {
  it("never gives a removed server address to another account on any path", async () => {
    const alice = addGitHubUser("alice", "1001");
    const mallory = addGitHubUser("mallory", "2002");
    const newcomer = addNewcomer("newcomer", "3003");

    await addAndRemoveServer(alice.id, "alice-work");

    expect(await checkAvailability(deps, "alice-work")).toMatchObject({
      available: false,
      reason: "taken",
    });
    expect(await createServer(deps, mallory.id, "alice-work")).toEqual({
      error: "taken",
    });
    expect(await claimHandle(deps, newcomer, "alice-work")).toEqual({
      error: "taken",
    });
    expect(
      assignMachineLabel(
        h.database.db,
        h.addMachine(mallory.id, null).id,
        "alice-work",
      ),
    ).toBe("alice-work-2");
  });

  it("answers no one at a removed address, so anonymous installer requests reach no other account", async () => {
    const alice = addGitHubUser("alice", "1001");

    await addAndRemoveServer(alice.id, "alice-work");

    for (const path of [
      "/install/version",
      "/install/omnyo-app.tgz",
      "/install.sh",
    ]) {
      const response = await send(h.port, {
        host: "alice-work.relay.test",
        path,
        forwardedFor: "203.0.113.50",
      });

      expect(response.status, path).toBe(404);
    }

    expect(h.tunnels.httpRequests).toEqual([]);
  });

  it("keeps a revoked device address from every other account", async () => {
    const alice = addGitHubUser("alice", "1001");
    const mallory = addGitHubUser("mallory", "2002");
    const device = h.addMachine(alice.id, null);

    expect(assignMachineLabel(h.database.db, device.id, "alice-laptop")).toBe(
      "alice-laptop",
    );
    expect(await revokeMachine(deps, alice.id, device.id)).toEqual({
      ok: true,
    });

    expect(await createServer(deps, mallory.id, "alice-laptop")).toEqual({
      error: "taken",
    });
    expect(
      assignMachineLabel(
        h.database.db,
        h.addMachine(alice.id, null).id,
        "alice-laptop",
      ),
    ).toBe("alice-laptop");
  });

  it("retires every address of a deleted account, and only the same GitHub account can take them back", async () => {
    const alice = addGitHubUser("alice", "1001");
    await createServer(deps, alice.id, "alice-spare");
    assignMachineLabel(
      h.database.db,
      h.addMachine(alice.id, null).id,
      "alice-phone",
    );

    expect(
      deleteRelayUser(h.database.db, { userId: alice.id, now: h.clock.now() }),
    ).toBe(true);

    expect(
      h.database.sqlite
        .prepare(
          "SELECT label, github_id FROM relay_retired_label ORDER BY label",
        )
        .all(),
    ).toEqual([
      { label: "alice", github_id: "1001" },
      { label: "alice-phone", github_id: "1001" },
      { label: "alice-spare", github_id: "1001" },
    ]);

    const stranger = addNewcomer("stranger", "4004");

    expect(await claimHandle(deps, stranger, "alice")).toEqual({
      error: "taken",
    });

    const returning = addNewcomer("alice", "1001");

    expect(await claimHandle(deps, returning, "alice")).toEqual({
      ok: true,
      handle: "alice",
    });
    expect(await createServer(deps, returning, "alice-spare")).toMatchObject({
      ok: true,
    });
  });
});

describe("label churn limit", () => {
  it(`refuses a new address once an account holds or released ${RELAY_LABEL_LIMIT_PER_ACCOUNT}, but still returns its own`, async () => {
    const owner = addGitHubUser("churner", "5005");

    for (let index = 1; index < RELAY_LABEL_LIMIT_PER_ACCOUNT; index += 1) {
      await addAndRemoveServer(
        owner.id,
        `churn-${String(index).padStart(2, "0")}`,
      );
    }

    expect(await createServer(deps, owner.id, "churn-fresh")).toEqual({
      error: "label-limit",
    });
    expect(
      assignMachineLabel(
        h.database.db,
        h.addMachine(owner.id, null).id,
        "churn-device",
      ),
    ).toBe("churn-device");
    expect(await createServer(deps, owner.id, "churn-01")).toMatchObject({
      ok: true,
    });
  });

  it("keeps a released server address in the server and handle limit after it is reclaimed and released as a device address", async () => {
    const owner = addGitHubUser("launderer", "5007");
    const labels: string[] = [];

    for (let index = 1; index < RELAY_LABEL_LIMIT_PER_ACCOUNT; index += 1) {
      const label = `wash-${String(index).padStart(2, "0")}`;
      labels.push(label);
      await addAndRemoveServer(owner.id, label);
    }

    for (const label of labels) {
      const device = h.addMachine(owner.id, null);
      expect(assignMachineLabel(h.database.db, device.id, label)).toBe(label);
      expect(await revokeMachine(deps, owner.id, device.id)).toMatchObject({
        ok: true,
      });
    }

    expect(await createServer(deps, owner.id, "wash-fresh")).toEqual({
      error: "label-limit",
    });
    expect(
      h.database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM relay_retired_label WHERE user_id = ? AND kind = 'machine'",
        )
        .get(owner.id),
    ).toEqual({ count: 0 });
  });

  it("keeps device addresses a server credential churns out of the server and handle limit", async () => {
    const owner = addGitHubUser("phished", "5006");

    for (
      let index = 1;
      index <= RELAY_LABEL_LIMIT_PER_ACCOUNT + 5;
      index += 1
    ) {
      const device = h.addMachine(owner.id, null);
      assignMachineLabel(
        h.database.db,
        device.id,
        `churn-box-${String(index).padStart(2, "0")}`,
      );
      h.database.db
        .update(machine)
        .set({ subdomain: null, revokedAt: new Date() })
        .where(eq(machine.id, device.id))
        .run();
    }

    expect(await createServer(deps, owner.id, "phished-work")).toMatchObject({
      ok: true,
    });
    expect(
      assignMachineLabel(
        h.database.db,
        h.addMachine(owner.id, null).id,
        "own-laptop",
      ),
    ).toMatch(/^machine-[a-f0-9]{8}$/u);
  });
});
