import { and, count, eq } from "drizzle-orm";
import { auditLog } from "@omnyo/connect-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import {
  type Harness,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import {
  REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW,
  REJECTED_CREDENTIAL_ROWS_PER_WINDOW,
  TUNNEL_DIAL_ROWS_PER_USER_PER_WINDOW,
} from "./gate.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";

const OWNER_HOST = "sawyer.relay.test";

const SHARED_IP = "203.0.113.200";

const HOUR_MS = 60 * 60 * 1000;

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function auditRows(action: string): number {
  return (
    h.database.db
      .select({ rows: count() })
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .get()?.rows ?? 0
  );
}

async function dial(
  credential: string,
  clientIp: string,
  host = OWNER_HOST,
): Promise<number> {
  const result = await openWs(h.port, {
    host,
    path: "/__tunnel?v=1",
    headers: {
      authorization: `Bearer ${credential}`,
      "x-forwarded-for": clientIp,
    },
  });

  result.socket?.close();

  return result.status;
}

async function wrongAccountCredential(clientIp: string): Promise<number> {
  const result = await send(h.port, {
    host: "nobody-here.relay.test",
    path: "/api/connect/servers",
    headers: { [MACHINE_CREDENTIAL_HEADER]: "wrong" },
    forwardedFor: clientIp,
  });

  return result.status;
}

async function blockAddress(clientIp: string): Promise<void> {
  const statuses: number[] = [];

  for (let index = 0; index <= RELAY_RATE_LIMITS.failedBearer.limit; index += 1)
    statuses.push(await wrongAccountCredential(clientIp));

  expect(statuses.every((status) => status === 401)).toBe(true);
  expect(await wrongAccountCredential(clientIp)).toBe(429);
}

describe("valid credentials from an address another party got blocked", () => {
  it("admits the owner's dial, machine API call and account route, and keeps refusing wrong credentials there", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");
    const phone = h.addMachine(owner.id, null);
    h.tunnels.connect("sawyer");

    await blockAddress(SHARED_IP);
    const rowsWhileBlocked = auditRows("gate.bearer_rejected");

    expect(await dial(paired.credential, SHARED_IP)).toBe(101);

    const machineCall = await send(h.port, {
      host: OWNER_HOST,
      path: "/api/v1/status",
      headers: { [MACHINE_CREDENTIAL_HEADER]: phone.credential },
      forwardedFor: SHARED_IP,
    });

    expect(machineCall.status).toBe(200);

    const listing = await send(h.port, {
      host: OWNER_HOST,
      path: "/api/connect/servers",
      headers: { [MACHINE_CREDENTIAL_HEADER]: paired.credential },
      forwardedFor: SHARED_IP,
    });

    expect(listing.status).toBe(200);

    expect(await dial("not-the-credential", SHARED_IP)).toBe(429);

    const wrongMachine = await send(h.port, {
      host: OWNER_HOST,
      path: "/api/v1/status",
      headers: { [MACHINE_CREDENTIAL_HEADER]: "not-the-credential" },
      forwardedFor: SHARED_IP,
    });

    expect(wrongMachine.status).toBe(429);
    expect(auditRows("gate.bearer_rejected")).toBe(rowsWhileBlocked);
  });

  it("keeps admitting the owner while the other party repeats its failures every minute", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");
    const observed: number[] = [];

    for (let minute = 0; minute < 3; minute += 1) {
      await blockAddress(SHARED_IP);
      observed.push(await dial(paired.credential, SHARED_IP));
      h.clock.advance(60_001);
    }

    expect(observed).toEqual([101, 101, 101]);
  });

  it("admits the owner's dial after the other party spent the per-IP dial bucket on an unknown address", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");

    for (
      let index = 0;
      index < RELAY_RATE_LIMITS.tunnelDialPerIp.limit;
      index += 1
    ) {
      const unknown = await openWs(h.port, {
        host: "nobody-here.relay.test",
        path: "/__tunnel?v=1",
        headers: { "x-forwarded-for": SHARED_IP },
      });

      expect(unknown.status).toBe(404);
    }

    const throttled = await openWs(h.port, {
      host: "nobody-here.relay.test",
      path: "/__tunnel?v=1",
      headers: { "x-forwarded-for": SHARED_IP },
    });

    expect(throttled.status).toBe(429);
    expect(await dial(paired.credential, SHARED_IP)).toBe(101);
  });
});

