import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE } from "@omnyo/host-daemon-contract";
import {
  isTrustedBrokerDescriptorFile,
  readServerBrokerDescriptor,
} from "../src/desktop-browser-broker-client.js";

const privateFile = {
  isFile: true,
  mode: 0o100600,
  ownerUid: 501,
  platform: "darwin" as NodeJS.Platform,
  processUid: 501,
  size: 512,
};

describe("isTrustedBrokerDescriptorFile", () => {
  it("accepts a private file owned by the current user", () => {
    expect(isTrustedBrokerDescriptorFile(privateFile)).toBe(true);
  });

  it("refuses a file other users can read or that another user owns", () => {
    expect(
      isTrustedBrokerDescriptorFile({ ...privateFile, mode: 0o100644 }),
    ).toBe(false);
    expect(
      isTrustedBrokerDescriptorFile({ ...privateFile, ownerUid: 502 }),
    ).toBe(false);
  });

  it("accepts the mode Windows reports for every file", () => {
    expect(
      isTrustedBrokerDescriptorFile({
        ...privateFile,
        mode: 0o100666,
        ownerUid: 0,
        platform: "win32",
        processUid: undefined,
      }),
    ).toBe(true);
  });

  it("refuses directories and oversized files on every platform", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        isTrustedBrokerDescriptorFile({
          ...privateFile,
          platform,
          isFile: false,
        }),
      ).toBe(false);
      expect(
        isTrustedBrokerDescriptorFile({
          ...privateFile,
          platform,
          size: 16385,
        }),
      ).toBe(false);
    }
  });
});

describe("readServerBrokerDescriptor", () => {
  const serverOrigin = "https://coordinator.example.test:8443";
  const brokerValue = "a".repeat(64);
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it.each([".omnyo-machines", ".bb-machines"])(
    "finds a machine broker under %s",
    async (machinesRoot) => {
      const homeDir = await mkdtemp(join(tmpdir(), "omnyo-broker-root-"));
      homes.push(homeDir);

      const dataDir = join(
        homeDir,
        machinesRoot,
        "coordinator.example.test-8443",
      );

      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
        JSON.stringify({
          version: 1,
          hostId: "host_broker",
          serverUrl: serverOrigin,
          url: "ws://127.0.0.1:4000/desktop-browser",
          token: brokerValue,
        }),
        { mode: 0o600 },
      );

      await expect(
        readServerBrokerDescriptor({
          dataDir: join(homeDir, "desktop-profile"),
          homeDir,
          serverOrigin,
          readLaunchId: unexpectedLaunchIdRead,
          differentServers: new Map(),
        }),
      ).resolves.toMatchObject({ hostId: "host_broker" });
    },
  );

  async function writeLoopbackBroker() {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-broker-data-"));
    homes.push(dataDir);
    await writeFile(
      join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
      JSON.stringify({
        version: 1,
        hostId: "host_coordinator",
        serverUrl: "http://127.0.0.1:38886",
        url: "ws://127.0.0.1:4001/desktop-browser",
        token: brokerValue,
      }),
      { mode: 0o600 },
    );

    return dataDir;
  }

  function launchIds(byOrigin: Record<string, string | null | Error>) {
    const reads: string[] = [];

    return {
      reads,
      async read(origin: string) {
        reads.push(origin);
        const value = byOrigin[origin];

        if (value === undefined)
          throw new Error(`Unexpected read of ${origin}`);

        if (value instanceof Error) throw value;

        return value;
      },
    };
  }

  it("pairs with the coordinator's loopback broker when both addresses report the same server launch", async () => {
    const dataDir = await writeLoopbackBroker();

    const identity = launchIds({
      [serverOrigin]: "launch-1",
      "http://127.0.0.1:38886": "launch-1",
    });

    await expect(
      readServerBrokerDescriptor({
        dataDir,
        homeDir: dataDir,
        serverOrigin,
        readLaunchId: identity.read,
        differentServers: new Map(),
      }),
    ).resolves.toMatchObject({ hostId: "host_coordinator" });
  });

  it.each([
    ["another server launch", "launch-2"],
    ["no launch identity", null],
  ])(
    "refuses a broker whose server reports %s and does not ask again within a minute",
    async (_label, brokerLaunchId) => {
      const dataDir = await writeLoopbackBroker();

      const identity = launchIds({
        [serverOrigin]: "launch-1",
        "http://127.0.0.1:38886": brokerLaunchId,
      });

      const differentServers = new Map<string, number>();

      const read = () =>
        readServerBrokerDescriptor({
          dataDir,
          homeDir: dataDir,
          serverOrigin,
          readLaunchId: identity.read,
          differentServers,
        });

      await expect(read()).rejects.toThrow("No desktop broker found");
      await expect(read()).rejects.toThrow("No desktop broker found");
      expect(identity.reads).toHaveLength(2);
    },
  );

  it("asks again after a server identity read fails", async () => {
    const dataDir = await writeLoopbackBroker();

    const identity = launchIds({
      [serverOrigin]: "launch-1",
      "http://127.0.0.1:38886": new Error("connection refused"),
    });

    const differentServers = new Map<string, number>();

    const read = () =>
      readServerBrokerDescriptor({
        dataDir,
        homeDir: dataDir,
        serverOrigin,
        readLaunchId: identity.read,
        differentServers,
      });

    await expect(read()).rejects.toThrow("No desktop broker found");
    await expect(read()).rejects.toThrow("No desktop broker found");
    expect(identity.reads).toHaveLength(4);
    expect(differentServers.size).toBe(0);
  });
});

async function unexpectedLaunchIdRead(origin: string): Promise<string> {
  throw new Error(`Unexpected server identity read of ${origin}`);
}
