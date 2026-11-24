import { promises as dns } from "node:dns";
import { z } from "zod";
import { errorMessageOf } from "./acme.js";
import type { RelayLogger } from "./contracts.js";

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export const CLOUDFLARE_NAMESERVER_SUFFIX = ".ns.cloudflare.com";

export const PROPAGATION_TIMEOUT_MS = 120_000;

export const PROPAGATION_INTERVAL_MS = 2_000;

const API_TIMEOUT_MS = 15_000;

const CHALLENGE_TTL_SECONDS = 60;

const DNS_QUERY_TIMEOUT_MS = 3_000;

const DNS_QUERY_TRIES = 2;

const NO_RECORD_CODES: ReadonlySet<string> = new Set([
  dns.NODATA,
  dns.NOTFOUND,
]);

export type TxtLookup = (name: string) => Promise<readonly string[]>;

export interface DnsChallenge {
  present(name: string, value: string): Promise<void>;
  remove(name: string, value: string): Promise<void>;
  removeAll(): Promise<void>;
}

export interface CloudflareDnsChallengeOptions {
  zoneId: string;
  token: string;
  log: RelayLogger;
  apiBaseUrl?: string;
  lookupTxt?: TxtLookup;
  propagationTimeoutMs?: number;
  propagationIntervalMs?: number;
}

export class CloudflareDnsError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CloudflareDnsError";
    this.status = status;
  }
}

const envelope = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .default([]),
  result: z.unknown(),
});

const createdRecord = z.object({ id: z.string().min(1) });

function dnsErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;

  return typeof error.code === "string" ? error.code : null;
}

function isNoRecord(error: unknown): boolean {
  const code = dnsErrorCode(error);

  return code !== null && NO_RECORD_CODES.has(code);
}

async function cloudflareNameserverAddresses(name: string): Promise<string[]> {
  const labels = name.split(".");

  for (let index = 1; index < labels.length - 1; index += 1) {
    const zone = labels.slice(index).join(".");
    let hosts: string[];

    try {
      hosts = await dns.resolveNs(zone);
    } catch (error) {
      if (isNoRecord(error)) continue;
      throw error;
    }

    const cloudflare = hosts.filter((host) =>
      host.toLowerCase().endsWith(CLOUDFLARE_NAMESERVER_SUFFIX),
    );

    if (cloudflare.length === 0) continue;

    const addresses = await Promise.all(
      cloudflare.map((host) => dns.resolve4(host).catch(() => [])),
    );

    const flat = addresses.flat();

    if (flat.length === 0) {
      throw new CloudflareDnsError(
        `The Cloudflare nameservers of ${zone} have no IPv4 address`,
      );
    }

    return flat;
  }

  throw new CloudflareDnsError(`No Cloudflare nameservers serve ${name}`);
}

export const authoritativeTxtLookup: TxtLookup = async (name) => {
  const resolver = new dns.Resolver({
    timeout: DNS_QUERY_TIMEOUT_MS,
    tries: DNS_QUERY_TRIES,
  });

  resolver.setServers(await cloudflareNameserverAddresses(name));

  try {
    const records = await resolver.resolveTxt(name);

    return records.map((chunks) => chunks.join(""));
  } catch (error) {
    if (isNoRecord(error)) return [];
    throw error;
  } finally {
    resolver.cancel();
  }
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createCloudflareDnsChallenge(
  options: CloudflareDnsChallengeOptions,
): DnsChallenge {
  const apiBaseUrl = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
  const lookupTxt = options.lookupTxt ?? authoritativeTxtLookup;
  const timeoutMs = options.propagationTimeoutMs ?? PROPAGATION_TIMEOUT_MS;
  const intervalMs = options.propagationIntervalMs ?? PROPAGATION_INTERVAL_MS;
  const { log } = options;
  const created = new Map<string, { name: string; id: string }>();

  async function request(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const label = `Cloudflare DNS API ${method} ${path}`;
    let response: Response;

    try {
      response = await fetch(
        `${apiBaseUrl}/zones/${encodeURIComponent(options.zoneId)}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new CloudflareDnsError(
        `${label} could not be sent: ${errorMessageOf(error)}`,
      );
    }

    const parsed = envelope.safeParse(await response.json().catch(() => null));

    if (response.ok && parsed.success && parsed.data.success) {
      return parsed.data.result;
    }

    const details = parsed.success
      ? parsed.data.errors
          .map((error) => `${error.code} ${error.message}`)
          .join("; ")
      : "unreadable response body";

    throw new CloudflareDnsError(
      `${label} failed with HTTP ${response.status}: ${details || "no error detail"}`,
      response.status,
    );
  }

  async function waitForTxt(name: string, value: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastProblem = "the record was not served yet";

    for (;;) {
      try {
        const values = await lookupTxt(name);

        if (values.includes(value)) return;
        lastProblem = "the record was not served yet";
      } catch (error) {
        lastProblem = errorMessageOf(error);
      }

      if (Date.now() + intervalMs > deadline) {
        throw new CloudflareDnsError(
          `The TXT record ${name} was not visible on the Cloudflare nameservers within ${Math.round(timeoutMs / 1000)} s (${lastProblem})`,
        );
      }

      await delay(intervalMs);
    }
  }

  async function remove(name: string, value: string): Promise<void> {
    const key = `${name}\n${value}`;
    const record = created.get(key);

    if (record === undefined) return;

    try {
      await request("DELETE", `/dns_records/${encodeURIComponent(record.id)}`);
    } catch (error) {
      if (!(error instanceof CloudflareDnsError) || error.status !== 404)
        throw error;
    }

    created.delete(key);
    log.info("acme.dns_record_deleted", { name });
  }

  return {
    async present(name, value) {
      const result = await request("POST", "/dns_records", {
        type: "TXT",
        name,
        content: value,
        ttl: CHALLENGE_TTL_SECONDS,
      });

      const record = createdRecord.safeParse(result);

      if (!record.success) {
        throw new CloudflareDnsError(
          "Cloudflare DNS API POST /dns_records returned no record id",
        );
      }

      created.set(`${name}\n${value}`, { name, id: record.data.id });
      log.info("acme.dns_record_created", { name });

      try {
        await waitForTxt(name, value);
      } catch (error) {
        await remove(name, value).catch((cleanupError: unknown) => {
          log.error("acme.dns_cleanup_failed", {
            name,
            message: errorMessageOf(cleanupError),
          });
        });
        throw error;
      }

      log.info("acme.dns_record_visible", { name });
    },
    remove,
    async removeAll() {
      for (const [key, record] of [...created]) {
        const value = key.slice(record.name.length + 1);

        try {
          await remove(record.name, value);
        } catch (error) {
          log.error("acme.dns_cleanup_failed", {
            name: record.name,
            message: errorMessageOf(error),
          });
        }
      }
    },
  };
}
