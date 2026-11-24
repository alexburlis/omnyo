import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_RATE_LIMITS } from "../contracts.js";
import {
  type Harness,
  openWs,
  send,
  startHarness,
} from "./gate-test-harness.js";
import { GATE_REAUTH_HEADER } from "./protocol-headers.js";

const OWNER_HOST = "sawyer.relay.test";

let h: Harness;

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dialTunnel(credential: string, clientIp: string) {
  return openWs(h.port, {
    host: OWNER_HOST,
    path: "/__tunnel?v=1",
    headers: {
      authorization: `Bearer ${credential}`,
      "x-forwarded-for": clientIp,
    },
  });
}

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("tunnel dial throttling", () => {
  it("never lets wrong-credential dials throttle the owner's dial", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");
    const wrongDials = RELAY_RATE_LIMITS.tunnelDialPerLabel.limit * 3;

    for (let index = 0; index < wrongDials; index += 1) {
      const attempt = await dialTunnel(
        "not-the-credential",
        `203.0.113.${index % 10}`,
      );

      expect(attempt.status, `wrong dial ${index}`).toBe(401);
    }

    const real = await dialTunnel(paired.credential, "198.51.100.20");

    expect(real.status).toBe(101);
    real.socket?.close();
    expect(h.tunnels.attachments).toHaveLength(1);
  });

  it("refuses wrong dials from a blocked IP, still admits the correct credential there, and limits correct dials per label", async () => {
    const owner = h.addUser("sawyer");
    const paired = h.addServer(owner.id, "sawyer");

    for (
      let index = 0;
      index <= RELAY_RATE_LIMITS.failedBearer.limit;
      index += 1
    ) {
      await dialTunnel("not-the-credential", "203.0.113.50");
    }

    const blocked = await dialTunnel("not-the-credential", "203.0.113.50");
    expect(blocked.status).toBe(429);

    const shared = await dialTunnel(paired.credential, "203.0.113.50");
    expect(shared.status).toBe(101);
    shared.socket?.close();

    const limit = RELAY_RATE_LIMITS.tunnelDialPerLabel.limit - 1;

    for (let index = 0; index < limit; index += 1) {
      const dialed = await dialTunnel(paired.credential, "198.51.100.21");

      expect(dialed.status, `correct dial ${index}`).toBe(101);
      dialed.socket?.close();
    }

    const throttled = await dialTunnel(paired.credential, "198.51.100.22");
    expect(throttled.status).toBe(429);
  });
});

describe("tossed desktop cookies", () => {
  it("treats another user's valid desktop cookie as absent instead of locking the owner out", async () => {
    const victim = h.addUser("sawyer");
    h.addServer(victim.id, "sawyer");
    h.tunnels.connect("sawyer");
    const attacker = h.addUser("mallory");
    const attackerServer = h.addServer(attacker.id, "mallory");
    h.tunnels.connect("mallory");

    const issued = await send(h.port, {
      host: "mallory.relay.test",
      path: "/api/connect/desktop-session",
      method: "POST",
      headers: { "x-omnyo-connect-machine": attackerServer.credential },
    });

    expect(issued.status).toBe(200);

    const { cookie } = JSON.parse(issued.body) as {
      cookie: { name: string; value: string };
    };

    const tossed = `${cookie.name}=${cookie.value}`;

    const page = await send(h.port, {
      host: OWNER_HOST,
      path: "/",
      headers: { accept: "text/html", cookie: tossed },
    });

    expect(page.status).toBe(302);
    expect(String(page.headers.location)).toContain("/relay/authorize");

    const api = await send(h.port, {
      host: OWNER_HOST,
      path: "/api/state",
      headers: { accept: "application/json", cookie: tossed },
    });

    expect(api.status).toBe(401);
    expect(api.headers[GATE_REAUTH_HEADER]).toBe("1");

    const socket = await openWs(h.port, {
      host: OWNER_HOST,
      path: "/realtime",
      headers: { cookie: tossed },
    });

    expect(socket.status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(0);

    const own = await send(h.port, {
      host: "mallory.relay.test",
      path: "/",
      headers: { accept: "text/html", cookie: tossed },
    });

    expect(own.status).toBe(200);
  });
});

describe("preview capability path", () => {
  it("limits unauthenticated preview requests per client IP", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");
    const limit = RELAY_RATE_LIMITS.previewPerIp.limit;

    for (let index = 0; index < limit; index += 1) {
      const served = await send(h.port, {
        host: OWNER_HOST,
        path: "/preview-content/p1/cap1/index.html",
        forwardedFor: "203.0.113.80",
      });

      expect(served.status, `preview ${index}`).toBe(200);
    }

    const throttled = await send(h.port, {
      host: OWNER_HOST,
      path: "/preview-content/p1/cap1/index.html",
      forwardedFor: "203.0.113.80",
    });

    expect(throttled.status).toBe(429);
    expect(h.tunnels.httpRequests).toHaveLength(limit);

    const otherClient = await send(h.port, {
      host: OWNER_HOST,
      path: "/preview-content/p1/cap1/index.html",
      forwardedFor: "203.0.113.81",
    });

    expect(otherClient.status).toBe(200);
  });

  it("requires the owner cookie for the preview path on a port target", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");

    const page = await send(h.port, {
      host: "sawyer--8384.relay.test",
      path: "/preview-content/p1/cap1/anything",
      headers: { accept: "text/html" },
    });

    expect(page.status).toBe(302);

    const api = await send(h.port, {
      host: "sawyer--8384.relay.test",
      path: "/preview-content/p1/cap1/anything",
      headers: { accept: "application/json" },
    });

    expect(api.status).toBe(401);
    expect(h.tunnels.httpRequests).toHaveLength(0);
  });
});

