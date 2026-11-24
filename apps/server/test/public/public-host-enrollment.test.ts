import { spawnSync } from "node:child_process";
import { authApiKeys, getHost, hosts } from "@omnyo/db";
import { defaultKeyHasher } from "@better-auth/api-key";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { setServerAccessBridge } from "../../src/services/plugins/plugin-server-access-registry.js";
import { readJson } from "../helpers/json.js";
import { seedHost, seedSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";

afterEach(() => {
  setPluginMachineProviderBridge(undefined);
  setServerAccessBridge(undefined);
});

describe("machine enrollment header continuity", () => {
  it("reconnects a machine by re-enrolling it, replacing access only when the installer runs", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_reconnect" });
      harness.db
        .update(hosts)
        .set({
          serverAccessProviderId: "relay",
          serverAccessGrantId: host.id,
        })
        .where(eq(hosts.id, host.id))
        .run();
      let accessToken = "old-access";

      const release = vi.fn(async () => {
        accessToken = "new-access";
      });

      const provider = {
        id: "relay",
        displayName: "Relay",
        description: "Test relay",
        availability: () => ({ status: "available" as const }),
        acquire: async () => ({
          id: host.id,
          serverUrl: "https://relay.example.com",
          headers: { "x-access-token": accessToken },
        }),
        release,
      };

      setServerAccessBridge({
        list: () => [{ pluginId: "test", provider }],
        invoke: async (_id, run) => run(),
      });
      const session = seedSession(harness.deps, host.id);
      harness.hub.registerDaemon(session.id, host.id, {
        close: vi.fn(),
        send: vi.fn(),
      });

      const reconnect = () =>
        harness.app.request(`${API}/hosts/${host.id}/reconnect-commands`, {
          method: "POST",
        });

      const refused = await reconnect();
      expect(refused.status).toBe(409);
      expect(await readJson(refused)).toMatchObject({
        code: "machine_reconnect_not_needed",
      });
      harness.hub.unregisterDaemon(session.id);

      const stale = await reconnect();
      expect(stale.status).toBe(201);
      const response = await reconnect();
      expect(response.status).toBe(201);

      const prepared = (await readJson(response)) as {
        command: string;
        expiresAt: number;
        hostId: string;
      };

      expect(prepared).toMatchObject({ hostId: host.id });
      expect(prepared.command).toContain(
        "https://relay.example.com/install.sh",
      );
      expect(release).not.toHaveBeenCalled();

      const credentialOf = (command: string) =>
        /X-Omnyo-Enrollment: ([^']+)/u.exec(command)?.[1] ?? "";

      const credential = credentialOf(prepared.command);
      expect(credential).toMatch(/^omnyode_/u);

      const superseded = await harness.app.request("/install.sh", {
        headers: {
          "X-Omnyo-Enrollment": credentialOf(
            ((await readJson(stale)) as { command: string }).command,
          ),
        },
      });

      expect(superseded.status).toBe(403);
      expect(release).not.toHaveBeenCalled();

      const installer = await harness.app.request("/install.sh", {
        headers: { "X-Omnyo-Enrollment": credential },
      });

      expect(installer.status).toBe(200);
      const script = await installer.text();
      expect(script).toContain("--bootstrap-env OMNYO_ENROLLMENT");
      expect(script).toContain('"reconnect":true');
      expect(script).toContain(`"dataDir":"/tmp/omnyo-host-data/${host.id}"`);
      expect(script).toContain("new-access");
      expect(script).not.toContain("old-access");
      expect(release).toHaveBeenCalledOnce();

      const enrolled = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostId: host.id, hostName: "renamed-by-os" }),
      });

      expect(enrolled.status).toBe(201);
      expect(await readJson(enrolled)).toMatchObject({ hostId: host.id });
      expect(getHost(harness.db, host.id)).toMatchObject({
        name: host.name,
        destroyedAt: null,
      });

      const reused = await harness.app.request("/install.sh", {
        headers: { "X-Omnyo-Enrollment": credential },
      });

      expect(reused.status).toBe(403);
      expect(reused.headers.get("content-type")).toContain(
        "text/x-shellscript",
      );
      const errorText = await reused.text();

      if (process.platform !== "win32") {
        const errorScript = spawnSync("sh", ["-c", errorText], {
          encoding: "utf8",
        });

        expect(errorScript.status).toBe(1);
        expect(errorScript.stderr).toContain(
          "already been used, replaced, or expired",
        );
      }
    });
  });

  it("reads a stored legacy-prefix credential only through the current header", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_legacy_header_v1" });
      harness.db
        .update(hosts)
        .set({
          serverAccessProviderId: "legacy-header-relay",
          serverAccessGrantId: host.id,
        })
        .where(eq(hosts.id, host.id))
        .run();
      const release = vi.fn(async () => {});

      const provider = {
        id: "legacy-header-relay",
        displayName: "Fixture relay",
        description: "Fixture relay",
        availability: () => ({ status: "available" as const }),
        acquire: async () => ({
          id: host.id,
          serverUrl: "https://relay.example",
        }),
        release,
      };

      setServerAccessBridge({
        list: () => [{ pluginId: "test", provider }],
        invoke: async (_id, run) => run(),
      });

      const issued = await harness.deps.machineAuth.issueHostEnrollKey({
        hostId: host.id,
        enrollSource: "reconnect",
      });

      const current = harness.db
        .select()
        .from(authApiKeys)
        .where(eq(authApiKeys.key, await defaultKeyHasher(issued.key)))
        .get();

      if (!current)
        throw new Error("Expected actual library-issued enrollment");

      const credential =
        "bbde_" + "synthetic-legacy-enrollment-fixture".repeat(2);

      const legacy = {
        ...current,
        id: "legacy-enrollment-header-v1",
        key: await defaultKeyHasher(credential),
        prefix: "bbde_",
        start: credential.slice(0, 6),
      };

      harness.db.insert(authApiKeys).values(legacy).run();
      const before = harness.db.select().from(authApiKeys).all();

      const invalid: HeadersInit[] = [
        { "X-Omnyo-Enrollment": "bbde_unknown" },
        { "X-Omnyo-Enrollment": credential + ", " + credential },
        { "X-Omnyo-Enrollment": "" },
      ];

      for (const headers of invalid) {
        const response = await harness.app.request("/install.sh", { headers });
        expect(response.status).toBe(403);
        expect(await response.text()).toContain(
          "already been used, replaced, or expired",
        );
        const windows = await harness.app.request("/install.ps1", { headers });
        expect(await windows.text()).toMatch(/^throw /u);
      }

      const retiredHeader = await harness.app.request("/install.ps1", {
        headers: { "X-BB-Enrollment": credential },
      });

      expect(await retiredHeader.text()).toMatch(
        /^throw 'This installer needs/u,
      );

      expect(release).not.toHaveBeenCalled();
      expect(harness.db.select().from(authApiKeys).all()).toEqual(before);

      for (const update of [
        { expiresAt: new Date(1) },
        { enabled: false },
        { remaining: 0 },
      ]) {
        harness.db
          .update(authApiKeys)
          .set(update)
          .where(eq(authApiKeys.id, legacy.id))
          .run();

        const denied = await harness.app.request("/install.sh", {
          headers: { "X-Omnyo-Enrollment": credential },
        });

        expect(denied.status).toBe(403);
        expect(release).not.toHaveBeenCalled();
        harness.db
          .update(authApiKeys)
          .set(legacy)
          .where(eq(authApiKeys.id, legacy.id))
          .run();
      }

      const installer = await harness.app.request("/install.sh", {
        headers: { "X-Omnyo-Enrollment": credential },
      });

      expect(installer.status).toBe(200);
      expect(await installer.text()).toContain(
        "--bootstrap-env OMNYO_ENROLLMENT",
      );
      expect(release).toHaveBeenCalledOnce();
      expect(harness.db.select().from(authApiKeys).all()).toEqual(before);

      const enrolled = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostId: host.id, hostName: host.name }),
      });

      expect(enrolled.status).toBe(201);

      const consumed = harness.db
        .select()
        .from(authApiKeys)
        .where(eq(authApiKeys.id, legacy.id))
        .get();

      expect(consumed).toMatchObject({
        key: legacy.key,
        prefix: "bbde_",
        referenceId: legacy.referenceId,
      });

      const repeat = await harness.app.request("/install.sh", {
        headers: { "X-Omnyo-Enrollment": credential },
      });

      expect(repeat.status).toBe(403);
      expect(release).toHaveBeenCalledOnce();
      expect(getHost(harness.db, host.id)?.id).toBe(host.id);
    });
  });
});
