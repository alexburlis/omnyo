import { arch, availableParallelism } from "node:os";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import hostEntry from "./host.js";

describe("Concurrency limit host entry", () => {
  it("reports the host's available parallelism", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    await expect(
      harness.experimental_call("getCapacity", null),
    ).resolves.toEqual({ availableParallelism: availableParallelism() });
    await harness.experimental_dispose();
  });

  it("reports this machine's system, architecture and detected tools", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    const facts = await harness.experimental_call("getMachineFacts", null);

    expect(facts).toMatchObject({
      availableParallelism: availableParallelism(),
      os:
        process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : "linux",
      arch: arch(),
    });
    expect(typeof facts.tools.xcode).toBe("boolean");
    await harness.experimental_dispose();
  });
});