describe("visitor WebSocket upgrade", () => {
  it("cancels the tunnel stream when the visitor resets while the relay waits for the origin", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    const device = h.addMachine(owner.id, null);
    h.tunnels.connect("sawyer");
    let release = () => {};

    h.tunnels.wsHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const visitor = connect(h.port, "127.0.0.1");
    await once(visitor, "connect");
    visitor.write(
      [
        "GET /api/v1/realtime HTTP/1.1",
        `Host: ${OWNER_HOST}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "X-Forwarded-For: 198.51.100.7",
        `x-omnyo-connect-machine: ${device.credential}`,
        "",
        "",
      ].join("\r\n"),
    );

    await waitFor(() => h.tunnels.wsRequests.length === 1);
    visitor.resetAndDestroy();

    await waitFor(() => h.tunnels.wsRequests[0]?.signal.aborted === true);
    release();
    await waitFor(() => h.tunnels.canceledWs.length === 1);

    expect(h.tunnels.boundVisitors.get("sawyer")?.size ?? 0).toBe(0);
    expect(h.gate.openStreams()).toBe(0);
  });
});

describe("preview content sandbox", () => {
  it("sandboxes every preview page, whatever policy the tenant sends", async () => {
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");

    for (const tenantPolicy of [null, "default-src *"]) {
      h.tunnels.origin = () =>
        Promise.resolve(
          new Response("<script>document.cookie='x=1'</script>", {
            status: 200,
            headers: {
              "content-type": "text/html",
              ...(tenantPolicy === null
                ? {}
                : { "content-security-policy": tenantPolicy }),
            },
          }),
        );

      const page = await send(h.port, {
        host: OWNER_HOST,
        path: "/preview-content/p1/cap1/index.html",
        forwardedFor: "203.0.113.90",
      });

      expect(page.status).toBe(200);
      expect(String(page.headers["content-security-policy"])).toMatch(
        /(^|,\s*)sandbox allow-scripts allow-forms$/u,
      );
    }
  });
});

describe("installer downloads", () => {
  it("stops new downloads on every address once the owner's daily installer budget is spent", async () => {
    await h.close();
    h = await startHarness({
      env: {
        RELAY_INSTALLER_MB_PER_LABEL_PER_DAY: String(4096 / (1024 * 1024)),
      },
    });
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.addServer(owner.id, "sawyer-two");
    h.tunnels.connect("sawyer");
    h.tunnels.connect("sawyer-two");
    h.tunnels.origin = () =>
      Promise.resolve(new Response("x".repeat(5000), { status: 200 }));

    const first = await send(h.port, {
      host: OWNER_HOST,
      path: "/install/omnyo-app.tgz",
      forwardedFor: "203.0.113.93",
    });

    expect(first.status).toBe(200);

    const second = await send(h.port, {
      host: "sawyer-two.relay.test",
      path: "/install/omnyo-app.tgz",
      forwardedFor: "203.0.113.94",
    });

    expect(second.status).toBe(429);
    expect(h.deps.egress.usage(owner.id).bytes).toBe(0);
  });

  it("cuts a download off once the address passes twice its daily budget", async () => {
    await h.close();
    h = await startHarness({
      env: {
        RELAY_INSTALLER_MB_PER_LABEL_PER_DAY: String(4096 / (1024 * 1024)),
      },
    });
    const owner = h.addUser("sawyer");
    h.addServer(owner.id, "sawyer");
    h.tunnels.connect("sawyer");
    const chunk = new Uint8Array(1024).fill(120);
    const totalChunks = 64;
    let originSignal: AbortSignal | null = null;

    h.tunnels.origin = (request) => {
      originSignal = request.signal;
      let sent = 0;

      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= totalChunks) {
                controller.close();

                return;
              }

              sent += 1;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
      );
    };

    const received = await send(h.port, {
      host: OWNER_HOST,
      path: "/install/omnyo-app.tgz",
      forwardedFor: "203.0.113.92",
    }).then(
      (result) => result.body.length,
      () => -1,
    );

    expect(received).toBeLessThan(totalChunks * chunk.byteLength);
    await waitFor(() => originSignal?.aborted === true);
  });
});
