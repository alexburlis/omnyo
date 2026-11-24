import { createHash, randomBytes } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LENGTH = 8;

const NORMALIZED_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

const MAX_INPUT_LENGTH = 16;

export const SHORT_ENROLLMENT_CODE_TTL_MS = 10 * 60_000;

export interface ShortEnrollmentCode {
  code: string;
  hash: string;
  expiresAt: number;
}

export function formatShortEnrollmentCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeShortEnrollmentCode(input: string): string | null {
  if (input.length > MAX_INPUT_LENGTH) return null;

  const normalized = input
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll("O", "0")
    .replace(/[IL]/gu, "1");

  return NORMALIZED_CODE.test(normalized) ? normalized : null;
}

export function hashShortEnrollmentCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

export function issueShortEnrollmentCode(input: {
  now: number;
  enrollmentExpiresAt: number;
}): ShortEnrollmentCode {
  const code = [...randomBytes(CODE_LENGTH)]
    .map((byte) => CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length])
    .join("");

  return {
    code: formatShortEnrollmentCode(code),
    hash: hashShortEnrollmentCode(code),
    expiresAt: Math.min(
      input.enrollmentExpiresAt,
      input.now + SHORT_ENROLLMENT_CODE_TTL_MS,
    ),
  };
}

export const SHORT_ENROLLMENT_FAILURE_WINDOW_MS = 10 * 60_000;

export const SHORT_ENROLLMENT_FAILURES_PER_CLIENT = 10;

export const SHORT_ENROLLMENT_FAILURES_GLOBAL = 50;

export interface ShortEnrollmentFailureLimiter {
  blocked(client: string): boolean;
  recordFailure(client: string): void;
}

export function createShortEnrollmentFailureLimiter(
  now: () => number = Date.now,
): ShortEnrollmentFailureLimiter {
  const failures: { at: number; client: string }[] = [];

  function prune(at: number) {
    const cutoff = at - SHORT_ENROLLMENT_FAILURE_WINDOW_MS;

    while (failures[0] !== undefined && failures[0].at <= cutoff)
      failures.shift();
  }

  return {
    blocked(client) {
      prune(now());

      return (
        failures.length >= SHORT_ENROLLMENT_FAILURES_GLOBAL ||
        failures.filter((failure) => failure.client === client).length >=
          SHORT_ENROLLMENT_FAILURES_PER_CLIENT
      );
    },
    recordFailure(client) {
      failures.push({ at: now(), client });
    },
  };
}
