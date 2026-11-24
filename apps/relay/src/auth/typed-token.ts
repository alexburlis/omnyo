import { createHmac, timingSafeEqual } from "node:crypto";
import type { z } from "zod";

export const TYPED_TOKEN_VERSION = "v1";

const SEPARATOR = ".";

export type TokenType = "gate" | "desktop";

function mac(key: Buffer, typ: TokenType, body: string): Buffer {
  return createHmac("sha256", key)
    .update(`${TYPED_TOKEN_VERSION}${SEPARATOR}${typ}${SEPARATOR}${body}`)
    .digest();
}

export function signTypedToken(
  key: Buffer,
  typ: TokenType,
  payload: Readonly<Record<string, unknown>>,
): string {
  if ("typ" in payload && payload.typ !== typ) {
    throw new Error(`Token payload typ must be ${typ}`);
  }

  const body = Buffer.from(
    JSON.stringify({ ...payload, typ }),
    "utf8",
  ).toString("base64url");

  return `${TYPED_TOKEN_VERSION}${SEPARATOR}${body}${SEPARATOR}${mac(key, typ, body).toString("base64url")}`;
}

export function verifyTypedToken<T extends { typ: TokenType }>(
  key: Buffer,
  typ: TokenType,
  token: string,
  schema: z.ZodType<T>,
): T | null {
  const parts = token.split(SEPARATOR);

  if (parts.length !== 3 || parts[0] !== TYPED_TOKEN_VERSION) return null;
  const [, body, signature] = parts;

  if (!body || !signature) return null;
  const presented = Buffer.from(signature, "base64url");
  const expected = mac(key, typ, body);

  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = schema.safeParse(decoded);

  if (!parsed.success || parsed.data.typ !== typ) return null;

  return parsed.data;
}
