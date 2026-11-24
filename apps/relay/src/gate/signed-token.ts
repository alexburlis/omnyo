import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { z } from "zod";

export const GATE_KEY_LABEL = "omnyo-relay gate v1";

export const DESKTOP_KEY_LABEL = "omnyo-relay desktop v1";

const KEY_BYTES = 32;

export interface PurposeKey {
  readonly label: string;
  readonly bytes: Buffer;
}

export function derivePurposeKey(secret: string, label: string): PurposeKey {
  return {
    label,
    bytes: Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(secret, "utf8"),
        Buffer.alloc(0),
        label,
        KEY_BYTES,
      ),
    ),
  };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function sha256HexOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeTextEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();

  return timingSafeEqual(left, right) && a.length === b.length;
}

function mac(key: PurposeKey, payload: string): string {
  return createHmac("sha256", key.bytes)
    .update(payload, "utf8")
    .digest("base64url");
}

export function signToken(key: PurposeKey, payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );

  return `${encoded}.${mac(key, encoded)}`;
}

export function verifyToken<T>(
  key: PurposeKey,
  token: string,
  schema: z.ZodType<T>,
): T | null {
  const dot = token.indexOf(".");

  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!constantTimeTextEqual(signature, mac(key, encoded))) return null;
  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = schema.safeParse(decoded);

  return parsed.success ? parsed.data : null;
}
