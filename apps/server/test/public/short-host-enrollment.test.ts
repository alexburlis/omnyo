import { spawnSync } from "node:child_process";
import { hosts } from "@omnyo/db";
import type { HostEnrollmentCommandResponse } from "@omnyo/server-contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMachineEnrollmentService } from "../../src/services/machines/machine-services.js";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { setServerAccessBridge } from "../../src/services/plugins/plugin-server-access-registry.js";
import { readJson } from "../helpers/json.js";
import { seedHost } from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";

afterEach(() => {
  setPluginMachineProviderBridge(undefined);
  setServerAccessBridge(undefined);
});

async function pendingManualEnrollment(
  harness: TestAppHarness,
  serverUrl = "https://relay.example.com",
) {
  const host = seedHost(harness.deps, { id: "host_short_code" });
  harness.db
    .update(hosts)
    .set({
      machineProviderId: "manual",
      launchKey: "short-code-launch",
      attempt: 1,
      phase: "creating",
      serverAccessProviderId: "relay",
      serverAccessGrantId: host.id,
    })
    .where(eq(hosts.id, host.id))
    .run();

  setServerAccessBridge({
    list: () => [
      {
        pluginId: "test",
        provider: {
          id: "relay",
          displayName: "Relay",
          description: "Test relay",
          availability: () => ({ status: "available" as const }),
          acquire: async () => ({ id: host.id, serverUrl }),
          release: vi.fn(async () => {}),
        },
      },
    ],
    invoke: async (_id, run) => run(),
  });

  const prepared = await getMachineEnrollmentService(harness.deps)
    .forOwner("core")
    .prepare({
      key: "short-code-launch",
      signal: new AbortController().signal,
    });

  if (prepared.state !== "pending")
    throw new Error("Expected a pending enrollment");

  return { host, bootstrap: prepared.bootstrap };
}

async function enrollmentCommand(
  harness: TestAppHarness,
  hostId: string,
): Promise<HostEnrollmentCommandResponse> {
  const response = await harness.app.request(
    `${API}/hosts/${hostId}/enrollment-command`,
  );

  expect(response.status).toBe(200);

  return (await readJson(response)) as HostEnrollmentCommandResponse;
}

