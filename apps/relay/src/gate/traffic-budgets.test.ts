import { request as httpRequest } from "node:http";
import { auditLog, server } from "@omnyo/connect-db";
import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import {
  INSTALLER_SCRIPT_MAX_BYTES,
  INSTALLER_VERSION_MAX_BYTES,
} from "./gate.js";
import { issueGateCookie } from "./gate-cookie.js";
import {
  type Harness,
  type TestUser,
  cookiePair,
  send,
  startHarness,
} from "./gate-test-harness.js";
import {
  GATE_AUTH_HEADER,
  MACHINE_CREDENTIAL_HEADER,
} from "./protocol-headers.js";
import { GATE_KEY_LABEL, derivePurposeKey } from "./signed-token.js";

const MIB = 1024 * 1024;

const BUDGET_BYTES = 4096;

const DAY_MS = 24 * 60 * 60 * 1000;

const OWNER_HOST = "sawyer.relay.test";

const PREVIEW_PATH = "/preview-content/p1/cap1/app.js";

const TARBALL_PATH = "/install/omnyo-app.tgz";

const ETAG = '"sha256-current"';

let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  h = await startHarness({ env });

  return h;
}

function budgetEnv(name: string, bytes = BUDGET_BYTES): Record<string, string> {
  return { [name]: String(bytes / MIB) };
}

function ownerCookie(harnessed: Harness, owner: TestUser, host: string) {
  return cookiePair(
    issueGateCookie(
      derivePurposeKey(harnessed.config.betterAuthSecret, GATE_KEY_LABEL),
      {
        userId: owner.id,
        host,
        sessionId: owner.sessionId,
        sessionExpiresAt: harnessed.clock.now() + DAY_MS,
      },
      harnessed.clock.now(),
    ).setCookie,
  );
}

function nextUtcDay(at: number): number {
  return (Math.floor(at / DAY_MS) + 1) * DAY_MS;
}

function filled(size: number, headers: HeadersInit = {}): Response {
  return new Response(new Uint8Array(size).fill(120), {
    status: 200,
    headers,
  });
}

function streamingOrigin(
  harnessed: Harness,
  chunks: number,
): { signal: () => AbortSignal | null } {
  const chunk = new Uint8Array(1024).fill(120);
  let originSignal: AbortSignal | null = null;

  harnessed.tunnels.origin = (request) => {
    originSignal = request.signal;
    let sent = 0;

    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= chunks) {
            controller.close();

            return;
          }

          sent += 1;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  };

  return { signal: () => originSignal };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function download(
  port: number,
  host: string,
  path: string,
  clientIp: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve) => {
    let status = 0;
    let bytes = 0;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      resolve({ status, bytes });
    };

    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        agent: false,
        headers: { host, "x-forwarded-for": clientIp, ...extraHeaders },
      },
      (response) => {
        status = response.statusCode ?? 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        response.on("end", settle);
        response.on("aborted", settle);
        response.on("error", settle);
        response.on("close", settle);
      },
    );

    outgoing.on("error", settle);
    outgoing.end();
  });
}

