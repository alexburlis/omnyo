import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  deleteSecretFile,
  readOrCreateSecretFile,
  readSecretFile,
  sealLegacySecretFile,
  SecretVaultError,
  writeSecretFile,
  type SecretVault,
} from "@omnyo/secret-storage";
import type { ServerLogger } from "../../types.js";
import { createKeyedLock } from "../lib/async-deduper.js";

export const PLUGIN_HTTP_TOKEN_SECRET = ".http-token";

const NAME_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

const NAME_MAX_SEGMENTS = 4;

const NAME_MAX_LENGTH = 200;

const withPathLock = createKeyedLock<string>();

export function pluginSecretsDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId, "secrets");
}

function isValidSecretName(name: string): boolean {
  const segments = name.split("/");

  return (
    name.length <= NAME_MAX_LENGTH &&
    segments.length <= NAME_MAX_SEGMENTS &&
    segments.every((segment) => NAME_SEGMENT_PATTERN.test(segment))
  );
}

function assertSecretName(name: unknown): asserts name is string {
  if (typeof name === "string" && isValidSecretName(name)) return;

  throw new Error(
    `invalid secret name ${JSON.stringify(name)}: use one to four "/"-separated segments of letters, digits, ".", "_" and "-", none starting with ".", at most 200 characters`,
  );
}

function errorCode(error: unknown): string {
  if (error instanceof SecretVaultError) return error.code;

  return error instanceof Error && "code" in error
    ? String(error.code)
    : "unknown";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function listFileNames(dir: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
}

function isSweptLegacyName(name: string): boolean {
  return (
    name === PLUGIN_HTTP_TOKEN_SECRET ||
    name.split("/").every((segment) => !segment.startsWith("."))
  );
}

export interface PluginSecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  has(name: string): Promise<boolean>;
  sealLegacy(names: readonly string[]): Promise<void>;
  sealLegacyTreeOnce(): Promise<void>;
  httpToken(options: { rotate: boolean }): Promise<string>;
}

export interface PluginSecretStoreArgs {
  logger: Pick<ServerLogger, "warn">;
  pluginId: string;
  vault: SecretVault;
}

export function createPluginSecretStore(
  args: PluginSecretStoreArgs,
): PluginSecretStore {
  const { logger, pluginId, vault } = args;
  const dir = pluginSecretsDir(vault.dataDir, pluginId);
  let legacyTreeSealed: Promise<void> | undefined;

  const pathOf = (name: string) => join(dir, ...name.split("/"));

  async function sealOne(name: string): Promise<void> {
    const path = pathOf(name);

    try {
      await withPathLock(path, () => sealLegacySecretFile(vault, path));
    } catch (error) {
      logger.warn(
        { err: error, pluginId, secret: name, code: errorCode(error) },
        "Could not seal a plugin secret; reading it reports the problem",
      );
    }
  }

  return {
    async get(name) {
      assertSecretName(name);
      const path = pathOf(name);

      return withPathLock(path, () => readSecretFile(vault, path));
    },

    async set(name, value) {
      assertSecretName(name);

      if (typeof value !== "string")
        throw new Error(`secret "${name}" must be a string`);
      const path = pathOf(name);
      await withPathLock(path, () => writeSecretFile(vault, path, value));
    },

    async delete(name) {
      assertSecretName(name);
      const path = pathOf(name);
      await withPathLock(path, () => deleteSecretFile(path));
    },

    async list(prefix = "") {
      return (await listFileNames(dir))
        .filter((name) => name.startsWith(prefix) && isValidSecretName(name))
        .sort();
    },

    async has(name) {
      assertSecretName(name);

      try {
        return (await stat(pathOf(name))).isFile();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },

    async sealLegacy(names) {
      for (const name of names) {
        assertSecretName(name);
        await sealOne(name);
      }
    },

    sealLegacyTreeOnce() {
      legacyTreeSealed ??= (async () => {
        for (const name of await listFileNames(dir)) {
          if (isSweptLegacyName(name)) await sealOne(name);
        }
      })().catch((error: unknown) => {
        legacyTreeSealed = undefined;
        throw error;
      });

      return legacyTreeSealed;
    },

    httpToken(options) {
      const path = pathOf(PLUGIN_HTTP_TOKEN_SECRET);

      return withPathLock(path, async () => {
        if (options.rotate) await deleteSecretFile(path);
        await mkdir(dir, { recursive: true, mode: 0o700 });

        return readOrCreateSecretFile(vault, {
          bytes: 32,
          encoding: "hex",
          fileName: relative(vault.dataDir, path),
        });
      });
    },
  };
}

export interface PluginSecretStores {
  forPlugin(pluginId: string): PluginSecretStore;
}

export function createPluginSecretStores(
  args: Omit<PluginSecretStoreArgs, "pluginId">,
): PluginSecretStores {
  const stores = new Map<string, PluginSecretStore>();

  return {
    forPlugin(pluginId) {
      let store = stores.get(pluginId);

      if (store === undefined) {
        store = createPluginSecretStore({ ...args, pluginId });
        stores.set(pluginId, store);
      }

      return store;
    },
  };
}
