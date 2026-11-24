import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppServerLaunch } from "./bridge.js";

const DEFAULT_ARGS = [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  "-c",
  "features.step_model_switching=true",
];

afterEach(() => vi.unstubAllEnvs());

describe("Codex sub-agent unloading", () => {
  it("unloads a thread as soon as its last subscriber leaves", () => {
    expect(resolveAppServerLaunch({}).args).toEqual(DEFAULT_ARGS);
    expect(
      resolveAppServerLaunch({
        OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND: "/custom/codex",
        OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS: JSON.stringify(["serve"]),
      }).args,
    ).toEqual(["serve", ...DEFAULT_ARGS.slice(1)]);
  });
});

describe("Codex Account Pool launch", () => {
  it("adds an in-memory base URL and environment-backed hub header", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://omnyo.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    const launch = resolveAppServerLaunch();
    expect(launch.command).toBe("codex");
    expect(launch.args).toContain(
      'openai_base_url="https://omnyo.example/pool/v1"',
    );
    expect(launch.args).toContain('model_provider="omnyo-account-pool"');
    expect(launch.args).toContain(
      'model_providers.omnyo-account-pool.env_http_headers.x-omnyo-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    );
    expect(launch.args).toContain(
      "model_providers.omnyo-account-pool.supports_websockets=false",
    );
    expect(
      launch.args.some(
        (value) =>
          value === 'model_provider="bb-account-pool"' ||
          value.startsWith("model_providers.bb-account-pool."),
      ),
    ).toBe(false);
    expect(JSON.stringify(launch.args)).not.toContain("secret-machine-token");
  });

  it("leaves Codex's default transport alone when the pool is not routed", () => {
    const launch = resolveAppServerLaunch({});
    expect(launch).toEqual({ command: "codex", args: DEFAULT_ARGS });
    expect(JSON.stringify(launch.args)).not.toContain("supports_websockets");
  });

  it("does not partially route when either required variable is missing", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://omnyo.example/pool/v1");
    expect(resolveAppServerLaunch()).toEqual({
      command: "codex",
      args: DEFAULT_ARGS,
    });
  });
});

describe("Codex Account Pool isolation", () => {
  it.each([
    { label: "base URL", env: { CODEX_OPENAI_BASE_URL: "" } },
    { label: "hub token", env: { CODEX_POOL_AUTH_TOKEN: "" } },
    {
      label: "both values",
      env: { CODEX_OPENAI_BASE_URL: "", CODEX_POOL_AUTH_TOKEN: "" },
    },
  ])(
    "drops pool routing when an inherited $label is neutralised with an empty value",
    (args) => {
      const launch = resolveAppServerLaunch({
        CODEX_OPENAI_BASE_URL: "https://parent.example/pool/v1",
        CODEX_POOL_AUTH_TOKEN: "inherited-parent-token",
        ...args.env,
      });

      expect(launch).toEqual({ command: "codex", args: DEFAULT_ARGS });
      expect(JSON.stringify(launch.args)).not.toContain("parent.example");
      expect(JSON.stringify(launch.args)).not.toContain(
        "inherited-parent-token",
      );
    },
  );
});
