import { X509Certificate, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CERTIFICATE_CHAIN_FILE,
  CERTIFICATE_DIRECTORY,
  type CertificateMaterial,
  CertificateIssuanceError,
  certificateDomains,
  createFileCertificateStore,
} from "./acme.js";
import {
  type LoggedEvent,
  recordingLogger,
  selfSignedCertificate,
} from "./acme.fixture.js";
import { type RunningRelay, startRelay } from "./main.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { PROXY_V2_SIGNATURE } from "./net/proxy-protocol.js";

const BASE_DOMAIN = "omnyo.localhost";

const DNS_TOKEN = "dns-value-for-live-tests";

const ACME_DIRECTORY_URL = "https://acme.invalid/directory";

let directory: string;

let relay: RunningRelay | null;

const open: TLSSocket[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");

  return port;
}

function proxyV2Header(): Buffer {
  const block = Buffer.from([
    198, 51, 100, 9, 127, 0, 0, 1, 0xc3, 0x50, 1, 187,
  ]);

  const length = Buffer.alloc(2);
  length.writeUInt16BE(block.length);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x11]),
    length,
    block,
  ]);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function startOptionP(input: {
  port: number;
  healthPort: number;
  log: ReturnType<typeof recordingLogger>["log"];
  issue: (domains: readonly string[]) => Promise<CertificateMaterial>;
}) {
  return startRelay({
    env: {
      BASE_DOMAIN,
      APP_URL: `https://${BASE_DOMAIN}:${input.port}`,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      GITHUB_CLIENT_ID: "relay-acme-client",
      GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
      DATABASE_PATH: join(directory, "relay.sqlite"),
      PORT: String(input.port),
      HEALTH_PORT: String(input.healthPort),
      RELAY_CLIENT_IP_SOURCE: "proxy-protocol",
      RELAY_PROXY_CIDR: "127.0.0.1/32",
      ACME_DIRECTORY_URL,
      ACME_ACCOUNT_EMAIL: "relay@example.com",
      CLOUDFLARE_DNS_TOKEN: DNS_TOKEN,
      CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
    },
    migrations: sourceMigrationDirectories(),
    lock: () => ({ verify: async () => {} }),
    certificates: createFileCertificateStore,
    certificateIssuer: () => ({ issue: input.issue }),
    log: input.log,
  });
}

function openTls(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const raw = connect(port, "127.0.0.1", () => {
      raw.write(proxyV2Header());

      const secure = tlsConnect({
        socket: raw,
        servername: BASE_DOMAIN,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });

      open.push(secure);
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    });

    raw.once("error", reject);
  });
}

function healthOver(secure: TLSSocket, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = "";

    const onData = (chunk: Buffer) => {
      response += chunk.toString();
      const end = response.indexOf("\r\n\r\n");

      if (end === -1) return;
      const length = Number(/content-length: (\d+)/iu.exec(response)?.[1]);

      if (response.length < end + 4 + length) return;
      secure.off("data", onData);
      resolve(response.slice(0, response.indexOf("\r\n")));
    };

    secure.on("data", onData);
    secure.once("error", reject);
    secure.write(
      `GET /healthz HTTP/1.1\r\nhost: ${BASE_DOMAIN}:${port}\r\nconnection: keep-alive\r\n\r\n`,
    );
  });
}

function fingerprintOf(material: CertificateMaterial): string {
  return new X509Certificate(material.cert).fingerprint256;
}

async function waitForEvent(events: LoggedEvent[], name: string) {
  const deadline = Date.now() + 5_000;

  while (!events.some((entry) => entry.event === name)) {
    if (Date.now() > deadline) throw new Error(`no ${name} event`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "relay-acme-live-"));
  relay = null;
});

afterEach(async () => {
  for (const socket of open.splice(0)) socket.destroy();
  await relay?.shutdown();
  rmSync(directory, { recursive: true, force: true });
});

describe("relay certificate lifecycle under option P", () => {
  it("issues before the TLS listener starts while /healthz answers 503 starting", async () => {
    const issued = await selfSignedCertificate(
      certificateDomains(BASE_DOMAIN),
      90,
    );

    const [port, healthPort] = [await freePort(), await freePort()];
    const started = deferred<void>();
    const release = deferred<void>();
    const { log } = recordingLogger();

    const starting = startOptionP({
      port,
      healthPort,
      log,
      issue: async () => {
        started.resolve();
        await release.promise;

        return issued;
      },
    });

    await started.promise;
    const during = await fetch(`http://127.0.0.1:${healthPort}/healthz`);

    expect(during.status).toBe(503);
    expect(await during.text()).toBe("starting\n");
    await expect(openTls(port)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });

    release.resolve();
    relay = await starting;

    const after = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
    expect(after.status).toBe(200);

    const secure = await openTls(port);
    expect(secure.getPeerCertificate().fingerprint256).toBe(
      fingerprintOf(issued),
    );
    expect(
      statSync(join(directory, CERTIFICATE_DIRECTORY, CERTIFICATE_CHAIN_FILE))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("swaps the served certificate for new connections and keeps an existing connection open", async () => {
    const domains = certificateDomains(BASE_DOMAIN);

    const [expiring, renewed] = await Promise.all([
      selfSignedCertificate(domains, 20),
      selfSignedCertificate(domains, 90),
    ]);

    createFileCertificateStore(join(directory, CERTIFICATE_DIRECTORY)).save(
      expiring,
      ACME_DIRECTORY_URL,
    );

    const port = await freePort();
    const release = deferred<void>();
    const { log, events } = recordingLogger();

    relay = await startOptionP({
      port,
      healthPort: 0,
      log,
      issue: async () => {
        await release.promise;

        return renewed;
      },
    });

    const existing = await openTls(port);
    expect(existing.getPeerCertificate().fingerprint256).toBe(
      fingerprintOf(expiring),
    );
    expect(await healthOver(existing, port)).toBe("HTTP/1.1 200 OK");

    release.resolve();
    await waitForEvent(events, "acme.renewed");

    const fresh = await openTls(port);
    expect(fresh.getPeerCertificate().fingerprint256).toBe(
      fingerprintOf(renewed),
    );

    expect(await healthOver(existing, port)).toBe("HTTP/1.1 200 OK");
    expect(existing.destroyed).toBe(false);
    expect(existing.getPeerCertificate().fingerprint256).toBe(
      fingerprintOf(expiring),
    );
  });

  it("fails startup with a clear message that never includes the DNS token", async () => {
    const [port, healthPort] = [await freePort(), await freePort()];
    const { log, events } = recordingLogger();

    const failure = await startOptionP({
      port,
      healthPort,
      log,
      issue: async () => {
        throw new Error(`Cloudflare refused Bearer ${DNS_TOKEN}`);
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CertificateIssuanceError);
    expect((failure as Error).message).toBe(
      `Could not obtain a certificate for ${BASE_DOMAIN}, *.${BASE_DOMAIN}: Cloudflare refused Bearer [redacted]`,
    );
    expect(JSON.stringify(events)).not.toContain(DNS_TOKEN);
    expect(events.map((entry) => entry.event)).not.toContain("relay.live");
    await expect(
      fetch(`http://127.0.0.1:${healthPort}/healthz`),
    ).rejects.toThrow();
  });
});
