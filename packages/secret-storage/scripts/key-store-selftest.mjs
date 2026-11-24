import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  keyStoreForProtection,
  openSecretVault,
  SecretVaultError,
} from "../src/index.ts";

const { values } = parseArgs({
  options: { "data-dir": { type: "string" } },
});

if (values["data-dir"] === undefined) {
  console.error(
    "usage: key-store-selftest.mjs --data-dir <new empty directory>",
  );
  process.exit(2);
}

const dataDir = resolve(values["data-dir"]);

const existing = await readdir(dataDir).catch(() => undefined);

if (existing !== undefined && existing.length > 0) {
  console.error(`refusing to use non-empty directory ${dataDir}`);
  process.exit(2);
}

await mkdir(dataDir, { recursive: true });

const env = { ...process.env };

delete env.OMNYO_VAULT_KEY_STORE;

const report = {
  platform: process.platform,
  protection: null,
  created: null,
  ok: { open: false, roundTrip: false, reopen: false, removed: false },
  ms: {},
  error: null,
};

async function timed(name, action) {
  const started = performance.now();

  try {
    return await action();
  } finally {
    report.ms[name] = Math.round(performance.now() - started);
  }
}

let vault;

try {
  vault = await timed("open", () => openSecretVault(dataDir, { env }));
  report.protection = vault.protection;
  report.created = vault.created;
  report.ok.open = true;

  const probe = randomBytes(24).toString("base64");
  const sealed = vault.seal(probe);
  report.ok.roundTrip = !sealed.includes(probe) && vault.open(sealed) === probe;

  const keyStore = keyStoreForProtection(dataDir, vault.protection, { env });

  const reopened = await timed("reopen", () =>
    openSecretVault(dataDir, { env, keyStore }),
  );

  report.ok.reopen =
    reopened.id === vault.id &&
    !reopened.created &&
    reopened.open(sealed) === probe;

  await timed("remove", () => keyStore.remove(vault.id));
  report.ok.removed = await keyStore.load(vault.id).then(
    () => false,
    (error) =>
      error instanceof SecretVaultError && error.code === "key_missing",
  );
} catch (error) {
  report.error =
    error instanceof SecretVaultError
      ? { code: error.code, message: error.message }
      : {
          code: "unexpected",
          message: error instanceof Error ? error.message : String(error),
        };

  if (vault !== undefined && !report.ok.removed)
    await keyStoreForProtection(dataDir, vault.protection, { env })
      .remove(vault.id)
      .then(
        () => {
          report.ok.removed = true;
        },
        () => {},
      );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));

process.exit(Object.values(report.ok).every(Boolean) ? 0 : 1);
