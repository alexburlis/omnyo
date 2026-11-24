import { describe, expect, it } from "vitest";
import {
  SHORT_ENROLLMENT_CODE_TTL_MS,
  SHORT_ENROLLMENT_FAILURE_WINDOW_MS,
  createShortEnrollmentFailureLimiter,
  hashShortEnrollmentCode,
  issueShortEnrollmentCode,
  normalizeShortEnrollmentCode,
} from "./short-enrollment-code.js";

describe("short enrollment codes", () => {
  it("issues dashed Crockford base32 codes without ambiguous letters", () => {
    const codes = new Set<string>();

    for (let index = 0; index < 200; index++) {
      const issued = issueShortEnrollmentCode({
        now: 0,
        enrollmentExpiresAt: Number.MAX_SAFE_INTEGER,
      });

      expect(issued.code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u,
      );
      expect(issued.hash).toBe(
        hashShortEnrollmentCode(issued.code.replace("-", "")),
      );
      expect(issued.hash).not.toContain(issued.code.replace("-", ""));
      codes.add(issued.code);
    }

    expect(codes.size).toBe(200);
  });

  it("caps a code at ten minutes and never outlives its enrollment", () => {
    expect(
      issueShortEnrollmentCode({ now: 1_000, enrollmentExpiresAt: 10 ** 12 })
        .expiresAt,
    ).toBe(1_000 + SHORT_ENROLLMENT_CODE_TTL_MS);
    expect(
      issueShortEnrollmentCode({ now: 1_000, enrollmentExpiresAt: 5_000 })
        .expiresAt,
    ).toBe(5_000);
  });

  it("accepts typed codes in any case, with or without the dash, reading O as 0 and I or L as 1", () => {
    expect(normalizeShortEnrollmentCode("AB1C-0DEF")).toBe("AB1C0DEF");
    expect(normalizeShortEnrollmentCode("ab1c0def")).toBe("AB1C0DEF");
    expect(normalizeShortEnrollmentCode("abic-odef")).toBe("AB1C0DEF");
    expect(normalizeShortEnrollmentCode("ABLC-ODEF")).toBe("AB1C0DEF");
  });

  it("rejects codes of the wrong length, with U or other characters, or oversized input", () => {
    for (const input of [
      "",
      "ABCD-123",
      "ABCD-12345",
      "ABCD-12U4",
      "ABCD 1234",
      "ABCD_1234",
      "ABCD-1234.ps1",
      "AB%2FD-1234",
      "-".repeat(16) + "ABCD1234",
    ])
      expect(normalizeShortEnrollmentCode(input), input).toBeNull();
  });
});

describe("short enrollment failure limiter", () => {
  it("blocks one client after ten failures and everyone after fifty, until the window passes", () => {
    let now = 0;
    const limiter = createShortEnrollmentFailureLimiter(() => now);

    for (let index = 0; index < 10; index++) {
      expect(limiter.blocked("a")).toBe(false);
      limiter.recordFailure("a");
    }

    expect(limiter.blocked("a")).toBe(true);
    expect(limiter.blocked("b")).toBe(false);

    for (let index = 0; index < 40; index++) {
      const client = `client-${index % 5}`;
      expect(limiter.blocked(client)).toBe(false);
      limiter.recordFailure(client);
    }

    expect(limiter.blocked("fresh")).toBe(true);

    now = SHORT_ENROLLMENT_FAILURE_WINDOW_MS - 1;
    expect(limiter.blocked("fresh")).toBe(true);

    now = SHORT_ENROLLMENT_FAILURE_WINDOW_MS;
    expect(limiter.blocked("fresh")).toBe(false);
    expect(limiter.blocked("a")).toBe(false);
  });
});