describe("anonymous preview traffic", () => {
  it("stays out of the owner's monthly egress, so previews cannot lock the owner out", async () => {
    const harnessed = await harness({
      RELAY_USER_EGRESS_GB_PER_MONTH: "0.00001",
    });

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    const device = harnessed.addMachine(owner.id, null);

    harnessed.tunnels.origin = (request) =>
      request.path.startsWith("/preview-content/")
        ? filled(4000)
        : request.path === "/api/v1/big"
          ? filled(20_000)
          : new Response("ok", { status: 200 });

    for (let index = 0; index < 3; index += 1) {
      const preview = await send(harnessed.port, {
        host: OWNER_HOST,
        path: PREVIEW_PATH,
        forwardedFor: `198.51.100.${10 + index}`,
      });

      expect(preview.status).toBe(200);
      expect(preview.body).toHaveLength(4000);
    }

    expect(harnessed.deps.egress.usage(owner.id).bytes).toBe(0);

    const deviceCall = (path: string) =>
      send(harnessed.port, {
        host: OWNER_HOST,
        path,
        headers: { [MACHINE_CREDENTIAL_HEADER]: device.credential },
      });

    expect((await deviceCall("/api/v1/status")).status).toBe(200);
    expect(harnessed.deps.egress.usage(owner.id).bytes).toBe(2);

    expect((await deviceCall("/api/v1/big")).status).toBe(200);
    expect(harnessed.deps.egress.isOverCap(owner.id)).toBe(true);
    expect((await deviceCall("/api/v1/status")).status).toBe(429);

    const afterCap = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "198.51.100.20",
    });

    expect(afterCap.status).toBe(200);
  });

  it("keeps the owner's own cookie-carrying previews answering after a stranger spends the budget, and charges them to the owner", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_PREVIEW_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.origin = () => filled(3000);

    for (let index = 0; index < 2; index += 1) {
      await send(harnessed.port, {
        host: OWNER_HOST,
        path: PREVIEW_PATH,
        forwardedFor: "203.0.113.90",
      });
    }

    const stranger = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.91",
    });

    expect(stranger.status).toBe(429);

    const egressBefore = harnessed.deps.egress.usage(owner.id).bytes;

    const own = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "198.51.100.40",
      headers: { cookie: ownerCookie(harnessed, owner, OWNER_HOST) },
    });

    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(3000);
    expect(harnessed.deps.egress.usage(owner.id).bytes - egressBefore).toBe(
      3000,
    );
    expect(
      new Map(harnessed.tunnels.httpRequests.at(-1)?.headers ?? []).get(
        GATE_AUTH_HEADER,
      ),
    ).toBe("anonymous");

    harnessed.deps.egress.add(
      owner.id,
      harnessed.config.userEgressBytesPerMonth + 1,
    );

    const overCap = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "198.51.100.40",
      headers: { cookie: ownerCookie(harnessed, owner, OWNER_HOST) },
    });

    expect(overCap.status).toBe(429);
  });

  it("keeps the owner's cookie-less preview subresources answering after strangers spend the refusal allowance on guessed capabilities", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_PREVIEW_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.origin = (request) =>
      request.path.startsWith("/preview-content/p1/cap1/")
        ? filled(1500)
        : new Response(new Uint8Array(500).fill(120), { status: 403 });

    const statuses: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      const guess = await send(harnessed.port, {
        host: OWNER_HOST,
        path: `/preview-content/p1/guess${index}/app.js`,
        forwardedFor: `203.0.113.${120 + index}`,
      });

      statuses.push(guess.status);
    }

    expect(statuses[0]).toBe(403);
    expect(statuses.at(-1)).toBe(429);

    for (let index = 0; index < 2; index += 1) {
      const subresource = await send(harnessed.port, {
        host: OWNER_HOST,
        path: PREVIEW_PATH,
        forwardedFor: "198.51.100.50",
      });

      expect(subresource.status).toBe(200);
      expect(subresource.body).toHaveLength(1500);
    }
  });

  it("refuses with 429 and Retry-After once an account's daily preview budget is spent, across its servers, until the next UTC day", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_PREVIEW_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.addServer(owner.id, "sawyer-two");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.connect("sawyer-two");
    harnessed.tunnels.origin = () => filled(5000);

    const first = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.10",
    });

    expect(first.status).toBe(200);

    const spent = await send(harnessed.port, {
      host: "sawyer-two.relay.test",
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.11",
    });

    expect(spent.status).toBe(429);
    expect(spent.headers["retry-after"]).toBe("3600");
    expect(JSON.parse(spent.body)).toEqual({ error: "preview_budget_reached" });
    expect(harnessed.tunnels.httpRequests).toHaveLength(1);

    harnessed.clock.advance(
      nextUtcDay(harnessed.clock.now()) - harnessed.clock.now(),
    );

    const nextDay = await send(harnessed.port, {
      host: "sawyer-two.relay.test",
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.11",
    });

    expect(nextDay.status).toBe(200);
  });

  it("cuts a preview response off once the address passes twice its daily budget", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_PREVIEW_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    const origin = streamingOrigin(harnessed, 64);

    const received = await download(
      harnessed.port,
      OWNER_HOST,
      PREVIEW_PATH,
      "203.0.113.12",
    );

    expect(received.bytes).toBeLessThan(64 * 1024);
    await waitFor(() => origin.signal()?.aborted === true);
  });

  it("counts the upstream response head toward the preview budget", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_PREVIEW_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.origin = () =>
      new Response(null, {
        status: 204,
        headers: { "x-pad": "a".repeat(5000) },
      });

    const first = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.13",
    });

    expect(first.status).toBe(204);

    const second = await send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.14",
    });

    expect(second.status).toBe(429);
  });

  it("keeps an open preview response when the owner reaches the monthly cap", async () => {
    const harnessed = await harness({
      RELAY_USER_EGRESS_GB_PER_MONTH: "0.00001",
    });

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    let release: () => void = () => undefined;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    harnessed.tunnels.origin = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await held;
            controller.close();
          },
        }),
        { status: 200 },
      );

    const pending = send(harnessed.port, {
      host: OWNER_HOST,
      path: PREVIEW_PATH,
      forwardedFor: "203.0.113.15",
    });

    await waitFor(() => harnessed.gate.openStreams() === 1);
    harnessed.deps.egress.add(owner.id, 20_000);
    harnessed.gate.sweep();

    expect(harnessed.gate.openStreams()).toBe(1);
    release();
    expect((await pending).status).toBe(200);
  });
});

