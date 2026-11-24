import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretVaultError } from "../src/errors.js";
import { createMacosKeychainKeyStore } from "../src/key-stores/macos-keychain.js";

const enabled =
  process.platform === "darwin" &&
  process.env.OMNYO_VAULT_INTEGRATION === "keychain";

describe.skipIf(!enabled)("macOS Keychain key store integration", () => {
  it("stores, loads, refuses to overwrite and removes a real Keychain item", async () => {
    const store = createMacosKeychainKeyStore();
    const vaultId = randomBytes(16).toString("hex");
    const key = randomBytes(32);

    try {
      await store.store(vaultId, key);
      expect(await store.load(vaultId)).toEqual(key);

      await expect(store.store(vaultId, randomBytes(32))).rejects.toMatchObject(
        { code: "key_unavailable" },
      );
      expect(await store.load(vaultId)).toEqual(key);
    } finally {
      await store.remove(vaultId);
    }

    const error = await store.load(vaultId).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SecretVaultError);
    expect(error).toMatchObject({ code: "key_missing" });
    await store.remove(vaultId);
  });
});
