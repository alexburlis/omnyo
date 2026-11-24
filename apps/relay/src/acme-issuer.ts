import * as acme from "acme-client";
import type {
  CertificateIssuer,
  CertificateIssuerSetup,
  CertificateStore,
} from "./acme.js";
import {
  type DnsChallenge,
  createCloudflareDnsChallenge,
} from "./acme-cloudflare.js";
import type { RelayLogger } from "./contracts.js";

export const DNS_CHALLENGE_TYPE = "dns-01";

export interface AcmeIssuerOptions {
  directoryUrl: string;
  accountEmail?: string;
  store: Pick<CertificateStore, "loadAccountKey" | "saveAccountKey">;
  dns: DnsChallenge;
  log: RelayLogger;
}

export function challengeRecordName(identifier: string): string {
  return `_acme-challenge.${identifier.replace(/^\*\./u, "")}`;
}

export function createAcmeIssuer(
  options: AcmeIssuerOptions,
): CertificateIssuer {
  const { store, dns, log } = options;

  async function accountKey(): Promise<string> {
    const existing = store.loadAccountKey();

    if (existing !== null) return existing;
    const created = (await acme.crypto.createPrivateEcdsaKey()).toString();
    store.saveAccountKey(created);
    log.info("acme.account_key_created", {});

    return created;
  }

  return {
    async issue(domains) {
      const [commonName] = domains;

      if (commonName === undefined) {
        throw new Error("A certificate needs at least one domain");
      }

      const client = new acme.Client({
        directoryUrl: options.directoryUrl,
        accountKey: await accountKey(),
      });

      const [key, csr] = await acme.crypto.createCsr(
        { commonName, altNames: [...domains] },
        await acme.crypto.createPrivateEcdsaKey(),
      );

      try {
        const cert = await client.auto({
          csr,
          ...(options.accountEmail === undefined
            ? {}
            : { email: options.accountEmail }),
          termsOfServiceAgreed: true,
          challengePriority: [DNS_CHALLENGE_TYPE],
          skipChallengeVerification: true,
          async challengeCreateFn(authz, challenge, keyAuthorization) {
            if (challenge.type !== DNS_CHALLENGE_TYPE) {
              throw new Error(
                `${authz.identifier.value} offered no ${DNS_CHALLENGE_TYPE} challenge`,
              );
            }

            await dns.present(
              challengeRecordName(authz.identifier.value),
              keyAuthorization,
            );
          },
          async challengeRemoveFn(authz, _challenge, keyAuthorization) {
            await dns.remove(
              challengeRecordName(authz.identifier.value),
              keyAuthorization,
            );
          },
        });

        return { key: key.toString(), cert };
      } finally {
        await dns.removeAll();
      }
    },
  };
}

export function createCloudflareAcmeIssuer(
  setup: CertificateIssuerSetup,
): CertificateIssuer {
  return createAcmeIssuer({
    directoryUrl: setup.acme.directoryUrl,
    accountEmail: setup.acme.accountEmail,
    store: setup.store,
    dns: createCloudflareDnsChallenge({
      zoneId: setup.acme.cloudflareZoneId,
      token: setup.acme.cloudflareDnsToken,
      log: setup.log,
    }),
    log: setup.log,
  });
}
