import type { PluginKvStorage, PluginSecrets } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { profileResponseSchema, type AccountProfile } from "./hosted.js";
import { moveKvValueToSecret, readJsonSecret } from "./kv-secret.js";

export const CREDENTIAL_KV_KEY = "credential";

export const CREDENTIAL_SECRET_NAME = "credential";

export const PROFILE_KV_KEY = "profile";

export const REVISION_KV_KEY = "revision";

export const storedCredentialSchema = z.object({
  baseUrl: z.string().url(),
  serverUrl: z.string().url(),
  serverId: z.string().min(1),
  credential: z.string().min(1),
});

const storedAccountSchema = storedCredentialSchema.extend({
  accountProfile: profileResponseSchema.nullable(),
});

export type StoredCredential = z.infer<typeof storedCredentialSchema>;

export interface AccountStore {
  readCredential(): Promise<StoredCredential | null>;
  readProfile(): Promise<AccountProfile | null>;
  readRevision(): Promise<number>;
  writeAccount(
    credential: StoredCredential,
    profile: AccountProfile | null,
  ): Promise<void>;
  writeRevision(revision: number): Promise<void>;
  clear(): Promise<void>;
}

export function createAccountStore(
  kv: Pick<PluginKvStorage, "get" | "set" | "delete">,
  secrets: PluginSecrets,
): AccountStore {
  return {
    async readCredential() {
      await moveKvValueToSecret(
        kv,
        secrets,
        CREDENTIAL_KV_KEY,
        CREDENTIAL_SECRET_NAME,
      );

      const parsed = storedCredentialSchema.safeParse(
        await readJsonSecret(secrets, CREDENTIAL_SECRET_NAME),
      );

      return parsed.success ? parsed.data : null;
    },
    async readProfile() {
      const raw = await readJsonSecret(secrets, CREDENTIAL_SECRET_NAME);

      if (typeof raw === "object" && raw !== null && "accountProfile" in raw) {
        const account = storedAccountSchema.safeParse(raw);

        return account.success ? account.data.accountProfile : null;
      }

      const parsed = profileResponseSchema.safeParse(
        await kv.get<unknown>(PROFILE_KV_KEY),
      );

      return parsed.success ? parsed.data : null;
    },
    async readRevision() {
      const parsed = z
        .number()
        .int()
        .nonnegative()
        .safeParse(await kv.get<unknown>(REVISION_KV_KEY));

      return parsed.success ? parsed.data : 0;
    },
    async writeAccount(credential, profile) {
      await kv.delete(CREDENTIAL_KV_KEY);
      await secrets.set(
        CREDENTIAL_SECRET_NAME,
        JSON.stringify({ ...credential, accountProfile: profile }),
      );

      if (profile === null) {
        await kv.delete(PROFILE_KV_KEY);
      } else {
        await kv.set(PROFILE_KV_KEY, profile);
      }
    },
    async writeRevision(revision) {
      await kv.set(REVISION_KV_KEY, revision);
    },
    async clear() {
      await secrets.delete(CREDENTIAL_SECRET_NAME);
      await kv.delete(CREDENTIAL_KV_KEY);
      await kv.delete(PROFILE_KV_KEY);
    },
  };
}
