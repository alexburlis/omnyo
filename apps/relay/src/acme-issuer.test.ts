import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_KEY_FILE,
  CERTIFICATE_CHAIN_FILE,
  CertificateIssuanceError,
  DIRECTORY_URL_FILE,
  PRIVATE_KEY_FILE,
  certificateDomains,
  createCertificateManager,
  createFileCertificateStore,
} from "./acme.js";
import { createCloudflareDnsChallenge } from "./acme-cloudflare.js";
import { challengeRecordName, createAcmeIssuer } from "./acme-issuer.js";
import {
  type FakeCloudflare,
  type LoggedEvent,
  recordingLogger,
  selfSignedCertificate,
  startFakeCloudflare,
} from "./acme.fixture.js";

interface AutoOptions {
  csr: Buffer;
  email?: string;
  termsOfServiceAgreed?: boolean;
  skipChallengeVerification?: boolean;
  challengePriority?: string[];
  challengeCreateFn(
    authz: unknown,
    challenge: { type: string },
    keyAuthorization: string,
  ): Promise<unknown>;
  challengeRemoveFn(
    authz: unknown,
    challenge: { type: string },
    keyAuthorization: string,
  ): Promise<unknown>;
}

const acmeModule = vi.hoisted(() => ({
  clients: [] as Array<{ directoryUrl: string; accountKey: string }>,
  csrs: [] as Array<{ data: unknown; key: string }>,
  autoCalls: [] as AutoOptions[],
  auto: (_options: AutoOptions): Promise<string> =>
    Promise.reject(new Error("auto is not configured")),
}));

vi.mock("acme-client", async () => {
  const { generateKeyPairSync } = await import("node:crypto");

  return {
    crypto: {
      createPrivateEcdsaKey: async () =>
        Buffer.from(
          generateKeyPairSync("ec", { namedCurve: "P-256" })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        ),
      createCsr: async (data: unknown, key: Buffer) => {
        acmeModule.csrs.push({ data, key: key.toString() });

        return [Buffer.from(key), Buffer.from("csr")];
      },
    },
    Client: class {
      constructor(options: { directoryUrl: string; accountKey: string }) {
        acmeModule.clients.push(options);
      }

      auto(options: AutoOptions): Promise<string> {
        acmeModule.autoCalls.push(options);

        return acmeModule.auto(options);
      }
    },
  };
});

const ZONE_ID = "0123456789abcdef0123456789abcdef";

const TOKEN = "dns-value-for-issuer-tests";

const BASE_DOMAIN = "relay.test";

const DIRECTORY_URL = "https://acme.test/directory";

const PRODUCTION_DIRECTORY_URL = "https://acme-production.test/directory";

const RECORD_NAME = `_acme-challenge.${BASE_DOMAIN}`;

const AUTHORIZATIONS = [
  { identifier: { type: "dns", value: BASE_DOMAIN }, wildcard: false },
  { identifier: { type: "dns", value: BASE_DOMAIN }, wildcard: true },
];

const DNS_CHALLENGE = { type: "dns-01" };

let directory: string;

let cloudflare: FakeCloudflare;

let events: LoggedEvent[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "relay-acme-issuer-"));
  cloudflare = await startFakeCloudflare(ZONE_ID, TOKEN);
  acmeModule.clients.length = 0;
  acmeModule.csrs.length = 0;
  acmeModule.autoCalls.length = 0;
});

afterEach(async () => {
  await cloudflare.close();
  rmSync(directory, { recursive: true, force: true });
});

function manager(
  now: () => number = Date.now,
  directoryUrl: string = DIRECTORY_URL,
  accountEmail: string | null = "ops@relay.test",
) {
  const recorder = recordingLogger();
  events = recorder.events;
  const store = createFileCertificateStore(directory);

  return createCertificateManager({
    store,
    domains: certificateDomains(BASE_DOMAIN),
    directoryUrl,
    issuer: createAcmeIssuer({
      directoryUrl,
      ...(accountEmail === null ? {} : { accountEmail }),
      store,
      dns: createCloudflareDnsChallenge({
        zoneId: ZONE_ID,
        token: TOKEN,
        log: recorder.log,
        apiBaseUrl: cloudflare.apiBaseUrl,
        lookupTxt: async (name) => cloudflare.served(name),
        propagationIntervalMs: 10,
        propagationTimeoutMs: 200,
      }),
      log: recorder.log,
    }),
    log: recorder.log,
    now,
    redactions: [TOKEN],
  });
}