function runShell(script: string) {
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

const FAILED = "invalid, expired, or already used";

describe("short machine setup codes", () => {
  it("serves the enrolled installer for a typed code until the enrollment is used", async () => {
    await withTestHarness(async (harness) => {
      const { host, bootstrap } = await pendingManualEnrollment(harness);
      const first = await enrollmentCommand(harness, host.id);
      const short = first?.shortCommand;

      if (short === undefined) throw new Error("Expected a short command");
      expect(short.code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u,
      );
      expect(short.command).toBe(
        `curl -fsSL https://relay.example.com/m/${short.code} | sh`,
      );
      expect(short.windowsCommand).toBe(
        `irm https://relay.example.com/m/${short.code}.ps1 | iex`,
      );
      expect(short.command).not.toContain(bootstrap.credential);
      expect(short.expiresAt).toBeLessThanOrEqual(bootstrap.expiresAt);
      expect(first?.command).toContain("X-Omnyo-Enrollment");
      expect((await enrollmentCommand(harness, host.id))?.shortCommand).toEqual(
        short,
      );

      const typed = short.code.toLowerCase().replace("-", "");

      for (const path of [`/m/${short.code}`, `/m/${typed}`]) {
        const installer = await harness.app.request(path, {
          headers: { "x-omnyo-gate-auth": "anonymous" },
        });

        expect(installer.status, path).toBe(200);
        expect(installer.headers.get("cache-control")).toBe("no-store");
        expect(installer.headers.get("content-type")).toContain(
          "text/x-shellscript",
        );
        const script = await installer.text();
        expect(script).toContain("--bootstrap-env OMNYO_ENROLLMENT");
        expect(script).toContain(JSON.stringify(bootstrap.credential));
      }

      const windows = await harness.app.request(`/m/${short.code}.ps1`);
      expect(windows.status).toBe(200);
      expect(windows.headers.get("cache-control")).toBe("no-store");
      const windowsScript = await windows.text();
      expect(windowsScript).toContain("$env:OMNYO_ENROLLMENT = ");
      expect(windowsScript).toContain(bootstrap.credential);

      const enrolled = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bootstrap.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostId: host.id, hostName: host.name }),
      });

      expect(enrolled.status).toBe(201);
      expect(await enrollmentCommand(harness, host.id)).toBeNull();

      const used = await harness.app.request(`/m/${short.code}`);
      expect(used.headers.get("cache-control")).toBe("no-store");
      const usedScript = await used.text();
      expect(usedScript).not.toContain(bootstrap.credential);
      expect(usedScript).toContain(FAILED);

      const usedWindows = await harness.app.request(`/m/${short.code}.ps1`);
      expect(await usedWindows.text()).toMatch(/^throw 'This setup code is/u);

      if (process.platform !== "win32") {
        const result = runShell(usedScript);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(FAILED);
      }
    });
  });

  it("shows the short commands as a plain-text page to a browser without the credential", async () => {
    await withTestHarness(async (harness) => {
      const { host, bootstrap } = await pendingManualEnrollment(harness);
      const short = (await enrollmentCommand(harness, host.id))?.shortCommand;

      if (short === undefined) throw new Error("Expected a short command");
      expect(short.pageUrl).toBe(`https://relay.example.com/m/${short.code}`);

      const browserHeaders = (userAgent: string) => ({
        "x-omnyo-gate-auth": "anonymous",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "user-agent": userAgent,
      });

      const typed = short.code.toLowerCase().replace("-", "");

      const mac = await harness.app.request(`/m/${typed}`, {
        headers: browserHeaders("Mozilla/5.0 (Macintosh; Intel Mac OS X)"),
      });

      expect(mac.status).toBe(200);
      expect(mac.headers.get("cache-control")).toBe("no-store");
      expect(mac.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const macPage = await mac.text();
      expect(macPage).not.toContain(bootstrap.credential);
      expect(macPage).not.toContain("OMNYO_ENROLLMENT");
      expect(macPage.indexOf(short.command)).toBeGreaterThan(0);
      expect(macPage.indexOf(short.windowsCommand)).toBeGreaterThan(
        macPage.indexOf(short.command),
      );
      expect(macPage).toContain(`Setup code ${short.code} works once`);

      const windows = await harness.app.request(`/m/${short.code}`, {
        headers: browserHeaders("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
      });

      const windowsPage = await windows.text();
      expect(windowsPage.indexOf(short.windowsCommand)).toBeLessThan(
        windowsPage.indexOf(short.command),
      );

      const script = await harness.app.request(`/m/${short.code}`, {
        headers: { "x-omnyo-gate-auth": "anonymous", accept: "*/*" },
      });

      expect(await script.text()).toContain(
        JSON.stringify(bootstrap.credential),
      );

      const invalid = await harness.app.request("/m/0000-0000", {
        headers: browserHeaders("Mozilla/5.0 (Macintosh)"),
      });

      expect(invalid.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      const invalidPage = await invalid.text();
      expect(invalidPage).toContain(FAILED);
      expect(invalidPage).not.toContain("exit 1");
    });
  });

  it("keeps the server URL's path prefix in the short command", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await pendingManualEnrollment(
        harness,
        "https://relay.example.com/omnyo/",
      );

      const short = (await enrollmentCommand(harness, host.id))?.shortCommand;

      expect(short?.command).toBe(
        `curl -fsSL https://relay.example.com/omnyo/m/${short?.code} | sh`,
      );
      expect(short?.windowsCommand).toBe(
        `irm https://relay.example.com/omnyo/m/${short?.code}.ps1 | iex`,
      );
    });
  });

  it("refuses unknown codes and rate limits repeated failures per client and globally", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await pendingManualEnrollment(harness);
      const short = (await enrollmentCommand(harness, host.id))?.shortCommand;

      if (short === undefined) throw new Error("Expected a short command");
      const wrong = `${short.code.startsWith("0") ? "1" : "0"}${short.code.slice(1)}`;

      const fromClient = (client: string, path: string) =>
        harness.app.request(path, {
          headers: {
            "x-omnyo-gate-auth": "anonymous",
            "x-omnyo-client-ip": client,
          },
        });

      for (let attempt = 0; attempt < 10; attempt++) {
        const refused = await fromClient("198.51.100.1", `/m/${wrong}`);
        expect(refused.headers.get("cache-control")).toBe("no-store");
        expect(await refused.text()).toContain(FAILED);
      }

      const limited = await fromClient("198.51.100.1", `/m/${short.code}`);
      const limitedScript = await limited.text();
      expect(limitedScript).toContain("Too many incorrect setup codes");
      expect(limitedScript).not.toContain("OMNYO_ENROLLMENT");

      if (process.platform !== "win32")
        expect(runShell(limitedScript).status).toBe(1);

      const limitedWindows = await fromClient(
        "198.51.100.1",
        `/m/${short.code}.ps1`,
      );

      expect(await limitedWindows.text()).toMatch(/^throw 'Too many/u);

      const otherClient = await fromClient("198.51.100.2", `/m/${short.code}`);
      expect(await otherClient.text()).toContain("OMNYO_ENROLLMENT");

      for (let attempt = 0; attempt < 40; attempt++)
        await fromClient(`203.0.113.${attempt}`, "/m/not-a-code");

      const globallyLimited = await fromClient(
        "198.51.100.3",
        `/m/${short.code}`,
      );

      expect(await globallyLimited.text()).toContain(
        "Too many incorrect setup codes",
      );
    });
  });
});
