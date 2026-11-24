import { X509Certificate, createPrivateKey } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AcmeConfig } from "./config.js";
import type { RelayLogger } from "./contracts.js";

export const CERTIFICATE_DIRECTORY = "acme";

export const PRIVATE_KEY_FILE = "privkey.pem";

export const CERTIFICATE_CHAIN_FILE = "fullchain.pem";

export const ACCOUNT_KEY_FILE = "account.pem";

export const DIRECTORY_URL_FILE = "directory-url";

export const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_DIRECTORY_MODE = 0o700;

export interface CertificateMaterial {
  key: string;
  cert: string;
}

export interface StoredCertificate {
  material: CertificateMaterial;
  notAfter: number;
}

export interface StoredCertificateFiles {
  material: CertificateMaterial;
  directoryUrl: string | null;
}

export interface CertificateStore {
  load(): StoredCertificateFiles | null;
  save(material: CertificateMaterial, directoryUrl: string): void;
  loadAccountKey(): string | null;
  saveAccountKey(pem: string): void;
}

export interface CertificateIssuer {
  issue(domains: readonly string[]): Promise<CertificateMaterial>;
}

export interface CertificateManager {
  ensure(): Promise<StoredCertificate>;
  renew(): Promise<StoredCertificate>;
}

export interface CertificateIssuerSetup {
  store: CertificateStore;
  acme: AcmeConfig;
  log: RelayLogger;
}

export class CertificateUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CertificateUnavailableError";
  }
}

export class CertificateIssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateIssuanceError";
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;

  return typeof error.code === "string" ? error.code : null;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new CertificateUnavailableError(`Cannot read ${path}`, {
      cause: error,
    });
  }
}

function writePrivateFile(directory: string, file: string, text: string): void {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const target = join(directory, file);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: PRIVATE_FILE_MODE });
  chmodSync(temporary, PRIVATE_FILE_MODE);
  renameSync(temporary, target);
}

export function createFileCertificateStore(
  directory: string,
): CertificateStore {
  return {
    load() {
      const key = readOptional(join(directory, PRIVATE_KEY_FILE));
      const cert = readOptional(join(directory, CERTIFICATE_CHAIN_FILE));

      if (key === null || cert === null) return null;

      return {
        material: { key, cert },
        directoryUrl: readOptional(join(directory, DIRECTORY_URL_FILE)),
      };
    },
    save(material, directoryUrl) {
      writePrivateFile(directory, PRIVATE_KEY_FILE, material.key);
      writePrivateFile(directory, CERTIFICATE_CHAIN_FILE, material.cert);
      writePrivateFile(directory, DIRECTORY_URL_FILE, directoryUrl);
    },
    loadAccountKey() {
      return readOptional(join(directory, ACCOUNT_KEY_FILE));
    },
    saveAccountKey(pem) {
      writePrivateFile(directory, ACCOUNT_KEY_FILE, pem);
    },
  };
}

export function certificateDomains(baseDomain: string): readonly string[] {
  return [baseDomain, `*.${baseDomain}`];
}

function subjectAltNames(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length).toLowerCase());
}

export type CertificateInspection =
  | { usable: true; notAfter: number }
  | { usable: false; reason: string };

export function inspectCertificate(
  material: CertificateMaterial,
  domains: readonly string[],
): CertificateInspection {
  let certificate: X509Certificate;

  try {
    certificate = new X509Certificate(material.cert);
  } catch {
    return { usable: false, reason: "the certificate chain does not parse" };
  }

  let matches: boolean;

  try {
    matches = certificate.checkPrivateKey(createPrivateKey(material.key));
  } catch {
    return { usable: false, reason: "the private key does not parse" };
  }

  if (!matches) {
    return {
      usable: false,
      reason: "the private key does not match the certificate",
    };
  }

  const names = subjectAltNames(certificate);
  const missing = domains.filter((domain) => !names.includes(domain));

  if (missing.length > 0) {
    return {
      usable: false,
      reason: `the certificate does not cover ${missing.join(", ")}`,
    };
  }

  return { usable: true, notAfter: certificate.validToDate.getTime() };
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (current, secret) => current.replaceAll(secret, "[redacted]"),
      text,
    );
}

export interface CertificateManagerOptions {
  store: CertificateStore;
  domains: readonly string[];
  directoryUrl: string;
  issuer: CertificateIssuer;
  log: RelayLogger;
  now: () => number;
  redactions?: readonly string[];
}

export function createCertificateManager(
  options: CertificateManagerOptions,
): CertificateManager {
  const { store, domains, directoryUrl, issuer, log, now } = options;
  const redactions = options.redactions ?? [];

  async function issue(): Promise<StoredCertificate> {
    log.info("acme.issuing", { domains: domains.join(",") });
    let material: CertificateMaterial;

    try {
      material = await issuer.issue(domains);
    } catch (error) {
      throw new CertificateIssuanceError(
        redact(
          `Could not obtain a certificate for ${domains.join(", ")}: ${errorMessageOf(error)}`,
          redactions,
        ),
      );
    }

    const inspection = inspectCertificate(material, domains);

    if (!inspection.usable) {
      throw new CertificateIssuanceError(
        `The ACME server returned an unusable certificate: ${inspection.reason}`,
      );
    }

    store.save(material, directoryUrl);
    log.info("acme.issued", {
      domains: domains.join(","),
      notAfter: new Date(inspection.notAfter).toISOString(),
    });

    return { material, notAfter: inspection.notAfter };
  }

  return {
    async ensure() {
      const existing = store.load();

      if (existing === null) {
        log.info("acme.certificate_missing", {});

        return issue();
      }

      if (existing.directoryUrl === null) {
        log.warn("acme.certificate_unusable", {
          reason: "no ACME directory is recorded for the stored certificate",
          directoryUrl,
        });

        return issue();
      }

      if (existing.directoryUrl !== directoryUrl) {
        log.warn("acme.certificate_unusable", {
          reason: "another ACME directory issued the stored certificate",
          storedDirectoryUrl: existing.directoryUrl,
          directoryUrl,
        });

        return issue();
      }

      const inspection = inspectCertificate(existing.material, domains);

      if (inspection.usable && inspection.notAfter > now()) {
        log.info("acme.certificate_loaded", {
          notAfter: new Date(inspection.notAfter).toISOString(),
        });

        return { material: existing.material, notAfter: inspection.notAfter };
      }

      log.warn("acme.certificate_unusable", {
        reason: inspection.usable
          ? "the certificate has expired"
          : inspection.reason,
      });

      return issue();
    },
    renew: issue,
  };
}
