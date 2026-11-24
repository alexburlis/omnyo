import { rm, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  connectCredentialSchema,
  migrateLegacyRelayServerUrl,
  type ConnectCredential,
} from "@omnyo/connect-client";

const CONNECT_CREDENTIAL_FILE_NAME = "connect-credential.bin";

export interface ConnectCredentialEncryption {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  isEncryptionAvailable(): boolean;
}

export interface ConnectCredentialCacheFs {
  readFile(path: string): Promise<Buffer>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

interface CreateConnectCredentialCacheArgs {
  encryption: ConnectCredentialEncryption;
  fs?: ConnectCredentialCacheFs;
  userDataPath: string;
}

export interface ConnectCredentialCache {
  canPersist(): boolean;
  clear(): Promise<void>;
  read(): Promise<ConnectCredential | null>;
  write(credential: ConnectCredential): Promise<void>;
}

const defaultFs: ConnectCredentialCacheFs = {
  readFile,
  rm,
  async writeFile(path, data) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  },
};

export function createConnectCredentialCache(
  args: CreateConnectCredentialCacheArgs,
): ConnectCredentialCache {
  const fsImpl = args.fs ?? defaultFs;
  const filePath = join(args.userDataPath, CONNECT_CREDENTIAL_FILE_NAME);

  async function clear(): Promise<void> {
    await fsImpl.rm(filePath, { force: true });
  }

  return {
    canPersist() {
      return args.encryption.isEncryptionAvailable();
    },
    clear,
    async read() {
      if (!args.encryption.isEncryptionAvailable()) {
        return null;
      }

      let encrypted: Buffer;

      try {
        encrypted = await fsImpl.readFile(filePath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }

      let plainText: string;

      try {
        plainText = args.encryption.decryptString(encrypted);
      } catch {
        throw new Error(
          "Stored desktop sign-in cannot be decrypted; its protected file was preserved",
        );
      }

      let parsedJson: unknown;

      try {
        parsedJson = JSON.parse(plainText);
      } catch {
        throw new Error(
          "Stored desktop sign-in is malformed; its protected file was preserved",
        );
      }

      const parsed = connectCredentialSchema.safeParse(parsedJson);

      if (!parsed.success) {
        throw new Error(
          "Stored desktop sign-in has an unsupported format; its protected file was preserved",
        );
      }

      const serverUrl = migrateLegacyRelayServerUrl(parsed.data.serverUrl);

      if (serverUrl === null) return parsed.data;
      const migrated = { ...parsed.data, serverUrl };
      await fsImpl.writeFile(
        filePath,
        args.encryption.encryptString(JSON.stringify(migrated)),
      );

      return migrated;
    },
    async write(credential) {
      if (!args.encryption.isEncryptionAvailable()) {
        return;
      }

      await fsImpl.writeFile(
        filePath,
        args.encryption.encryptString(JSON.stringify(credential)),
      );
    },
  };
}
