import {
  type CertificateMaterial,
  type StoredCertificate,
  errorMessageOf,
} from "./acme.js";
import type { RelayLogger } from "./contracts.js";

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

export const RENEWAL_CHECK_INTERVAL_MS = 12 * HOUR_MS;

export const RENEW_BEFORE_EXPIRY_MS = 30 * DAY_MS;

export function isRenewalDue(notAfter: number, now: number): boolean {
  return notAfter - now < RENEW_BEFORE_EXPIRY_MS;
}

export interface CertificateRenewalOptions {
  current: StoredCertificate;
  renew(): Promise<StoredCertificate>;
  apply(material: CertificateMaterial): void;
  log: RelayLogger;
  now: () => number;
  intervalMs?: number;
}

export interface CertificateRenewal {
  check(): Promise<void>;
  stop(): void;
}

export function startCertificateRenewal(
  options: CertificateRenewalOptions,
): CertificateRenewal {
  const { log, now } = options;
  let current = options.current;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function run(): Promise<void> {
    if (stopped || !isRenewalDue(current.notAfter, now())) return;
    log.info("acme.renewal_started", {
      notAfter: new Date(current.notAfter).toISOString(),
    });

    try {
      const renewed = await options.renew();

      if (stopped) return;
      options.apply(renewed.material);
      current = renewed;
      log.info("acme.renewed", {
        notAfter: new Date(renewed.notAfter).toISOString(),
      });
    } catch (error) {
      log.error("acme.renewal_failed", {
        message: errorMessageOf(error),
        keptNotAfter: new Date(current.notAfter).toISOString(),
      });
    }
  }

  function check(): Promise<void> {
    running ??= run().finally(() => {
      running = null;
    });

    return running;
  }

  const timer = setInterval(() => {
    void check();
  }, options.intervalMs ?? RENEWAL_CHECK_INTERVAL_MS);

  timer.unref();

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
