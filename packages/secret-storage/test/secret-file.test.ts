import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteSecretFile,
  isSealed,
  openSecretVault,
  readOrCreateIdentifierFile,
  readOrCreateSecretFile,
  readSecretFile,
  sealLegacySecretFile,
  SecretVaultError,
  writeSecretFile,
  type SecretVault,
} from "../src/index.js";
import {
  memoryKeyStore,
  modeOf,
  posixModes,
  trackTempDirs,
} from "./helpers.js";

const makeTempDir = trackTempDirs();

const generated = {
  bytes: 32,
  encoding: "base64",
  fileName: "secret",
} as const;

async function freshVault(): Promise<SecretVault> {
  return openSecretVault(await makeTempDir(), { keyStore: memoryKeyStore() });
}

describe("writeSecretFile and readSecretFile", () => {
  it("stores only ciphertext in a private file and reads the value back", async () => {
    const vault = await freshVault();

    const secretPath = path.join(
      vault.dataDir,
      "plugins",
      "slack",
      "secrets",
      "token",
    );

    await writeSecretFile(vault, secretPath, "xoxb-123");

    const content = await readFile(secretPath, "utf8");
    expect(isSealed(content)).toBe(true);
    expect(content).not.toContain("xoxb-123");
    expect(await readSecretFile(vault, secretPath)).toBe("xoxb-123");

    if (posixModes) {
      expect(await modeOf(secretPath)).toBe(0o600);
      expect(await modeOf(path.dirname(secretPath))).toBe(0o700);
    }
  });

  it("overwrites an existing secret and leaves no temp files behind", async () => {
    const vault = await freshVault();
    const dir = path.join(vault.dataDir, "secrets");
    const secretPath = path.join(dir, "token");

    await writeSecretFile(vault, secretPath, "first");
    await writeSecretFile(vault, secretPath, "second");

    expect(await readSecretFile(vault, secretPath)).toBe("second");
    expect(await readdir(dir)).toEqual(["token"]);
  });

  it("returns undefined for a missing file", async () => {
    const vault = await freshVault();

    expect(
      await readSecretFile(vault, path.join(vault.dataDir, "absent")),
    ).toBeUndefined();
  });

  it("seals legacy plaintext in place and keeps reading the same value", async () => {
    const vault = await freshVault();
    const dir = path.join(vault.dataDir, "secrets");
    const secretPath = path.join(dir, "token");
    await mkdir(dir);
    await writeFile(secretPath, "legacy-token\n", { mode: 0o644 });

    expect(await readSecretFile(vault, secretPath)).toBe("legacy-token\n");

    const content = await readFile(secretPath, "utf8");
    expect(isSealed(content)).toBe(true);
    expect(content).not.toContain("legacy-token");
    expect(await readSecretFile(vault, secretPath)).toBe("legacy-token\n");
    expect(await readdir(dir)).toEqual(["token"]);

    if (posixModes) expect(await modeOf(secretPath)).toBe(0o600);
  });

  it("throws for a sealed file from another vault and leaves it unchanged", async () => {
    const vault = await freshVault();
    const other = await freshVault();
    const secretPath = path.join(vault.dataDir, "token");
    await writeSecretFile(other, secretPath, "foreign");
    const before = await readFile(secretPath, "utf8");

    await expect(readSecretFile(vault, secretPath)).rejects.toMatchObject({
      code: "wrong_vault",
    });
    expect(await readFile(secretPath, "utf8")).toBe(before);
  });
});

describe("sealLegacySecretFile", () => {
  it("reports absent, sealed and already-sealed files", async () => {
    const vault = await freshVault();
    const secretPath = path.join(vault.dataDir, "token");

    expect(await sealLegacySecretFile(vault, secretPath)).toBe("absent");

    await writeFile(secretPath, "plain");
    expect(await sealLegacySecretFile(vault, secretPath)).toBe("sealed");
    expect(await sealLegacySecretFile(vault, secretPath)).toBe(
      "already-sealed",
    );
    expect(await readSecretFile(vault, secretPath)).toBe("plain");
  });

  it("throws for a corrupt sealed file instead of reporting it sealed", async () => {
    const vault = await freshVault();
    const secretPath = path.join(vault.dataDir, "token");
    await writeFile(secretPath, `omnyo-vault:1:${vault.id}:AAAA`);

    await expect(
      sealLegacySecretFile(vault, secretPath),
    ).rejects.toBeInstanceOf(SecretVaultError);
  });
});

describe("readOrCreateSecretFile", () => {
  it("creates a sealed secret once and returns it on every later call", async () => {
    const vault = await freshVault();

    const first = await readOrCreateSecretFile(vault, generated);
    const second = await readOrCreateSecretFile(vault, generated);
    const content = await readFile(path.join(vault.dataDir, "secret"), "utf8");

    expect(second).toBe(first);
    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(isSealed(content)).toBe(true);
    expect(content).not.toContain(first);

    if (posixModes)
      expect(await modeOf(path.join(vault.dataDir, "secret"))).toBe(0o600);
  });

  it("returns the same secret to concurrent creators", async () => {
    const vault = await freshVault();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => readOrCreateSecretFile(vault, generated)),
    );

    expect(new Set(results).size).toBe(1);
    expect(await readdir(vault.dataDir)).toEqual(["secret", "vault"].sort());
  });

  it("keeps a legacy secret's trimmed value and seals it", async () => {
    const vault = await freshVault();
    const secretPath = path.join(vault.dataDir, "secret");
    await writeFile(secretPath, "legacy-secret\n");

    expect(await readOrCreateSecretFile(vault, generated)).toBe(
      "legacy-secret",
    );
    expect(isSealed(await readFile(secretPath, "utf8"))).toBe(true);
    expect(await readOrCreateSecretFile(vault, generated)).toBe(
      "legacy-secret",
    );
  });

  it("throws for an unreadable sealed file and never regenerates it", async () => {
    const vault = await freshVault();
    const other = await freshVault();
    const secretPath = path.join(vault.dataDir, "secret");
    await writeSecretFile(other, secretPath, "foreign");
    const before = await readFile(secretPath, "utf8");

    await expect(
      readOrCreateSecretFile(vault, generated),
    ).rejects.toMatchObject({ code: "wrong_vault" });
    expect(await readFile(secretPath, "utf8")).toBe(before);
  });

  it("throws when an existing secret file is empty", async () => {
    const vault = await freshVault();
    await writeFile(path.join(vault.dataDir, "secret"), "\n");

    await expect(readOrCreateSecretFile(vault, generated)).rejects.toThrow(
      "Failed to initialize secret",
    );
  });
});

describe("readOrCreateIdentifierFile", () => {
  it("keeps identifiers as plaintext and reuses them", async () => {
    const dataDir = await makeTempDir();
    const args = { ...generated, dataDir, fileName: "install-id" };

    const results = await Promise.all(
      Array.from({ length: 4 }, () => readOrCreateIdentifierFile(args)),
    );

    const [first] = results;

    expect(new Set(results).size).toBe(1);
    expect(await readFile(path.join(dataDir, "install-id"), "utf8")).toBe(
      `${first}\n`,
    );
    expect(await readOrCreateIdentifierFile(args)).toBe(first);
  });
});

describe("deleteSecretFile", () => {
  it("removes an existing secret and tolerates missing files", async () => {
    const vault = await freshVault();
    const secretPath = path.join(vault.dataDir, "token");
    await writeSecretFile(vault, secretPath, "value");

    await deleteSecretFile(secretPath);
    await deleteSecretFile(secretPath);

    expect(await readSecretFile(vault, secretPath)).toBeUndefined();
  });
});
