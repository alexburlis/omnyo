import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_LABEL_LIMIT_PER_ACCOUNT } from "../reserved-labels.js";
import {
  type Harness,
  type TestMachine,
  type TestUser,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";

const HOST = "sawyer.relay.test";

let h: Harness;

let owner: TestUser;

let device: TestMachine;

beforeEach(async () => {
  h = await startHarness();
  owner = h.addUser("sawyer");
  h.addServer(owner.id, "sawyer");
  device = h.addMachine(owner.id, null);
});

afterEach(async () => {
  await h.close();
});

function requestLabel(desiredName: string) {
  return send(h.port, {
    host: HOST,
    path: "/api/connect/machine-label",
    method: "POST",
    headers: {
      [MACHINE_CREDENTIAL_HEADER]: device.credential,
      "content-type": "application/json",
    },
    body: JSON.stringify({ desiredName }),
  });
}

describe("/api/connect/machine-label", () => {
  it("assigns a device address while the account has room", async () => {
    const response = await requestLabel("sawyer laptop");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ label: "sawyer-laptop" });
  });

  it("assigns a device address after the account used every server address, and keeps the credential", async () => {
    const at = h.clock.now();

    for (let index = 0; index < RELAY_LABEL_LIMIT_PER_ACCOUNT; index += 1) {
      h.database.db.run(
        sql`INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (${`retired-${index}`}, 'server', NULL, ${owner.id}, ${at})`,
      );
    }

    const assigned = await requestLabel("sawyer laptop");

    expect(assigned.status).toBe(200);
    expect(JSON.parse(assigned.body)).toEqual({ label: "sawyer-laptop" });

    const listed = await send(h.port, {
      host: HOST,
      path: "/api/connect/servers",
      headers: { [MACHINE_CREDENTIAL_HEADER]: device.credential },
    });

    expect(listed.status).toBe(200);
  });

  it("assigns the generated device address once the account used every named device address", async () => {
    const at = h.clock.now();

    for (let index = 0; index < RELAY_LABEL_LIMIT_PER_ACCOUNT; index += 1) {
      h.database.db.run(
        sql`INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (${`old-device-${index}`}, 'machine', NULL, ${owner.id}, ${at})`,
      );
    }

    const assigned = await requestLabel("sawyer laptop");

    expect(assigned.status).toBe(200);
    expect(JSON.parse(assigned.body)).toEqual({
      label: expect.stringMatching(/^machine-[a-f0-9]{8}$/u),
    });
  });

  it("refuses the credential of a suspended owner and assigns no address", async () => {
    h.database.db.run(
      sql`INSERT INTO relay_suspension (github_id, user_id, blocked_at, reason) VALUES (NULL, ${owner.id}, ${h.clock.now()}, 'test')`,
    );

    const response = await requestLabel("sawyer laptop");

    expect(response.status).toBe(401);

    expect(
      h.database.sqlite
        .prepare("SELECT subdomain FROM machine WHERE id = ?")
        .get(device.id),
    ).toEqual({ subdomain: null });
  });
});