describe("installer traffic after a stranger spends the budget", () => {
  async function burned(): Promise<{
    harnessed: Harness;
    ownerId: string;
    machineCredential: string;
  }> {
    const harnessed = await harness(
      budgetEnv("RELAY_INSTALLER_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.addServer(owner.id, "sawyer-two");
    const worker = harnessed.addMachine(owner.id, null);
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.connect("sawyer-two");

    harnessed.tunnels.origin = (request) => {
      if (request.path === "/install/version") {
        return Response.json({
          version: "1.0.0+private.2",
          protocolVersion: 2,
        });
      }

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: { etag: ETAG } });
      }

      if (new Map(request.headers).get("if-none-match") === ETAG) {
        return new Response(null, { status: 304, headers: { etag: ETAG } });
      }

      return filled(5000, { etag: ETAG });
    };

    const burn = await send(harnessed.port, {
      host: "sawyer-two.relay.test",
      path: TARBALL_PATH,
      forwardedFor: "203.0.113.66",
    });

    expect(burn.status).toBe(200);
    expect(burn.body).toHaveLength(5000);

    const refused = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "198.51.100.77",
    });

    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBe("3600");

    return {
      harnessed,
      ownerId: owner.id,
      machineCredential: worker.credential,
    };
  }

  it("still answers the version check on every server of the account, also after a fresh burn the next day", async () => {
    const { harnessed } = await burned();
    const before = harnessed.tunnels.httpRequests.length;

    for (const host of [OWNER_HOST, "sawyer-two.relay.test"]) {
      const versionCheck = await send(harnessed.port, {
        host,
        path: "/install/version",
        forwardedFor: "198.51.100.30",
      });

      expect(versionCheck.status, host).toBe(200);
    }

    expect(harnessed.tunnels.httpRequests).toHaveLength(before + 2);

    harnessed.clock.advance(
      nextUtcDay(harnessed.clock.now()) - harnessed.clock.now(),
    );

    for (let index = 0; index < 2; index += 1) {
      await send(harnessed.port, {
        host: OWNER_HOST,
        path: TARBALL_PATH,
        forwardedFor: "203.0.113.67",
      });
    }

    const reburned = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "203.0.113.67",
    });

    expect(reburned.status).toBe(429);

    const versionCheck = await send(harnessed.port, {
      host: OWNER_HOST,
      path: "/install/version",
      forwardedFor: "198.51.100.31",
    });

    expect(versionCheck.status).toBe(200);
  });

  it("forwards a conditional tarball request and returns the origin's 304", async () => {
    const { harnessed } = await burned();

    const revalidation = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "198.51.100.32",
      headers: { "if-none-match": ETAG },
    });

    expect(revalidation.status).toBe(304);
  });

  it("serves the owner's machine past the anonymous budget and charges the owner's monthly egress instead", async () => {
    const { harnessed, ownerId, machineCredential } = await burned();
    const egressBefore = harnessed.deps.egress.usage(ownerId).bytes;

    const enrollment = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "198.51.100.33",
      headers: { [MACHINE_CREDENTIAL_HEADER]: machineCredential },
    });

    expect(enrollment.status).toBe(200);
    expect(enrollment.body).toHaveLength(5000);
    expect(enrollment.headers["content-type"]).toBe("application/octet-stream");
    expect(harnessed.deps.egress.usage(ownerId).bytes - egressBefore).toBe(
      5000,
    );

    const forwarded = harnessed.tunnels.httpRequests.at(-1);
    const headers = new Map(forwarded?.headers ?? []);

    expect(forwarded?.grant.kind).toBe("machine");
    expect(headers.get(GATE_AUTH_HEADER)).toBe("machine");
    expect(headers.has(MACHINE_CREDENTIAL_HEADER)).toBe(false);
  });

  it("answers the owner's credentialed version check past the monthly cap and treats the credentialed tarball there like an anonymous one", async () => {
    const { harnessed, ownerId, machineCredential } = await burned();
    harnessed.deps.egress.add(
      ownerId,
      harnessed.config.userEgressBytesPerMonth + 1,
    );

    const credentialed = (path: string, headers: Record<string, string> = {}) =>
      send(harnessed.port, {
        host: OWNER_HOST,
        path,
        forwardedFor: "198.51.100.34",
        headers: { [MACHINE_CREDENTIAL_HEADER]: machineCredential, ...headers },
      });

    expect((await credentialed("/install/version")).status).toBe(200);

    const tarball = await credentialed(TARBALL_PATH);

    expect(tarball.status).toBe(429);
    expect(JSON.parse(tarball.body)).toMatchObject({
      error: "installer_budget_reached",
    });
    expect(
      (await credentialed(TARBALL_PATH, { "if-none-match": ETAG })).status,
    ).toBe(304);

    harnessed.clock.advance(
      nextUtcDay(harnessed.clock.now()) - harnessed.clock.now(),
    );
    const egressBefore = harnessed.deps.egress.usage(ownerId).bytes;
    const nextDay = await credentialed(TARBALL_PATH);

    expect(nextDay.status).toBe(200);
    expect(nextDay.body).toHaveLength(5000);
    expect(harnessed.deps.egress.usage(ownerId).bytes).toBe(egressBefore);
  });

  it.each(["/install.sh", "/install.ps1", "/m/ABCD-1234", "/m/ABCD-1234.ps1"])(
    "keeps serving %s to a new machine after the tarball budget is burned, charges only the script budget and cuts it off past the script cap",
    async (path) => {
      const { harnessed } = await burned();
      harnessed.tunnels.origin = () => filled(1000);
      const requests = harnessed.tunnels.httpRequests.length;

      const attempts: Array<Record<string, string>> = [
        {},
        { "x-omnyo-enrollment": "enroll-code" },
      ];

      for (const headers of attempts) {
        const script = await send(harnessed.port, {
          host: OWNER_HOST,
          path,
          forwardedFor: "198.51.100.36",
          headers,
        });

        expect(script.status).toBe(200);
        expect(script.body).toHaveLength(1000);
      }

      expect(harnessed.tunnels.httpRequests.length - requests).toBe(2);

      const tarballAfter = await send(harnessed.port, {
        host: OWNER_HOST,
        path: TARBALL_PATH,
        forwardedFor: "198.51.100.37",
      });

      expect(tarballAfter.status).toBe(429);

      harnessed.tunnels.origin = () => filled(4 * MIB);

      const oversized = await download(
        harnessed.port,
        OWNER_HOST,
        path,
        "198.51.100.38",
        {},
      );

      expect(oversized.status).toBe(200);
      expect(oversized.bytes).toBeLessThanOrEqual(INSTALLER_SCRIPT_MAX_BYTES);
    },
  );

  it("cuts every version response off past its size cap, with or without a credential", async () => {
    const { harnessed, machineCredential } = await burned();
    harnessed.tunnels.origin = () => filled(4 * MIB);

    const requests = harnessed.tunnels.httpRequests.length;

    const attempts: Array<Record<string, string>> = [
      {},
      { [MACHINE_CREDENTIAL_HEADER]: machineCredential },
    ];

    for (const headers of attempts) {
      const version = await download(
        harnessed.port,
        OWNER_HOST,
        "/install/version",
        "198.51.100.35",
        headers,
      );

      expect(version.status).toBe(200);
      expect(version.bytes).toBeLessThanOrEqual(INSTALLER_VERSION_MAX_BYTES);
    }

    expect(harnessed.tunnels.httpRequests.length - requests).toBe(2);
  });

  it("charges HEAD requests only their headers and resets at the next UTC day", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_INSTALLER_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.origin = (request) =>
      request.method === "HEAD"
        ? new Response(null, { status: 200, headers: { etag: ETAG } })
        : filled(5000);

    for (let index = 0; index < 20; index += 1) {
      const head = await send(harnessed.port, {
        host: OWNER_HOST,
        path: TARBALL_PATH,
        method: "HEAD",
        forwardedFor: "203.0.113.68",
      });

      expect(head.status).toBe(200);
    }

    expect(
      (
        await send(harnessed.port, {
          host: OWNER_HOST,
          path: TARBALL_PATH,
          forwardedFor: "203.0.113.69",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(harnessed.port, {
          host: OWNER_HOST,
          path: TARBALL_PATH,
          forwardedFor: "203.0.113.69",
        })
      ).status,
    ).toBe(429);

    harnessed.clock.advance(
      nextUtcDay(harnessed.clock.now()) - harnessed.clock.now(),
    );

    expect(
      (
        await send(harnessed.port, {
          host: OWNER_HOST,
          path: TARBALL_PATH,
          forwardedFor: "203.0.113.69",
        })
      ).status,
    ).toBe(200);
  });
});

