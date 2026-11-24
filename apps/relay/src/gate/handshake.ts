import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { verification } from "@omnyo/connect-db";
import { z } from "zod";
import type { RelayDb } from "../db.js";
import { NONCE_COOKIE, hostCookieWithMaxAge } from "./cookies.js";
import {
  constantTimeTextEqual,
  randomToken,
  sha256Base64Url,
  sha256HexOf,
} from "./signed-token.js";

export const GATE_CODE_TTL_MS = 60_000;

export const NONCE_MAX_AGE_SECONDS = 600;

export const AUTHORIZE_PATH = "/relay/authorize";

export const CALLBACK_PATH = "/__omnyo/callback";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const IDENTIFIER_PREFIX = "gate-grant:";

const grantValueSchema = z.object({
  userId: z.string().min(1),
  host: z.string().min(1),
  sessionId: z.string().min(1),
  return: z.string().min(1),
  n: z.string().regex(TOKEN_PATTERN),
});

export type GateGrantValue = z.infer<typeof grantValueSchema>;

export function isWellFormedToken(value: string | null): value is string {
  return value !== null && TOKEN_PATTERN.test(value);
}

export function newNonce(): {
  nonce: string;
  setCookie: string;
  digest: string;
} {
  const nonce = randomToken();

  return {
    nonce,
    digest: sha256Base64Url(nonce),
    setCookie: hostCookieWithMaxAge(NONCE_COOKIE, nonce, NONCE_MAX_AGE_SECONDS),
  };
}

export function nonceCookieFor(nonce: string): {
  setCookie: string;
  digest: string;
} {
  return {
    digest: sha256Base64Url(nonce),
    setCookie: hostCookieWithMaxAge(NONCE_COOKIE, nonce, NONCE_MAX_AGE_SECONDS),
  };
}

export function nonceMatches(nonce: string | null, digest: string): boolean {
  return (
    isWellFormedToken(nonce) &&
    constantTimeTextEqual(sha256Base64Url(nonce), digest)
  );
}

export function authorizeUrl(
  appUrl: string,
  host: string,
  returnPath: string,
  digest: string,
): string {
  const url = new URL(AUTHORIZE_PATH, appUrl);
  url.searchParams.set("host", host);
  url.searchParams.set("return", returnPath);
  url.searchParams.set("n", digest);

  return url.toString();
}

export function mintGateCode(
  db: RelayDb,
  value: GateGrantValue,
  now: number,
): string {
  const code = randomToken();

  db.insert(verification)
    .values({
      id: randomUUID(),
      identifier: `${IDENTIFIER_PREFIX}${sha256HexOf(code)}`,
      value: JSON.stringify(value),
      expiresAt: new Date(now + GATE_CODE_TTL_MS),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .run();

  return code;
}

export function consumeGateCode(
  db: RelayDb,
  code: string,
  now: number,
): GateGrantValue | null {
  if (!isWellFormedToken(code)) return null;

  const row = db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, `${IDENTIFIER_PREFIX}${sha256HexOf(code)}`),
        gt(verification.expiresAt, new Date(now)),
      ),
    )
    .returning({ value: verification.value })
    .get();

  if (row === undefined) return null;
  let decoded: unknown;

  try {
    decoded = JSON.parse(row.value);
  } catch {
    return null;
  }

  const parsed = grantValueSchema.safeParse(decoded);

  return parsed.success ? parsed.data : null;
}
