import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { migrateLegacyRelayServerUrl } from "@omnyo/connect-client";
import type { HostedConnectApi } from "./hosted.js";
import { moveKvValueToSecret } from "./kv-secret.js";
import { redeemMachineCode } from "./machine-code.js";

export type ServerAccessCloud = Pick<
  HostedConnectApi,
  "createMachineCode" | "lookupMachineCode" | "revokeMachine"
> & {
  redeemMachineCode: typeof redeemMachineCode;
};

export function createServerAccessCloud(
  hosted: HostedConnectApi,
): ServerAccessCloud {
  return {
    createMachineCode: (signal) => hosted.createMachineCode(signal),
    lookupMachineCode: (code, signal) => hosted.lookupMachineCode(code, signal),
    revokeMachine: (machineId, signal) =>
      hosted.revokeMachine(machineId, signal),
    redeemMachineCode,
  };
}

const SIGN_IN_REQUIRED = "Sign in to your Omnyo account to use Omnyo connect";

const grantSchema = z.object({
  connectMachineId: z.string().min(1),
  grant: z.object({
    id: z.string().min(1),
    serverUrl: z.string().url(),
    headers: z.record(z.string(), z.string()),
  }),
});

export function createServerAccessRecheck(
  api: PluginApi,
): (status: { paired: boolean; enabled: boolean; url: string | null }) => void {
  let last: string | null = null;

  return (status) => {
    const signature = `${status.paired}:${status.enabled}:${status.url ?? ""}`;
    const changed = last !== null && last !== signature;
    last = signature;

    if (changed) api.experimental_serverAccess.recheck();
  };
}

function acquisitionFailure(message: string) {
  return { status: "failed" as const, message };
}

export const GRANT_KV_PREFIX = "server-access-grant:";

export const GRANT_SECRET_PREFIX = "server-access-grant/";

const grantHostIdSchema = z
  .string()
  .max(180)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u);

function grantSecretName(hostId: string): string {
  return `${GRANT_SECRET_PREFIX}${grantHostIdSchema.parse(hostId)}`;
}

function moveGrantToSecret(api: PluginApi, hostId: string): Promise<void> {
  return moveKvValueToSecret(
    api.storage.kv,
    api.experimental_secrets,
    `${GRANT_KV_PREFIX}${hostId}`,
    grantSecretName(hostId),
  );
}

export async function registerServerAccess(
  api: PluginApi,
  deps: {
    cloud: ServerAccessCloud;
    status(): { paired: boolean; enabled: boolean; url: string | null };
  },
) {
  const { cloud } = deps;

  const intentSchema = z.object({
    key: z.string(),
    hostId: z.string(),
    code: z.string(),
    expiresAt: z.number().finite(),
    serverUrl: z.string().url(),
  });

  const stateSchema = z.union([
    z.object({ result: grantSchema }),
    z.object({ intent: intentSchema }),
  ]);

  let queue = Promise.resolve();

  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  async function load(hostId: string) {
    await moveGrantToSecret(api, hostId);
    const raw = await api.experimental_secrets.get(grantSecretName(hostId));

    return raw === undefined ? undefined : stateSchema.parse(JSON.parse(raw));
  }

  function save(hostId: string, state: z.infer<typeof stateSchema>) {
    return api.experimental_secrets.set(
      grantSecretName(hostId),
      JSON.stringify(state),
    );
  }

  for (const key of await api.storage.kv.list(GRANT_KV_PREFIX)) {
    await moveGrantToSecret(api, key.slice(GRANT_KV_PREFIX.length));
  }

  function requireSignedIn(action: string): void {
    if (!deps.status().paired) throw new Error(`${SIGN_IN_REQUIRED} ${action}`);
  }

  async function reconcile(
    intent: z.infer<typeof intentSchema>,
    signal: AbortSignal,
  ) {
    requireSignedIn("to revoke machine access");

    try {
      const status = await cloud.lookupMachineCode(intent.code, signal);

      if (status.consumed && !status.machineId)
        throw new Error("Device identity unavailable");

      if (status.machineId) await cloud.revokeMachine(status.machineId, signal);

      return status.consumed;
    } catch {
      signal.throwIfAborted();

      const message =
        "Cloud device may need dashboard revocation: interrupted machine access acquisition; retry after Cloud lookup is available";

      return acquisitionFailure(message);
    }
  }

  api.experimental_serverAccess.register({
    id: "connect",
    displayName: "omnyo connect",
    description: "Use a private omnyo.link address.",
    availability: () => {
      const status = deps.status();

      if (!status.paired) {
        return { status: "setup-required", message: SIGN_IN_REQUIRED };
      }

      if (!status.enabled) {
        return {
          status: "setup-required",
          message: "Turn on remote access with omnyo connect on",
        };
      }

      return {
        status: "available",
        ...(status.url ? { serverUrl: status.url } : {}),
      };
    },
    acquire({ key, hostId, signal }) {
      return serialized(async () => {
        signal.throwIfAborted();
        const existing = await load(hostId);

        if (existing && "result" in existing) {
          const status = deps.status();
          const grant = existing.result.grant;

          if (
            status.paired &&
            status.url !== null &&
            migrateLegacyRelayServerUrl(grant.serverUrl) === status.url
          ) {
            const rebound = { ...grant, serverUrl: status.url };
            await save(hostId, {
              result: { ...existing.result, grant: rebound },
            });

            return rebound;
          }

          return grant;
        }

        requireSignedIn("to add machines");
        let intent = existing?.intent;

        if (intent) {
          const reconciliation = await reconcile(intent, signal);

          if (typeof reconciliation !== "boolean") return reconciliation;

          if (reconciliation || intent.expiresAt <= Date.now())
            intent = undefined;
        }

        if (!intent) {
          const code = await cloud.createMachineCode(signal);
          intent = {
            key,
            hostId,
            code: code.code,
            serverUrl: code.serverUrl,
            expiresAt: code.expiresAt,
          };
        }

        signal.throwIfAborted();
        await save(hostId, { intent });
        signal.throwIfAborted();
        const pending = intent;

        const redeemed = await cloud
          .redeemMachineCode({ ...pending, signal })
          .catch(() => {
            signal.throwIfAborted();

            return null;
          });

        if (redeemed === null)
          return acquisitionFailure(
            "Cloud device may need dashboard revocation: interrupted machine access acquisition",
          );

        const grant = {
          id: hostId,
          serverUrl: redeemed.serverUrl,
          headers: { "x-omnyo-connect-machine": redeemed.credential },
        };

        await save(hostId, {
          result: { connectMachineId: redeemed.machineId, grant },
        });

        return grant;
      });
    },
    release({ hostId }) {
      return serialized(async () => {
        const stored = await load(hostId);

        if (!stored) return;

        if ("intent" in stored) {
          const reconciliation = await reconcile(
            stored.intent,
            AbortSignal.timeout(30_000),
          );

          if (typeof reconciliation !== "boolean")
            throw new Error(reconciliation.message);

          if (!reconciliation && stored.intent.expiresAt > Date.now())
            throw new Error(
              "Machine access acquisition is still unsettled; cleanup will retry after redemption or code expiry",
            );
        } else {
          requireSignedIn("to revoke machine access");
          await cloud.revokeMachine(stored.result.connectMachineId);
        }

        await api.experimental_secrets.delete(grantSecretName(hostId));
      });
    },
  });
}