describe("rejected-credential audit rows", () => {
  it("records at most a few rows per address each hour", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");

    for (let attempt = 0; attempt < 40; attempt += 1)
      await wrongAccountCredential("203.0.113.77");

    expect(auditRows("gate.bearer_rejected")).toBe(
      REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW,
    );
  });

  it("still records a new address's failures after many other addresses failed this hour", async () => {
    for (let index = 0; index < 12; index += 1)
      await blockAddress(`198.18.2.${index + 1}`);

    const before = auditRows("gate.bearer_rejected");

    await wrongAccountCredential("203.0.113.200");

    expect(auditRows("gate.bearer_rejected")).toBe(before + 1);
  });

  it("keeps one address to one allowance under a concurrent burst that mixes routes", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");
    const clientIp = "198.51.100.90";

    const machineApi = () =>
      send(h.port, {
        host: OWNER_HOST,
        path: "/api/v1/status",
        forwardedFor: clientIp,
        headers: { [MACHINE_CREDENTIAL_HEADER]: "not-a-credential" },
      }).then((result) => result.status);

    const statuses = await Promise.all([
      ...Array.from({ length: 30 }, machineApi),
      ...Array.from({ length: 30 }, () => wrongAccountCredential(clientIp)),
    ]);

    expect(auditRows("gate.bearer_rejected")).toBeLessThanOrEqual(
      RELAY_RATE_LIMITS.failedBearer.limit + 1,
    );
    expect(
      statuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(60 - RELAY_RATE_LIMITS.failedBearer.limit - 1);
  });

  it("caps rows across all addresses each hour and logs the unrecorded rest as one count", async () => {
    const addresses =
      Math.ceil(
        REJECTED_CREDENTIAL_ROWS_PER_WINDOW /
          REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW,
      ) + 2;

    const perAddress = RELAY_RATE_LIMITS.failedBearer.limit + 1;

    for (let index = 0; index < addresses; index += 1)
      await blockAddress(`198.18.${index >> 8}.${(index & 0xff) + 1}`);

    expect(auditRows("gate.bearer_rejected")).toBe(
      REJECTED_CREDENTIAL_ROWS_PER_WINDOW,
    );

    h.gate.sweep();
    expect(
      h.logs.filter(
        (record) => record.event === "gate.bearer_rejections_unrecorded",
      ),
    ).toHaveLength(0);

    h.clock.advance(HOUR_MS);
    h.gate.sweep();
    h.gate.sweep();

    const unrecorded = h.logs.filter(
      (record) => record.event === "gate.bearer_rejections_unrecorded",
    );

    expect(unrecorded).toHaveLength(1);
    expect(unrecorded[0]?.fields.count).toBe(
      addresses * perAddress - REJECTED_CREDENTIAL_ROWS_PER_WINDOW,
    );
    expect(unrecorded[0]?.level).toBe("warn");

    await wrongAccountCredential("198.18.9.1");
    expect(auditRows("gate.bearer_rejected")).toBe(
      REJECTED_CREDENTIAL_ROWS_PER_WINDOW + 1,
    );
  });

  it("keeps one address under the hourly cap however long it keeps failing", async () => {
    for (let minute = 0; minute < 60; minute += 1) {
      for (let attempt = 0; attempt < 12; attempt += 1)
        await wrongAccountCredential("198.51.100.77");

      h.clock.advance(61_000);
    }

    expect(auditRows("gate.bearer_rejected")).toBeLessThanOrEqual(
      REJECTED_CREDENTIAL_ROWS_PER_CLIENT_PER_WINDOW,
    );
  });

  it("forgets expired failure blocks on the sweep", async () => {
    await blockAddress("198.51.100.81");
    await blockAddress("198.51.100.82");

    expect(h.gate.failureBlocks()).toBe(2);

    h.gate.sweep();
    expect(h.gate.failureBlocks()).toBe(2);

    h.clock.advance(60_001);
    h.gate.sweep();
    expect(h.gate.failureBlocks()).toBe(0);
    expect(await wrongAccountCredential("198.51.100.81")).toBe(401);
  });
});

describe("successful tunnel dials", () => {
  it("records the owner, address and client IP, once per IP and at most four IPs per address each hour", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");

    for (const clientIp of [
      "198.51.100.1",
      "198.51.100.1",
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4",
      "198.51.100.5",
    ]) {
      expect(await dial(paired.credential, clientIp)).toBe(101);
    }

    const rows = h.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "gate.tunnel_dialed"))
      .all();

    expect(rows.map((row) => row.ipAddress)).toEqual([
      "198.51.100.1",
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4",
    ]);
    expect(rows.every((row) => row.userId === owner.id)).toBe(true);
    expect(JSON.parse(rows[0]?.detail ?? "null")).toEqual({
      label: "sawyer",
      kind: "server",
    });

    h.clock.advance(HOUR_MS);
    expect(await dial(paired.credential, "198.51.100.1")).toBe(101);
    expect(auditRows("gate.tunnel_dialed")).toBe(5);
  });

  it("counts every address in one IPv6 /64 as one client", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");

    for (let index = 1; index <= 6; index += 1) {
      expect(await dial(paired.credential, `2001:db8:1:1::${index}`)).toBe(101);
    }

    expect(auditRows("gate.tunnel_dialed")).toBe(1);
  });

  it(`records at most ${TUNNEL_DIAL_ROWS_PER_USER_PER_WINDOW} dial rows per account each hour across all its addresses`, async () => {
    const owner = h.addUser("sawyer");

    const servers = ["sawyer", "sawyer-one", "sawyer-two"].map((label) =>
      h.addServer(owner.id, label),
    );

    for (const [index, paired] of servers.entries()) {
      for (let client = 1; client <= 4; client += 1) {
        expect(
          await dial(
            paired.credential,
            `198.51.100.${index * 10 + client}`,
            `${paired.label}.relay.test`,
          ),
        ).toBe(101);
      }
    }

    expect(auditRows("gate.tunnel_dialed")).toBe(
      TUNNEL_DIAL_ROWS_PER_USER_PER_WINDOW,
    );
  });

  it("records no dial row for a refused dial", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");

    expect(await dial("not-the-credential", "198.51.100.9")).toBe(401);
    expect(auditRows("gate.tunnel_dialed")).toBe(0);
    expect(
      h.database.db
        .select({ rows: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "gate.bearer_rejected"),
            eq(auditLog.ipAddress, "198.51.100.9"),
          ),
        )
        .get()?.rows,
    ).toBe(1);
  });
});

describe("the failure block", () => {
  it("covers a whole IPv6 /64, as the rate limits do", async () => {
    await blockAddress("2001:db8:1:2::10");

    expect(await wrongAccountCredential("2001:db8:1:2::99")).toBe(429);
    expect(await wrongAccountCredential("2001:db8:1:3::10")).toBe(401);
  });
});
