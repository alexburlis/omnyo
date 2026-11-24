import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_BRIDGE_SESSION_DIR_ENV,
  resolvePiBridgeSessionDir,
  resolvePiSessionFilePath,
} from "./session-paths.js";

const bridgeDataDir = join(
  "/",
  "home",
  "pi-user",
  ".omnyo",
  "plugins",
  "provider-pi",
  "bridge-data",
);

describe("resolvePiBridgeSessionDir", () => {
  it("stores sessions in the daemon-provided bridge data directory, not a fixed home root", () => {
    expect(resolvePiBridgeSessionDir({ env: {}, bridgeDataDir })).toBe(
      join(bridgeDataDir, "pi-bridge-sessions"),
    );
  });

  it("prefers the explicit session directory override", () => {
    const sessionDir = join("/", "tmp", "pi-sessions");

    expect(
      resolvePiBridgeSessionDir({
        env: { [PI_BRIDGE_SESSION_DIR_ENV]: sessionDir },
        bridgeDataDir: null,
      }),
    ).toBe(sessionDir);
  });

  it("refuses to guess a directory before the bridge has started", () => {
    expect(() =>
      resolvePiBridgeSessionDir({ env: {}, bridgeDataDir: null }),
    ).toThrow("the bridge has not started");
  });
});

describe("resolvePiSessionFilePath", () => {
  it("stores each thread's session file under the resolved session directory", () => {
    expect(
      resolvePiSessionFilePath({
        env: {},
        bridgeDataDir,
        threadId: "thr/a b",
      }),
    ).toBe(join(bridgeDataDir, "pi-bridge-sessions", "thr_a_b.jsonl"));
  });
});
