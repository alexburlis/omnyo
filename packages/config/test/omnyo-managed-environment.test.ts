import { describe, expect, it } from "vitest";
import {
  appManagedEnvFileSchema,
  parseAppManagedConfig,
} from "../src/managed-app-config.js";

describe("Omnyo managed environment continuity", () => {
  it("imports exact saved V1 configuration keys and emits only canonical keys", () => {
    const input = {
      config: { BB_APP_URL: "http://127.0.0.1:4840", BB_LOG_LEVEL: "debug" },
    };

    const original = structuredClone(input);
    expect(parseAppManagedConfig(input)).toEqual({
      config: {
        OMNYO_APP_URL: "http://127.0.0.1:4840",
        OMNYO_LOG_LEVEL: "debug",
      },
    });
    expect(input).toEqual(original);
  });

  it("accepts equal dual saved values but refuses different values", () => {
    expect(
      parseAppManagedConfig({
        config: { BB_LOG_LEVEL: "debug", OMNYO_LOG_LEVEL: "debug" },
      }),
    ).toEqual({ config: { OMNYO_LOG_LEVEL: "debug" } });
    expect(() =>
      parseAppManagedConfig({
        config: { BB_LOG_LEVEL: "debug", OMNYO_LOG_LEVEL: "error" },
      }),
    ).toThrow();
  });

  it("normalizes known environment names while preserving user variables and source bytes", () => {
    const input = {
      env: {
        BB_SERVER_PORT: "4840",
        USER_CHOICE: "unchanged",
        BB_USER_OWNED_UNKNOWN: "opaque user data",
      },
    };

    const original = structuredClone(input);
    expect(appManagedEnvFileSchema.parse(input)).toEqual({
      env: {
        OMNYO_SERVER_PORT: "4840",
        USER_CHOICE: "unchanged",
        BB_USER_OWNED_UNKNOWN: "opaque user data",
      },
    });
    expect(input).toEqual(original);
  });

  it("refuses conflicting environment sources without exposing their values", () => {
    const input = {
      env: {
        BB_HOST_ENROLL_KEY: "first-enroll-fixture",
        OMNYO_HOST_ENROLL_KEY: "second-enroll-fixture",
      },
    };

    let failure: unknown;

    try {
      appManagedEnvFileSchema.parse(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(input.env.BB_HOST_ENROLL_KEY);
    expect(String(failure)).not.toContain(input.env.OMNYO_HOST_ENROLL_KEY);
  });

  it("refuses malformed saved values and unknown structured config keys", () => {
    expect(() =>
      parseAppManagedConfig({ config: { BB_LOG_LEVEL: 12 } }),
    ).toThrow();
    expect(() =>
      appManagedEnvFileSchema.parse({ env: { BB_SERVER_PORT: 12 } }),
    ).toThrow();
    expect(() =>
      parseAppManagedConfig({ config: { userSetting: "unsupported" } }),
    ).toThrow();
  });
});
