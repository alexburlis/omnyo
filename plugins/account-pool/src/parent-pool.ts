import { z } from "zod";
import {
  poolAvailabilitySchema,
  UNAVAILABLE_POOL,
  type PoolAvailability,
} from "./contracts.js";

export const PARENT_URL_ENV = "OMNYO_ACCOUNT_POOL_PARENT_URL";

export const PARENT_TOKEN_ENV = "OMNYO_ACCOUNT_POOL_PARENT_TOKEN";

export const AVAILABILITY_PATH = "/availability";

export const CLAUDE_API_KEY_PROXY_PREFIX = "/claude-api-key";

export const CLAUDE_API_KEY_PROXY_HEADER = "x-omnyo-claude-api-key-proxy";

export const HUB_TOKEN_HEADER = "x-omnyo-account-pool-token";

export function readHubHeaderV1(
  headers: Headers,
): { kind: "absent" } | { kind: "credential"; token: string } {
  const selected = headers.get(HUB_TOKEN_HEADER);

  return selected === null
    ? { kind: "absent" }
    : { kind: "credential", token: selected };
}

const DEFAULT_AVAILABILITY_TTL_MS = 30_000;

const AVAILABILITY_TIMEOUT_MS = 2_000;

const parentUrlSchema = z.string().refine((value) => {
  try {
    const protocol = new URL(value).protocol;

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Must be an HTTP or HTTPS URL.");

const parentTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export interface ParentPool {
  baseUrl: string;
  token: string;
}

export function readParentPool(
  env: NodeJS.ProcessEnv = process.env,
): ParentPool | null {
  const values = { url: env[PARENT_URL_ENV], token: env[PARENT_TOKEN_ENV] };
  const url = parentUrlSchema.safeParse(values.url);
  const token = parentTokenSchema.safeParse(values.token);

  if (values.url === undefined && values.token === undefined) return null;

  if (!url.success || !token.success)
    throw new Error("Invalid parent pool environment");

  return {
    baseUrl: url.data.replace(/\/+$/u, ""),
    token: token.data,
  };
}

export function parentRequestHeaders(inbound: Headers, token: string): Headers {
  const headers = new Headers();

  for (const [name, value] of inbound) {
    const lower = name.toLowerCase();

    if (
      lower === "authorization" ||
      lower === "x-api-key" ||
      lower === HUB_TOKEN_HEADER ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "connection"
    ) {
      continue;
    }

    headers.append(name, value);
  }

  headers.set(HUB_TOKEN_HEADER, token);

  return headers;
}

interface ParentAvailabilityOptions {
  parent: ParentPool;
  fetch: typeof fetch;
  now: () => number;
  ttlMs?: number;
  onError?: (error: unknown) => void;
}

export class ParentAvailability {
  private cached: { value: PoolAvailability; expiresAt: number } | null = null;

  constructor(private readonly options: ParentAvailabilityOptions) {}

  async get(): Promise<PoolAvailability> {
    const cached = this.cached;

    if (cached !== null && cached.expiresAt > this.options.now()) {
      return cached.value;
    }

    const value = await this.load();
    const ttlMs = this.options.ttlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.cached = { value, expiresAt: this.options.now() + ttlMs };

    return value;
  }

  private async load(): Promise<PoolAvailability> {
    try {
      const response = await this.options.fetch(
        `${this.options.parent.baseUrl}${AVAILABILITY_PATH}`,
        {
          method: "GET",
          headers: { [HUB_TOKEN_HEADER]: this.options.parent.token },
          signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
        },
      );

      if (response.ok) {
        const availability = poolAvailabilitySchema.parse(
          await response.json(),
        );

        return {
          ...availability,
          claude:
            availability.claude &&
            response.headers.get(CLAUDE_API_KEY_PROXY_HEADER) === "1",
        };
      }

      this.options.onError?.(
        new Error(`parent availability returned HTTP ${response.status}`),
      );
    } catch (error) {
      this.options.onError?.(error);
    }

    return UNAVAILABLE_POOL;
  }
}
