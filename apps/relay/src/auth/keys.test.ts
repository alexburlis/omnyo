import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveRelayKey, deriveRelayKeys, RELAY_KEY_BYTES } from "./keys.js";
import { signTypedToken, verifyTypedToken } from "./typed-token.js";

const ROOT = "keys-root-material-for-tests-only-0123456789abcd";

const gateSchema = z.object({
  typ: z.literal("gate"),
  userId: z.string(),
  host: z.string(),
  exp: z.number(),
});

const desktopSchema = z.object({
  typ: z.literal("desktop"),
  userId: z.string(),
  exp: z.number(),
});

describe("relay keys", () => {
  it("derives distinct, stable 32-byte keys per purpose", () => {
    const first = deriveRelayKeys(ROOT);
    const second = deriveRelayKeys(ROOT);

    expect(first.gate).toHaveLength(RELAY_KEY_BYTES);
    expect(first.desktop).toHaveLength(RELAY_KEY_BYTES);
    expect(first.gate.equals(second.gate)).toBe(true);
    expect(first.gate.equals(first.desktop)).toBe(false);
    expect(first.betterAuthSecret).not.toBe(ROOT);
    expect(first.betterAuthSecret).not.toBe(first.gate.toString("base64url"));
    expect(first.betterAuthSecret).not.toBe(
      first.desktop.toString("base64url"),
    );
    expect(
      deriveRelayKey(`${ROOT}x`, "gate").equals(deriveRelayKey(ROOT, "gate")),
    ).toBe(false);
  });

  it("refuses an empty root secret", () => {
    expect(() => deriveRelayKeys("")).toThrow("BETTER_AUTH_SECRET");
  });
});

describe("typed tokens", () => {
  const keys = deriveRelayKeys(ROOT);
  const gatePayload = { userId: "u1", host: "alice.relay.example", exp: 99 };

  it("round-trips a payload with its typ", () => {
    const token = signTypedToken(keys.gate, "gate", gatePayload);

    expect(verifyTypedToken(keys.gate, "gate", token, gateSchema)).toEqual({
      ...gatePayload,
      typ: "gate",
    });
  });

  it("refuses a gate token presented as a desktop token, and the reverse", () => {
    const gate = signTypedToken(keys.gate, "gate", gatePayload);

    const desktop = signTypedToken(keys.desktop, "desktop", {
      userId: "u1",
      exp: 99,
    });

    expect(
      verifyTypedToken(keys.desktop, "desktop", gate, desktopSchema),
    ).toBeNull();
    expect(verifyTypedToken(keys.gate, "gate", desktop, gateSchema)).toBeNull();
    expect(
      verifyTypedToken(keys.gate, "desktop", gate, desktopSchema),
    ).toBeNull();
    expect(
      verifyTypedToken(keys.desktop, "gate", desktop, gateSchema),
    ).toBeNull();
  });

  it("refuses tampered, truncated and foreign-key tokens", () => {
    const token = signTypedToken(keys.gate, "gate", gatePayload);
    const [version, body, mac] = token.split(".");

    const forged = Buffer.from(
      JSON.stringify({ ...gatePayload, userId: "u2", typ: "gate" }),
    ).toString("base64url");

    expect(
      verifyTypedToken(
        keys.gate,
        "gate",
        `${version}.${forged}.${mac}`,
        gateSchema,
      ),
    ).toBeNull();
    expect(
      verifyTypedToken(keys.gate, "gate", `${version}.${body}`, gateSchema),
    ).toBeNull();
    expect(
      verifyTypedToken(keys.gate, "gate", `v0.${body}.${mac}`, gateSchema),
    ).toBeNull();
    expect(
      verifyTypedToken(
        deriveRelayKeys(`${ROOT}-other`).gate,
        "gate",
        token,
        gateSchema,
      ),
    ).toBeNull();
  });

  it("refuses a validly signed payload that fails its schema", () => {
    const token = signTypedToken(keys.gate, "gate", { userId: "u1" });

    expect(verifyTypedToken(keys.gate, "gate", token, gateSchema)).toBeNull();
  });

  it("refuses to sign a payload whose typ disagrees", () => {
    expect(() =>
      signTypedToken(keys.gate, "gate", { ...gatePayload, typ: "desktop" }),
    ).toThrow("typ");
  });
});