describe("machine credentials on installer paths", () => {
  it("refuses an invalid or another account's credential without forwarding it, and records the failure", async () => {
    const harnessed = await harness();
    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    const stranger = harnessed.addUser("mallory");
    const strangerMachine = harnessed.addMachine(stranger.id, null);

    for (const credential of [strangerMachine.credential, "not-a-credential"]) {
      for (const path of ["/install/version", TARBALL_PATH, "/install.sh"]) {
        const refused = await send(harnessed.port, {
          host: OWNER_HOST,
          path,
          forwardedFor: "198.51.100.40",
          headers: { [MACHINE_CREDENTIAL_HEADER]: credential },
        });

        expect(refused.status, path).toBe(403);
      }
    }

    expect(harnessed.tunnels.httpRequests).toHaveLength(0);

    const rows = harnessed.database.db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.action, "gate.bearer_rejected"))
      .all();

    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.detail === '{"route":"installer"}')).toBe(
      true,
    );

    for (
      let index = rows.length;
      index <= RELAY_RATE_LIMITS.failedBearer.limit;
      index += 1
    ) {
      await send(harnessed.port, {
        host: OWNER_HOST,
        path: "/install.sh",
        forwardedFor: "198.51.100.40",
        headers: { [MACHINE_CREDENTIAL_HEADER]: "not-a-credential" },
      });
    }

    const blocked = await send(harnessed.port, {
      host: OWNER_HOST,
      path: "/install.sh",
      forwardedFor: "198.51.100.40",
      headers: { [MACHINE_CREDENTIAL_HEADER]: "not-a-credential" },
    });

    expect(blocked.status).toBe(429);
    expect(
      harnessed.database.db
        .select({ rows: count() })
        .from(auditLog)
        .where(eq(auditLog.action, "gate.bearer_rejected"))
        .get()?.rows,
    ).toBe(RELAY_RATE_LIMITS.failedBearer.limit + 1);
  });
});

