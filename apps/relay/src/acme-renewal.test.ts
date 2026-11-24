import { describe, expect, it } from "vitest";
import type { CertificateMaterial, StoredCertificate } from "./acme.js";
import {
  RENEWAL_CHECK_INTERVAL_MS,
  RENEW_BEFORE_EXPIRY_MS,
  isRenewalDue,
  startCertificateRenewal,
} from "./acme-renewal.js";
import { recordingLogger } from "./acme.fixture.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const NOW = Date.UTC(2026, 10, 8, 12);

function stored(label: string, daysLeft: number): StoredCertificate {
  return {
    material: { key: `${label}-key`, cert: `${label}-cert` },
    notAfter: NOW + daysLeft * DAY_MS,
  };
}

function renewal(
  current: StoredCertificate,
  renew: () => Promise<StoredCertificate>,
  intervalMs?: number,
) {
  const { log, events } = recordingLogger();
  const applied: CertificateMaterial[] = [];

  const job = startCertificateRenewal({
    current,
    renew,
    apply: (material) => applied.push(material),
    log,
    now: () => NOW,
    intervalMs,
  });

  return { job, applied, events };
}

describe("certificate renewal decisions", () => {
  it("checks every 12 hours and renews inside the last 30 days", () => {
    expect(RENEWAL_CHECK_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
    expect(RENEW_BEFORE_EXPIRY_MS).toBe(30 * DAY_MS);
    expect(isRenewalDue(NOW + 60 * DAY_MS, NOW)).toBe(false);
    expect(isRenewalDue(NOW + 30 * DAY_MS, NOW)).toBe(false);
    expect(isRenewalDue(NOW + 30 * DAY_MS - 1, NOW)).toBe(true);
    expect(isRenewalDue(NOW + DAY_MS, NOW)).toBe(true);
    expect(isRenewalDue(NOW - DAY_MS, NOW)).toBe(true);
  });

  it("leaves a certificate with more than 30 days alone", async () => {
    let renewals = 0;

    const { job, applied, events } = renewal(stored("a", 45), async () => {
      renewals += 1;

      return stored("b", 90);
    });

    await job.check();
    job.stop();

    expect(renewals).toBe(0);
    expect(applied).toEqual([]);
    expect(events).toEqual([]);
  });

  it("renews a due certificate once, swaps it in and then stops renewing", async () => {
    let renewals = 0;

    const { job, applied, events } = renewal(stored("a", 10), async () => {
      renewals += 1;

      return stored("b", 90);
    });

    await Promise.all([job.check(), job.check()]);
    await job.check();
    job.stop();

    expect(renewals).toBe(1);
    expect(applied).toEqual([{ key: "b-key", cert: "b-cert" }]);
    expect(events.map((entry) => entry.event)).toEqual([
      "acme.renewal_started",
      "acme.renewed",
    ]);
  });

  it("keeps the old certificate, logs the failure and retries on the next check", async () => {
    let renewals = 0;

    const { job, applied, events } = renewal(stored("a", 5), async () => {
      renewals += 1;

      if (renewals === 1) throw new Error("ACME order failed");

      return stored("b", 90);
    });

    await job.check();

    expect(applied).toEqual([]);
    expect(events.at(-1)).toEqual({
      level: "error",
      event: "acme.renewal_failed",
      fields: {
        message: "ACME order failed",
        keptNotAfter: new Date(NOW + 5 * DAY_MS).toISOString(),
      },
    });

    await job.check();
    job.stop();

    expect(renewals).toBe(2);
    expect(applied).toEqual([{ key: "b-key", cert: "b-cert" }]);
  });

  it("treats a certificate the server cannot load as a failed renewal", async () => {
    const { log, events } = recordingLogger();

    const job = startCertificateRenewal({
      current: stored("a", 5),
      renew: async () => stored("b", 90),
      apply: () => {
        throw new Error("bad PEM");
      },
      log,
      now: () => NOW,
    });

    await job.check();
    job.stop();

    expect(events.at(-1)?.event).toBe("acme.renewal_failed");
  });

  it("runs the check on its interval and stops when asked", async () => {
    let renewals = 0;

    const { job, applied } = renewal(
      stored("a", 1),
      async () => {
        renewals += 1;

        return stored(`r${renewals}`, 2);
      },
      15,
    );

    await new Promise((resolve) => setTimeout(resolve, 70));
    job.stop();
    const stoppedAt = renewals;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    expect(renewals).toBe(stoppedAt);
    expect(applied.length).toBe(stoppedAt);
  });

  it("does not swap in a certificate that arrives after stop", async () => {
    let release: (value: StoredCertificate) => void = () => {};

    const { job, applied } = renewal(
      stored("a", 1),
      () =>
        new Promise<StoredCertificate>((resolve) => {
          release = resolve;
        }),
    );

    const pending = job.check();
    job.stop();
    release(stored("late", 90));
    await pending;

    expect(applied).toEqual([]);
  });
});
