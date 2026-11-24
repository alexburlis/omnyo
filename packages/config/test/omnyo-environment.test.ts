import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCliConfig } from "../src/cli.js";
import { loadHostDaemonEntrypointConfig } from "../src/host-daemon-entrypoint.js";
import { loadServerConfig } from "../src/server.js";
import {
  resolveRuntimeDataDir,
  stripThreadContextEnv,
} from "../src/runtime.js";
import { importLegacyConfigEnvironmentV1 } from "../src/omnyo-environment.js";

afterEach(() => vi.unstubAllGlobals());

describe("Omnyo config environment bridge", () => {
  it("uses the same explicit profile and ports from canonical names", () => {
    const env = {
      NODE_ENV: "production",
      OMNYO_DATA_DIR: "/fixture/profile",
      OMNYO_SERVER_URL: "https://fixture.example",
      OMNYO_SERVER_PORT: "4567",
      OMNYO_HOST_DAEMON_PORT: "4568",
    };

    expect(loadCliConfig({ env })).toEqual({
      OMNYO_SERVER_URL: "https://fixture.example",
      OMNYO_HOST_DAEMON_PORT: 4568,
    });
    expect(
      resolveRuntimeDataDir({ env, homeDir: "/fixture/home", mode: "prod" }),
    ).toBe("/fixture/profile");
    expect(loadServerConfig({ env }).OMNYO_SERVER_PORT).toBe(4567);
  });

  it("ignores old process environment names at the live read path", () => {
    expect(
      resolveRuntimeDataDir({
        env: {
          BB_DATA_DIR: "/old-profile",
          OMNYO_DATA_DIR: "/current-profile",
        },
        homeDir: "/fixture/home",
        mode: "prod",
      }),
    ).toBe("/current-profile");
    expect(
      loadServerConfig({
        env: {
          NODE_ENV: "production",
          BB_SERVER_PORT: "1234",
          OMNYO_DATA_DIR: "/current-profile",
        },
      }).OMNYO_SERVER_PORT,
    ).not.toBe(1234);
  });

  it("reads a host enrollment key only from the canonical name", () => {
    expect(
      loadHostDaemonEntrypointConfig({
        env: {
          BB_HOST_ENROLL_KEY: "old-enroll-fixture",
          OMNYO_HOST_ENROLL_KEY: "new-enroll-fixture",
        },
      }),
    ).toMatchObject({ OMNYO_HOST_ENROLL_KEY: "new-enroll-fixture" });
  });

  it.each(["", "not-a-port", "65536"])(
    "does not replace a malformed canonical port with the default (%j)",
    (value) => {
      expect(() =>
        loadServerConfig({
          env: { NODE_ENV: "production", OMNYO_SERVER_PORT: value },
          homeDir: "/fixture/home",
        }),
      ).toThrow(/valid TCP port/);
    },
  );

  it("refuses conflicting saved environment entries instead of selecting a blank profile", () => {
    expect(() =>
      importLegacyConfigEnvironmentV1({
        BB_DATA_DIR: "/old",
        OMNYO_DATA_DIR: "/new",
      }),
    ).toThrow(/Conflicting environment values/);
  });

  it("imports known keys once and emits only canonical keys without mutating its input", () => {
    const input = {
      BB_HOST_ENROLL_KEY: "enroll-fixture",
      OMNYO_HOST_ENROLL_KEY: "enroll-fixture",
      BB_USER_OWNED_UNKNOWN: "unmapped-fixture",
      PATH: "/bin",
    };

    const before = { ...input };
    const converted = importLegacyConfigEnvironmentV1(input);
    expect(converted).toEqual({
      OMNYO_HOST_ENROLL_KEY: "enroll-fixture",
      BB_USER_OWNED_UNKNOWN: "unmapped-fixture",
      PATH: "/bin",
    });
    expect(importLegacyConfigEnvironmentV1(converted)).toEqual(converted);
    expect(input).toEqual(before);
  });

  it("refuses Windows case aliases with differing credential values", () => {
    vi.stubGlobal(
      "process",
      Object.create(process, { platform: { value: "win32" } }),
    );
    expect(() =>
      importLegacyConfigEnvironmentV1({
        bb_host_enroll_key: "first-enroll-fixture",
        BB_HOST_ENROLL_KEY: "second-enroll-fixture",
      }),
    ).toThrow(/Conflicting environment values/);
    expect(
      importLegacyConfigEnvironmentV1({ omnyo_host_id: "host-fixture" }),
    ).toEqual({
      OMNYO_HOST_ID: "host-fixture",
    });
    expect(
      stripThreadContextEnv({
        bB_ThRead_Id: "old-thread-fixture",
        omnyo_thread_id: "new-thread-fixture",
        OMNYO_ENVIRONMENT_ID: "environment-fixture",
        BB_THREAD_STORAGE: "/fixture/storage",
        PATH: "/bin",
      }),
    ).toEqual({
      bB_ThRead_Id: "old-thread-fixture",
      BB_THREAD_STORAGE: "/fixture/storage",
      PATH: "/bin",
    });
  });
});
