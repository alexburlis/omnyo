import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isSealed,
  openSecretVault,
  type SecretVault,
} from "@omnyo/secret-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginSecretStore,
  type PluginSecretStore,
} from "../../../src/services/plugins/plugin-secrets.js";
import { testLogger } from "../../helpers/test-app.js";

let dataDir: string;

let vault: SecretVault;

let store: PluginSecretStore;

function secretPath(name: string): string {
  return join(dataDir, "plugins", "pool", "secrets", ...name.split("/"));
}

async function writeLegacy(name: string, value: string): Promise<void> {
  await mkdir(dirname(secretPath(name)), { recursive: true });
  await writeFile(secretPath(name), value, { mode: 0o600 });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-secrets-"));
  vault = await openSecretVault(dataDir);
  store = createPluginSecretStore({
    logger: testLogger,
    pluginId: "pool",
    vault,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("plugin secret store", () => {
  it("keeps only ciphertext on disk and reads nested names back", async () => {
    await store.set("accounts/acct_1.json", '{"token":"tok-41c2"}');

    const stored = await readFile(secretPath("accounts/acct_1.json"), "utf8");
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain("tok-41c2");
    expect(await store.get("accounts/acct_1.json")).toBe(
      '{"token":"tok-41c2"}',
    );
    expect(await store.has("accounts/acct_1.json")).toBe(true);

    await store.delete("accounts/acct_1.json");
    expect(await store.get("accounts/acct_1.json")).toBeUndefined();
    expect(await store.has("accounts/acct_1.json")).toBe(false);
  });

  it.each([
    "",
    ".hidden",
    "accounts/.hidden",
    ".http-token",
    "a//b",
    "a/../b",
    "a/b/c/d/e",
    "spaces are invalid",
    `a/${"x".repeat(200)}`,
  ])("rejects the name %j before touching the disk", async (name) => {
    await expect(store.set(name, "value")).rejects.toThrow(
      "invalid secret name",
    );
    await expect(store.get(name)).rejects.toThrow("invalid secret name");
  });

  it("lists names by plain string prefix, sorted, skipping dot-names", async () => {
    await store.set("accounts/hub-token-host_mac.json", "m");
    await store.set("accounts/hub-token-host_pc.json", "p");
    await store.set("accounts/account-1.json", "a");
    await store.set("hub-token", "h");
    await writeLegacy(".http-token", "token");
    await writeLegacy("accounts/.account-1.json.0123456789ab.tmp", "partial");

    expect(await store.list()).toEqual([
      "accounts/account-1.json",
      "accounts/hub-token-host_mac.json",
      "accounts/hub-token-host_pc.json",
      "hub-token",
    ]);
    expect(await store.list("accounts/hub-token-")).toEqual([
      "accounts/hub-token-host_mac.json",
      "accounts/hub-token-host_pc.json",
    ]);
    expect(await store.list("hub")).toEqual(["hub-token"]);
  });

  it("seals a legacy plaintext secret in place when it is read", async () => {
    await writeLegacy("apiKey", "sk-legacy-1");

    expect(await store.get("apiKey")).toBe("sk-legacy-1");
    const stored = await readFile(secretPath("apiKey"), "utf8");
    expect(isSealed(stored)).toBe(true);
    expect(vault.open(stored)).toBe("sk-legacy-1");
  });

  it("seals every regular legacy file once, byte for byte, including the HTTP token and odd names", async () => {
    const legacy = {
      "accounts/a.json": '{"token":"account-a"}\n',
      "accounts/account-1.json.6f1c9a2e-55aa-4c1e-9d0b-1b2c3d4e5f60.tmp":
        "leftover-plaintext",
      "deep/a/b/c/d/too-deep": "deep-value",
      ".http-token": `${"f".repeat(64)}\n`,
    };

    for (const [name, value] of Object.entries(legacy))
      await writeLegacy(name, value);

    await writeLegacy("accounts/.a.json.0123456789ab.tmp", "partial");
    await symlink(
      secretPath("accounts/a.json"),
      secretPath("accounts/link.json"),
    );

    await store.sealLegacyTreeOnce();

    for (const [name, value] of Object.entries(legacy)) {
      const stored = await readFile(secretPath(name), "utf8");
      expect(isSealed(stored)).toBe(true);
      expect(vault.open(stored)).toBe(value);
    }

    expect(
      await readFile(secretPath("accounts/.a.json.0123456789ab.tmp"), "utf8"),
    ).toBe("partial");
    expect(
      (await lstat(secretPath("accounts/link.json"))).isSymbolicLink(),
    ).toBe(true);
    expect(await store.httpToken({ rotate: false })).toBe("f".repeat(64));
  });

  it("never lets a lazy seal overwrite a concurrent write of the same secret", async () => {
    for (let round = 0; round < 20; round += 1) {
      await writeLegacy("apiKey", "old-value");

      await Promise.all([
        store.get("apiKey"),
        store.set("apiKey", "new-value"),
      ]);

      expect(await store.get("apiKey")).toBe("new-value");
    }
  });

  it("creates a sealed HTTP token, keeps it across reads, and replaces it on rotate", async () => {
    const token = await store.httpToken({ rotate: false });

    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(secretPath(".http-token"), "utf8")).not.toContain(
      token,
    );
    expect(await store.httpToken({ rotate: false })).toBe(token);

    const rotated = await store.httpToken({ rotate: true });
    expect(rotated).not.toBe(token);
    expect(await store.httpToken({ rotate: false })).toBe(rotated);
  });
});