function lastCsrKey(): string {
  const csr = acmeModule.csrs.at(-1);

  if (csr === undefined) throw new Error("no CSR was created");

  return csr.key;
}

function modeOf(file: string): number {
  return statSync(join(directory, file)).mode & 0o777;
}

const servedDuringValidation: string[][] = [];

function completeOrder(domains = certificateDomains(BASE_DOMAIN)) {
  return async (options: AutoOptions): Promise<string> => {
    await Promise.all(
      AUTHORIZATIONS.map(async (authz, index) => {
        await options.challengeCreateFn(authz, DNS_CHALLENGE, `ka-${index}`);
        servedDuringValidation.push(cloudflare.served(RECORD_NAME));
        await options.challengeRemoveFn(authz, DNS_CHALLENGE, `ka-${index}`);
      }),
    );

    return (await selfSignedCertificate(domains, 90, lastCsrKey())).cert;
  };
}

describe("ACME DNS-01 issuance with acme-client mocked at its module boundary", () => {
  it("names the challenge record without the wildcard label", () => {
    expect(challengeRecordName("*.omnyo.link")).toBe(
      "_acme-challenge.omnyo.link",
    );
    expect(challengeRecordName("omnyo.link")).toBe(
      "_acme-challenge.omnyo.link",
    );
  });

  it("issues the apex and wildcard, stores 0600 files and removes every TXT record", async () => {
    servedDuringValidation.length = 0;
    acmeModule.auto = completeOrder();

    const issued = await manager().ensure();

    expect(acmeModule.csrs[0]?.data).toEqual({
      commonName: BASE_DOMAIN,
      altNames: [BASE_DOMAIN, `*.${BASE_DOMAIN}`],
    });
    expect(acmeModule.clients[0]?.directoryUrl).toBe(DIRECTORY_URL);
    expect(acmeModule.autoCalls[0]).toMatchObject({
      email: "ops@relay.test",
      termsOfServiceAgreed: true,
      skipChallengeVerification: true,
      challengePriority: ["dns-01"],
    });
    expect(servedDuringValidation.flat().sort()).toEqual(
      expect.arrayContaining(["ka-0", "ka-1"]),
    );
    expect(cloudflare.records.size).toBe(0);
    expect(issued.notAfter).toBeGreaterThan(Date.now() + 80 * 86_400_000);

    for (const file of [
      ACCOUNT_KEY_FILE,
      PRIVATE_KEY_FILE,
      CERTIFICATE_CHAIN_FILE,
    ]) {
      expect(modeOf(file)).toBe(0o600);
    }

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(events.map((entry) => entry.event)).toContain("acme.issued");
  });

  it("registers the ACME account with no contact when no email is configured", async () => {
    acmeModule.auto = completeOrder();
    await manager(Date.now, DIRECTORY_URL, null).ensure();

    const [options] = acmeModule.autoCalls;

    if (options === undefined) throw new Error("auto was not called");
    expect(options).not.toHaveProperty("email");

    const actual =
      await vi.importActual<typeof import("acme-client")>("acme-client");

    const client = new actual.Client({
      directoryUrl: DIRECTORY_URL,
      accountKey: await actual.crypto.createPrivateEcdsaKey(),
    });

    const accountRequests: unknown[] = [];

    client.createAccount = async (data) => {
      accountRequests.push(data);
      throw new Error("account request recorded");
    };

    await expect(client.auto(options)).rejects.toThrow(
      "account request recorded",
    );
    expect(accountRequests).toEqual([{ termsOfServiceAgreed: true }]);
  });

  it("reuses the stored certificate and the registered account key", async () => {
    acmeModule.auto = completeOrder();
    await manager().ensure();

    const reloaded = manager();
    await reloaded.ensure();

    expect(acmeModule.autoCalls).toHaveLength(1);
    expect(events.map((entry) => entry.event)).toEqual([
      "acme.certificate_loaded",
    ]);

    await reloaded.renew();

    expect(acmeModule.autoCalls).toHaveLength(2);
    expect(acmeModule.clients[1]?.accountKey).toBe(
      acmeModule.clients[0]?.accountKey,
    );
    expect(acmeModule.csrs[1]?.key).not.toBe(acmeModule.csrs[0]?.key);
  });

  it("deletes its records when the order fails before acme-client cleans up, without the token in the message", async () => {
    acmeModule.auto = async (options) => {
      await options.challengeCreateFn(AUTHORIZATIONS[0], DNS_CHALLENGE, "ka");
      throw new Error(`order invalid after Bearer ${TOKEN}`);
    };

    const failure = await manager()
      .ensure()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CertificateIssuanceError);
    expect((failure as Error).message).toBe(
      `Could not obtain a certificate for ${BASE_DOMAIN}, *.${BASE_DOMAIN}: order invalid after Bearer [redacted]`,
    );
    expect(cloudflare.records.size).toBe(0);
    expect(cloudflare.requests.map((request) => request.method)).toEqual([
      "POST",
      "DELETE",
    ]);
    expect(existsSync(join(directory, PRIVATE_KEY_FILE))).toBe(false);
    expect(existsSync(join(directory, CERTIFICATE_CHAIN_FILE))).toBe(false);
  });

  it("refuses an authorization that offers no dns-01 challenge", async () => {
    acmeModule.auto = async (options) => {
      await options.challengeCreateFn(
        AUTHORIZATIONS[0],
        { type: "http-01" },
        "ka",
      );

      return "unreachable";
    };

    await expect(manager().ensure()).rejects.toThrow(
      `${BASE_DOMAIN} offered no dns-01 challenge`,
    );
    expect(cloudflare.requests).toEqual([]);
  });

  it("reissues a stored certificate that has expired or misses a name", async () => {
    acmeModule.auto = completeOrder(["other.test"]);
    await expect(manager().ensure()).rejects.toThrow(
      "The ACME server returned an unusable certificate: the certificate does not cover relay.test, *.relay.test",
    );

    acmeModule.auto = completeOrder();
    await manager().ensure();

    const later = manager(() => Date.now() + 120 * 86_400_000);
    await later.ensure();

    expect(events.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["acme.certificate_unusable", "acme.issued"]),
    );
    expect(
      events.find((entry) => entry.event === "acme.certificate_unusable")
        ?.fields,
    ).toEqual({ reason: "the certificate has expired" });
    expect(acmeModule.autoCalls).toHaveLength(3);
  });

  it("reissues a stored certificate that another ACME directory issued", async () => {
    acmeModule.auto = completeOrder();
    await manager().ensure();

    await manager(Date.now, PRODUCTION_DIRECTORY_URL).ensure();

    expect(acmeModule.autoCalls).toHaveLength(2);
    expect(acmeModule.clients.at(-1)?.directoryUrl).toBe(
      PRODUCTION_DIRECTORY_URL,
    );
    expect(
      events.find((entry) => entry.event === "acme.certificate_unusable")
        ?.fields,
    ).toEqual({
      reason: "another ACME directory issued the stored certificate",
      storedDirectoryUrl: DIRECTORY_URL,
      directoryUrl: PRODUCTION_DIRECTORY_URL,
    });
    expect(readFileSync(join(directory, DIRECTORY_URL_FILE), "utf8")).toBe(
      PRODUCTION_DIRECTORY_URL,
    );
    expect(modeOf(DIRECTORY_URL_FILE)).toBe(0o600);

    await manager(Date.now, PRODUCTION_DIRECTORY_URL).ensure();

    expect(acmeModule.autoCalls).toHaveLength(2);
    expect(events.map((entry) => entry.event)).toEqual([
      "acme.certificate_loaded",
    ]);
  });

  it("reissues a stored certificate whose issuing directory is not recorded", async () => {
    const stored = await selfSignedCertificate(
      certificateDomains(BASE_DOMAIN),
      90,
    );

    writeFileSync(join(directory, PRIVATE_KEY_FILE), stored.key);
    writeFileSync(join(directory, CERTIFICATE_CHAIN_FILE), stored.cert);
    acmeModule.auto = completeOrder();

    await manager().ensure();

    expect(acmeModule.autoCalls).toHaveLength(1);
    expect(
      events.find((entry) => entry.event === "acme.certificate_unusable")
        ?.fields,
    ).toEqual({
      reason: "no ACME directory is recorded for the stored certificate",
      directoryUrl: DIRECTORY_URL,
    });
  });
});
