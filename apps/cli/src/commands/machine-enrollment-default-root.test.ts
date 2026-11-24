import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enrollMachine } from "./machine-enrollment.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("machine enrollment default data directory", () => {
  it("writes a new enrollment under the Omnyo machines root", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "omnyo-enroll-root-"));
    homes.push(homeDir);

    const issued = ["synthetic", "bootstrap", "value"].join("-");
    const hostKey = ["synthetic", "machine", "key"].join("-");

    const result = await enrollMachine(
      { bootstrapEnv: "ENROLLMENT_INPUT" },
      {
        homeDir,
        env: {
          ENROLLMENT_INPUT: JSON.stringify({
            hostId: "host_default_root",
            serverUrl: "https://coordinator.example.test:8443",
            credential: issued,
            expiresAt: Date.now() + 60_000,
          }),
        },
        fetchFn: async () =>
          new Response(
            JSON.stringify({ hostId: "host_default_root", hostKey }),
            { status: 201 },
          ),
      },
    );

    const dataDir = join(
      homeDir,
      ".omnyo-machines",
      "coordinator.example.test-8443",
    );

    expect(result).toEqual({ hostId: "host_default_root" });
    expect((await readFile(join(dataDir, "host-id"), "utf8")).trim()).toBe(
      "host_default_root",
    );
    expect(existsSync(join(homeDir, ".bb-machines"))).toBe(false);
  });
});
