import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CloudflareDnsError,
  type TxtLookup,
  createCloudflareDnsChallenge,
} from "./acme-cloudflare.js";
import {
  type FakeCloudflare,
  recordingLogger,
  startFakeCloudflare,
} from "./acme.fixture.js";

const ZONE_ID = "c0ffee00c0ffee00c0ffee00c0ffee00";

const TOKEN = "dns-value-for-tests";

const NAME = "_acme-challenge.u.relay.test";

let cloudflare: FakeCloudflare;

beforeEach(async () => {
  cloudflare = await startFakeCloudflare(ZONE_ID, TOKEN);
});

afterEach(async () => {
  await cloudflare.close();
});

function visibleAfter(polls: number): {
  lookup: TxtLookup;
  calls: () => number;
} {
  let calls = 0;

  return {
    lookup: async (name) => {
      calls += 1;

      return calls > polls ? cloudflare.served(name) : [];
    },
    calls: () => calls,
  };
}

function challenge(lookupTxt: TxtLookup, timeoutMs = 400) {
  const { log, events } = recordingLogger();

  return {
    events,
    dns: createCloudflareDnsChallenge({
      zoneId: ZONE_ID,
      token: TOKEN,
      log,
      apiBaseUrl: cloudflare.apiBaseUrl,
      lookupTxt,
      propagationTimeoutMs: timeoutMs,
      propagationIntervalMs: 10,
    }),
  };
}

describe("Cloudflare DNS-01 hook", () => {
  it("creates the TXT record, waits until it is served, then deletes it", async () => {
    const visibility = visibleAfter(3);
    const { dns, events } = challenge(visibility.lookup);

    await dns.present(NAME, "value-one");

    expect(visibility.calls()).toBe(4);
    expect(cloudflare.requests[0]).toEqual({
      method: "POST",
      path: `/client/v4/zones/${ZONE_ID}/dns_records`,
      authorization: `Bearer ${TOKEN}`,
      body: { type: "TXT", name: NAME, content: "value-one", ttl: 60 },
    });
    expect(cloudflare.served(NAME)).toEqual(["value-one"]);

    await dns.remove(NAME, "value-one");

    expect(cloudflare.records.size).toBe(0);
    expect(cloudflare.requests.map((request) => request.method)).toEqual([
      "POST",
      "DELETE",
    ]);
    expect(events.map((entry) => entry.event)).toEqual([
      "acme.dns_record_created",
      "acme.dns_record_visible",
      "acme.dns_record_deleted",
    ]);
  });

  it("waits for its own value when two challenges share one record name", async () => {
    const { dns } = challenge(visibleAfter(0).lookup);

    await Promise.all([
      dns.present(NAME, "apex-value"),
      dns.present(NAME, "wildcard-value"),
    ]);

    expect(cloudflare.served(NAME).sort()).toEqual([
      "apex-value",
      "wildcard-value",
    ]);

    await dns.removeAll();

    expect(cloudflare.records.size).toBe(0);
  });

  it("deletes the record it created when propagation times out", async () => {
    const visibility = visibleAfter(Number.POSITIVE_INFINITY);
    const { dns, events } = challenge(visibility.lookup, 60);

    const failure = await dns
      .present(NAME, "never-served")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CloudflareDnsError);
    expect((failure as Error).message).toContain(
      `The TXT record ${NAME} was not visible on the Cloudflare nameservers`,
    );
    expect(visibility.calls()).toBeGreaterThan(1);
    expect(cloudflare.records.size).toBe(0);
    expect(cloudflare.requests.map((request) => request.method)).toEqual([
      "POST",
      "DELETE",
    ]);
    expect(events.map((entry) => entry.event)).toContain(
      "acme.dns_record_deleted",
    );
  });

  it("keeps polling through lookup errors until the deadline", async () => {
    let calls = 0;

    const { dns } = challenge(async (name) => {
      calls += 1;

      if (calls < 3) throw new Error("SERVFAIL");

      return cloudflare.served(name);
    });

    await dns.present(NAME, "eventually");

    expect(calls).toBe(3);
    await dns.removeAll();
    expect(cloudflare.records.size).toBe(0);
  });

  it("reports a refused create without leaving or deleting anything", async () => {
    cloudflare.failCreates = 1;
    const { dns } = challenge(visibleAfter(0).lookup);

    await expect(dns.present(NAME, "refused")).rejects.toThrow(
      "Cloudflare DNS API POST /dns_records failed with HTTP 400: 81057 Invalid TXT record",
    );

    await dns.removeAll();

    expect(cloudflare.records.size).toBe(0);
    expect(cloudflare.requests.map((request) => request.method)).toEqual([
      "POST",
    ]);
  });

  it("never sends or reports the token when Cloudflare rejects it", async () => {
    const { log } = recordingLogger();

    const dns = createCloudflareDnsChallenge({
      zoneId: ZONE_ID,
      token: "wrong-dns-value",
      log,
      apiBaseUrl: cloudflare.apiBaseUrl,
      lookupTxt: visibleAfter(0).lookup,
    });

    const failure = (await dns
      .present(NAME, "value")
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toBe(
      "Cloudflare DNS API POST /dns_records failed with HTTP 403: 10000 Authentication error",
    );
    expect(failure.message).not.toContain("wrong-dns-value");
  });

  it("retries a failed delete when the issuer cleans up at the end", async () => {
    const { dns, events } = challenge(visibleAfter(0).lookup);

    await dns.present(NAME, "sticky");
    cloudflare.failDeletes = 1;

    await expect(dns.remove(NAME, "sticky")).rejects.toThrow(
      "failed with HTTP 500",
    );
    expect(cloudflare.records.size).toBe(1);

    await dns.removeAll();

    expect(cloudflare.records.size).toBe(0);
    expect(events.map((entry) => entry.event)).toContain(
      "acme.dns_record_deleted",
    );
  });
});
