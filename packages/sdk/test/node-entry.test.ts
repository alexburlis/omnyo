import { afterEach, describe, expect, it, vi } from "vitest";

const NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS = 15_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("@omnyo/sdk/node entry", () => {
  it(
    "imports and builds explicit SDKs without Omnyo server configuration",
    async () => {
      vi.stubEnv("OMNYO_SERVER_URL", undefined);
      vi.stubEnv("OMNYO_HOST_DAEMON_PORT", undefined);

      const nodeEntry = await import("../src/node.js");
      const sdk = nodeEntry.createNodeOmnyoSdk({ baseUrl: "http://server" });

      expect(typeof sdk.threads.list).toBe("function");
    },
    NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS,
  );
});
