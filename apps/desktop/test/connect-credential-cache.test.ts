import { describe, expect, it, vi } from "vitest";
import {
  createConnectCredentialCache,
  type ConnectCredentialCacheFs,
  type ConnectCredentialEncryption,
} from "../src/connect-credential-cache.js";

const CREDENTIAL = {
  credential: "bbcm_desktop",
  handle: "laptop",
  serverUrl: "https://laptop.example.test",
};

function createEncryption(
  available = true,
): ConnectCredentialEncryption & { available: boolean } {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plainText) {
      return Buffer.from(`sealed:${plainText}`);
    },
    decryptString(encrypted) {
      const text = encrypted.toString();

      if (!text.startsWith("sealed:")) {
        throw new Error("cannot decrypt");
      }

      return text.slice("sealed:".length);
    },
  };
}

function createFs(seed: Buffer | null = null): ConnectCredentialCacheFs & {
  file: Buffer | null;
} {
  return {
    file: seed,
    async readFile() {
      if (this.file === null) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      return this.file;
    },
    async rm() {
      this.file = null;
    },
    async writeFile(_path, data) {
      this.file = data;
    },
  };
}

describe("createConnectCredentialCache", () => {
  it("round-trips a credential through the keychain", async () => {
    const fs = createFs();

    const cache = createConnectCredentialCache({
      encryption: createEncryption(),
      fs,
      userDataPath: "/data",
    });

    await cache.write(CREDENTIAL);
    expect(fs.file?.toString().startsWith("sealed:")).toBe(true);
    await expect(cache.read()).resolves.toEqual(CREDENTIAL);

    await cache.clear();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("never writes the secret when the OS offers no encryption", async () => {
    const fs = createFs();
    const encryption = createEncryption(false);
    const encryptString = vi.spyOn(encryption, "encryptString");

    const cache = createConnectCredentialCache({
      encryption,
      fs,
      userDataPath: "/data",
    });

    await cache.write(CREDENTIAL);

    expect(cache.canPersist()).toBe(false);
    expect(encryptString).not.toHaveBeenCalled();
    expect(fs.file).toBeNull();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("preserves protected bytes it cannot decrypt or parse and exposes a recovery error", async () => {
    const undecryptable = createFs(Buffer.from("from-another-machine"));
    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: undecryptable,
        userDataPath: "/data",
      }).read(),
    ).rejects.toThrow("preserved");
    expect(undecryptable.file).toEqual(Buffer.from("from-another-machine"));

    const wrongShape = createFs(
      Buffer.from(`sealed:${JSON.stringify({ handle: "laptop" })}`),
    );

    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: wrongShape,
        userDataPath: "/data",
      }).read(),
    ).rejects.toThrow("preserved");
    expect(wrongShape.file).toEqual(
      Buffer.from(`sealed:${JSON.stringify({ handle: "laptop" })}`),
    );
  });

  it("does not hide a protected-store read failure as an absent sign-in", async () => {
    const fs = createFs(Buffer.from("unchanged encrypted bytes"));
    fs.readFile = async () => {
      throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    };

    const cache = createConnectCredentialCache({
      encryption: createEncryption(),
      fs,
      userDataPath: "/data",
    });

    await expect(cache.read()).rejects.toThrow("Access denied");
    expect(fs.file).toEqual(Buffer.from("unchanged encrypted bytes"));
  });
});

it("migrates the encrypted saved relay credential once without changing its identity", async () => {
  const legacy = {
    ...CREDENTIAL,
    serverUrl: "https://laptop.stg.slashnew.com",
  };

  const fs = createFs(Buffer.from(`sealed:${JSON.stringify(legacy)}`));
  const encryption = createEncryption();
  const encrypt = vi.spyOn(encryption, "encryptString");

  const cache = createConnectCredentialCache({
    encryption,
    fs,
    userDataPath: "/data",
  });

  const expected = { ...legacy, serverUrl: "https://laptop.stg.omnyo.link" };
  await expect(cache.read()).resolves.toEqual(expected);
  await expect(cache.read()).resolves.toEqual(expected);
  expect(encrypt).toHaveBeenCalledTimes(1);
});

it("keeps the saved relay credential when migration persistence fails", async () => {
  const original = Buffer.from(
    `sealed:${JSON.stringify({ ...CREDENTIAL, serverUrl: "https://laptop.slashnew.com" })}`,
  );

  const fs = createFs(original);
  fs.writeFile = async () => {
    throw new Error("write failed");
  };

  const cache = createConnectCredentialCache({
    encryption: createEncryption(),
    fs,
    userDataPath: "/data",
  });

  await expect(cache.read()).rejects.toThrow("write failed");
  expect(fs.file).toEqual(original);
});
