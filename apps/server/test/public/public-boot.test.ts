import { describe, expect, it } from "vitest";
import {
  BOOT_PART_NAMES,
  BOOT_PART_PATHS,
  bootResponseSchema,
  type BootPartName,
} from "@omnyo/server-contract";
import {
  startTestServer,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const MACHINE_HEADERS = { "x-omnyo-gate-auth": "machine" };

const STABLE_PARTS: readonly BootPartName[] = [
  "uiPreferences",
  "serverMove",
  "pluginInstallJobs",
  "pluginUpdateJobs",
  "hosts",
  "sidebarBootstrap",
  "pluginSafeMode",
  "shelvedThreads",
  "threadAttention",
];

type Harness = TestAppHarness;

async function readBoot(
  harness: Harness,
  path = "/api/v1/boot",
  headers: Record<string, string> = {},
) {
  const response = await harness.app.request(path, { headers });

  expect(response.status).toBe(200);

  return bootResponseSchema.parse(await response.json());
}

async function readIndividually(
  harness: Harness,
  name: BootPartName,
  headers: Record<string, string> = {},
) {
  const response = await harness.app.request(
    `/api/v1${BOOT_PART_PATHS[name]}`,
    { headers },
  );

  return { status: response.status, body: await response.json() };
}

describe("/api/v1/boot", () => {
  it("treats an aborted startup read as cancellation instead of a server failure", () =>
    withTestHarness(async (harness) => {
      const controller = new AbortController();
      controller.abort();

      const response = await harness.app.request(
        "/api/v1/boot?parts=systemVersion",
        { signal: controller.signal },
      );

      expect(response.status).toBe(499);
    }));

  it("reads every startup part through the production HTTP response adapter", async () => {
    const server = await startTestServer();

    try {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => fetch(`${server.baseUrl}/api/v1/boot`)),
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        const boot = bootResponseSchema.parse(await response.json());
        expect(Object.keys(boot.parts).sort()).toEqual(
          [...BOOT_PART_NAMES].sort(),
        );
      }
    } finally {
      await server.close();
    }
  });

  it("returns every first-screen read with the same status and body as its own route", () =>
    withTestHarness(async (harness) => {
      const boot = await readBoot(harness);

      expect(Object.keys(boot.parts).sort()).toEqual(
        [...BOOT_PART_NAMES].sort(),
      );
      expect(boot.serverIdentity).toMatch(/^[a-f0-9]{64}$/u);

      for (const name of STABLE_PARTS)
        expect(boot.parts[name]).toEqual(await readIndividually(harness, name));

      expect(boot.parts.systemConfig?.status).toBe(200);
      expect(boot.parts.systemVersion?.status).toBe(200);
      expect(boot.parts.plugins?.status).toBe(200);
    }));

  it("refuses machine sessions exactly what their individual routes refuse", () =>
    withTestHarness(async (harness) => {
      const boot = await readBoot(harness, "/api/v1/boot", MACHINE_HEADERS);

      const serverMove = await readIndividually(
        harness,
        "serverMove",
        MACHINE_HEADERS,
      );

      expect(serverMove.status).toBe(403);
      expect(boot.parts.serverMove).toEqual(serverMove);
      expect(boot.parts.serverMove?.body).toMatchObject({
        code: "machine_host_management_forbidden",
      });

      for (const name of STABLE_PARTS)
        expect(boot.parts[name]).toEqual(
          await readIndividually(harness, name, MACHINE_HEADERS),
        );
    }));

  it("refuses credentialed callers the server move status as its route does", () =>
    withTestHarness(async (harness) => {
      const headers = { authorization: "Bearer not-a-session" };
      const boot = await readBoot(harness, "/api/v1/boot", headers);

      expect(boot.parts.serverMove).toEqual(
        await readIndividually(harness, "serverMove", headers),
      );
      expect(boot.parts.serverMove?.status).toBe(403);
    }));

  it("reads only the requested parts", () =>
    withTestHarness(async (harness) => {
      const boot = await readBoot(
        harness,
        "/api/v1/boot?parts=systemVersion%2Chosts",
      );

      expect(Object.keys(boot.parts).sort()).toEqual([
        "hosts",
        "systemVersion",
      ]);
    }));

  it("rejects unknown parts", () =>
    withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/boot?parts=hosts,notAPart",
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }));

  it("keeps the same server identity across reads", () =>
    withTestHarness(async (harness) => {
      const first = await readBoot(harness, "/api/v1/boot?parts=hosts");
      const second = await readBoot(harness, "/api/v1/boot?parts=hosts");

      expect(second.serverIdentity).toBe(first.serverIdentity);
    }));
});