describe("installer budget bounds", () => {
  it("gives the servers of one account one shared budget, also after a server is revoked and replaced", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_INSTALLER_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    const labels = ["sawyer", "sawyer-b", "sawyer-c", "sawyer-d", "sawyer-e"];
    const servers = labels.map((label) => harnessed.addServer(owner.id, label));

    for (const label of labels) harnessed.tunnels.connect(label);
    harnessed.tunnels.origin = () => filled(5000);

    const first = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "203.0.113.10",
    });

    expect(first.status).toBe(200);

    for (const [index, label] of labels.slice(1).entries()) {
      const next = await send(harnessed.port, {
        host: `${label}.relay.test`,
        path: TARBALL_PATH,
        forwardedFor: `203.0.113.${20 + index}`,
      });

      expect(next.status, label).toBe(429);
    }

    const revoked = servers[4];

    if (revoked === undefined) throw new Error("missing server");
    harnessed.database.db
      .update(server)
      .set({ revokedAt: new Date(harnessed.clock.now()) })
      .where(eq(server.id, revoked.id))
      .run();
    harnessed.addServer(owner.id, "sawyer-fresh");
    harnessed.tunnels.connect("sawyer-fresh");

    const replacement = await send(harnessed.port, {
      host: "sawyer-fresh.relay.test",
      path: TARBALL_PATH,
      forwardedFor: "203.0.113.40",
    });

    expect(replacement.status).toBe(429);
  });

  it("bounds anonymous script and version bytes per account per day on their own budget, apart from the tarball's", async () => {
    const harnessed = await harness(
      budgetEnv("RELAY_INSTALLER_MB_PER_LABEL_PER_DAY"),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.addServer(owner.id, "sawyer-two");
    harnessed.tunnels.connect("sawyer");
    harnessed.tunnels.connect("sawyer-two");
    harnessed.tunnels.origin = (request) =>
      new Map(request.headers).get("if-none-match") === ETAG
        ? new Response(null, { status: 304, headers: { etag: ETAG } })
        : filled(3000);

    const statuses: number[] = [];
    let delivered = 0;

    for (let index = 0; index < 12; index += 1) {
      const response = await send(harnessed.port, {
        host: index % 2 === 0 ? OWNER_HOST : "sawyer-two.relay.test",
        path: index % 3 === 0 ? "/install/version" : `/install.sh?seg=${index}`,
        forwardedFor: `203.0.113.${100 + index}`,
      });

      statuses.push(response.status);

      if (response.status === 200) delivered += response.body.length;
    }

    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2).every((status) => status === 429)).toBe(true);
    expect(delivered).toBeLessThanOrEqual(2 * BUDGET_BYTES);

    const conditional = await send(harnessed.port, {
      host: OWNER_HOST,
      path: "/install/version",
      forwardedFor: "198.51.100.40",
      headers: { "if-none-match": ETAG },
    });

    expect(conditional.status).toBe(304);

    const tarball = await send(harnessed.port, {
      host: OWNER_HOST,
      path: TARBALL_PATH,
      forwardedFor: "198.51.100.41",
    });

    expect(tarball.status).toBe(200);

    harnessed.clock.advance(
      nextUtcDay(harnessed.clock.now()) - harnessed.clock.now(),
    );

    const nextDay = await send(harnessed.port, {
      host: OWNER_HOST,
      path: "/install.sh",
      forwardedFor: "198.51.100.42",
    });

    expect(nextDay.status).toBe(200);
  });

  it("never delivers more than twice the daily budget, however many downloads start under it", async () => {
    const budget = 64 * 1024;

    const harnessed = await harness(
      budgetEnv("RELAY_INSTALLER_MB_PER_LABEL_PER_DAY", budget),
    );

    const owner = harnessed.addUser("sawyer");
    harnessed.addServer(owner.id, "sawyer");
    harnessed.tunnels.connect("sawyer");
    const chunk = new Uint8Array(4 * 1024).fill(120);
    const concurrent = 24;
    let opened = 0;
    let release: () => void = () => undefined;

    const allOpened = new Promise<void>((resolve) => {
      release = resolve;
    });

    harnessed.tunnels.origin = () => {
      let sent = 0;
      opened += 1;

      if (opened === concurrent) release();

      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await allOpened;

            if (sent >= 16) {
              controller.close();

              return;
            }

            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    };

    const results = await Promise.all(
      Array.from({ length: concurrent }, (_, index) =>
        download(
          harnessed.port,
          OWNER_HOST,
          TARBALL_PATH,
          `198.51.100.${index + 1}`,
        ),
      ),
    );

    const admitted = results.filter((result) => result.status === 200).length;

    const delivered = results.reduce(
      (total, result) => total + result.bytes,
      0,
    );

    expect(admitted).toBeGreaterThan(1);
    expect(delivered).toBeLessThanOrEqual(2 * budget);
  });
});
