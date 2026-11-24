import { join } from "node:path";
import {
  openSecretVault,
  readVaultProtection,
  sealLegacySecretFile,
  SecretVaultError,
  type SecretVault,
  type VaultProtection,
} from "@omnyo/secret-storage";
import type { ServerLogger } from "../../types.js";

export const AUTH_SECRET_FILE_NAME = "auth-secret";

export const MACHINE_ENVIRONMENT_KEY_FILE_NAME = "machine-environment-key";

function describeProtection(protection: VaultProtection): string {
  return protection.kind === "windows-dpapi"
    ? `${protection.kind} (${protection.scope} scope)`
    : protection.kind;
}

async function describeKeyStore(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const recorded = await readVaultProtection(dataDir).catch((error: unknown) =>
    error instanceof SecretVaultError ? null : undefined,
  );

  if (recorded === null) return "an unreadable vault record";

  if (recorded !== undefined)
    return `${describeProtection(recorded)}, recorded in the vault record`;

  const requested = env.OMNYO_VAULT_KEY_STORE?.trim();

  return requested === undefined || requested === ""
    ? `the ${process.platform} default for a new vault`
    : `OMNYO_VAULT_KEY_STORE=${requested} for a new vault`;
}

export interface OpenServerVaultArgs {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logger: Pick<ServerLogger, "error" | "info">;
}

export async function openServerVault(
  args: OpenServerVaultArgs,
): Promise<SecretVault> {
  const env = args.env ?? process.env;
  let vault: SecretVault;

  try {
    vault = await openSecretVault(args.dataDir, { env });
  } catch (error) {
    if (!(error instanceof SecretVaultError)) throw error;

    const keyStore = await describeKeyStore(args.dataDir, env);
    const message = `Omnyo cannot open the secret vault of data directory ${args.dataDir} (key store ${keyStore}; ${error.code}): ${error.message}. The server stops instead of creating or replacing any secret.`;
    args.logger.error(
      { code: error.code, dataDir: args.dataDir, keyStore },
      message,
    );
    throw new Error(message, { cause: error });
  }

  if (vault.created)
    args.logger.info(
      { dataDir: args.dataDir, protection: vault.protection },
      "Created this data directory's secret vault",
    );

  await sealLegacySecretFile(vault, join(args.dataDir, AUTH_SECRET_FILE_NAME));
  await sealLegacySecretFile(
    vault,
    join(args.dataDir, MACHINE_ENVIRONMENT_KEY_FILE_NAME),
  ).catch((error: unknown) => {
    args.logger.error(
      { err: error, dataDir: args.dataDir },
      "Could not seal the machine environment key; machine environment variables report the problem when they are used",
    );
  });

  return vault;
}
