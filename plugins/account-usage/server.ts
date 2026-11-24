import type {
  ExperimentalPluginRpcHandlerContext,
  PluginApi,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  USAGE_CHANGED_CHANNEL,
  type SignInResult,
  type SignInStart,
  type Snapshot,
} from "./contract.ts";
import { poolConfigSchema, poolStatusSchema } from "./lib/pool-contracts.ts";
import { buildSnapshot } from "./lib/normalise.ts";
import { describePoolReadError } from "./lib/pool-read-error.ts";
import {
  poolTelemetryReportSchema,
  statsSpeedReportSchema,
} from "./lib/telemetry-contract.ts";

import {
  codexResetCreditsSchema,
  codexRedeemResetSchema,
} from "./lib/codex-reset-contract.ts";

const ACCOUNT_POOL_PLUGIN_ID = "account-pool";

const POOL_READ_TIMEOUT_MS = 30_000;

const codexLoginStartSchema = z.object({
  sessionId: z.string().uuid(),
  verificationUri: z.string().url(),
  userCode: z.string().min(1),
  expiresAt: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
});

const signedInAccountSchema = z.object({ id: z.string() });

const codexLoginPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("complete"), account: signedInAccountSchema }),
  z.object({ status: z.literal("error"), message: z.string().min(1) }),
]);

function requireClient(context: ExperimentalPluginRpcHandlerContext): void {
  if (context.experimental_caller.kind !== "client")
    throw new Error("Account sign-in caller is not authorized");
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^(?:HTTP \d{3}:\s*)+/,
    "",
  );
}

const emptySnapshot = (
  error: string | null,
  poolUnavailable: boolean,
): Snapshot => ({
  fetchedAt: Date.now(),
  error,
  poolUnavailable,
  groups: [],
});

export default function accountUsagePlugin(api: PluginApi): void {
  let lastSnapshot: Snapshot | null = null;
  let pendingSnapshot: Promise<Snapshot> | null = null;

  const failedSnapshot = (
    operation: "snapshot" | "refresh",
    method: "status.get" | "config.get" | "account.refreshUsage",
    error: unknown,
    startedAt: number,
  ): Snapshot => {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? `no answer within ${POOL_READ_TIMEOUT_MS / 1_000} seconds`
        : (error instanceof Error ? error.message : String(error)).slice(
            0,
            512,
          );

    const availability = message.replace(/^HTTP (?:404|503):\s*/i, "");

    const missing =
      /^unknown plugin(?:\s|$)/i.test(availability) ||
      /^plugin(?: "account-pool")? (?:is )?(?:not installed|disabled)(?:$|[ .)])/i.test(
        availability,
      ) ||
      /^plugin "account-pool" is not running \(status: disabled(?:$|[ )—])/i.test(
        availability,
      );

    api.log.warn(
      `account-pool read failed: ${JSON.stringify({
        operation,
        method,
        durationMs: Math.round(performance.now() - startedAt),
        cached: lastSnapshot !== null,
        error: describePoolReadError(error),
      })}`,
    );

    if (missing) {
      lastSnapshot = null;

      return emptySnapshot(null, true);
    }

    return lastSnapshot === null
      ? emptySnapshot(message, false)
      : { ...lastSnapshot, error: message };
  };

  const readPoolStatus = () =>
    api.sdk.plugins.callRpc({
      pluginId: ACCOUNT_POOL_PLUGIN_ID,
      method: "status.get",
      input: null,
      outputSchema: poolStatusSchema,
      signal: AbortSignal.timeout(POOL_READ_TIMEOUT_MS),
    });

  const fetchSnapshot = async (): Promise<Snapshot> => {
    let method: "status.get" | "config.get" = "status.get";
    let startedAt = performance.now();

    try {
      const status = await readPoolStatus();
      method = "config.get";
      startedAt = performance.now();

      const config = await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "config.get",
        input: null,
        outputSchema: poolConfigSchema,
        signal: AbortSignal.timeout(POOL_READ_TIMEOUT_MS),
      });

      const snapshot = buildSnapshot(
        status,
        config.switchThreshold,
        Date.now(),
      );

      lastSnapshot = snapshot;

      return snapshot;
    } catch (error) {
      return failedSnapshot("snapshot", method, error, startedAt);
    }
  };

  const readStatus = (): Promise<Snapshot> => {
    pendingSnapshot ??= fetchSnapshot().finally(() => {
      pendingSnapshot = null;
    });

    return pendingSnapshot;
  };

  const refreshAll = async (): Promise<Snapshot> => {
    let method: "status.get" | "account.refreshUsage" = "status.get";
    let startedAt = performance.now();

    try {
      const { accounts } = await readPoolStatus();
      method = "account.refreshUsage";
      startedAt = performance.now();
      await Promise.all(
        accounts
          .filter(
            (account) =>
              account.enabled &&
              account.provider === "codex" &&
              account.kind === "oauth",
          )
          .map((account) =>
            api.sdk.plugins.callRpc({
              pluginId: ACCOUNT_POOL_PLUGIN_ID,
              method: "account.refreshUsage",
              input: { accountId: account.id },
              outputSchema: z.unknown(),
            }),
          ),
      );
    } catch (error) {
      return failedSnapshot("refresh", method, error, startedAt);
    }

    if (pendingSnapshot !== null) await pendingSnapshot;
    const snapshot = await readStatus();
    api.realtime.publish(USAGE_CHANGED_CHANNEL, {
      fetchedAt: snapshot.fetchedAt,
    });

    return snapshot;
  };

  const nudge = (): void => {
    api.realtime.publish(USAGE_CHANGED_CHANNEL, { fetchedAt: Date.now() });
  };

  const refreshAccountUsage = (accountId: string) =>
    api.sdk.plugins.callRpc({
      pluginId: ACCOUNT_POOL_PLUGIN_ID,
      method: "account.refreshUsage",
      input: { accountId },
      outputSchema: z.unknown(),
    });

  const signedInAgain = async (
    accountId: string,
    signedInId: string,
  ): Promise<SignInResult> => {
    if (signedInId !== accountId)
      throw new Error("Signed in to a different account");

    try {
      await refreshAccountUsage(accountId);

      return { status: "complete", usageRefreshError: null };
    } catch (error) {
      return { status: "complete", usageRefreshError: errorText(error) };
    } finally {
      nudge();
    }
  };

  const pooledAccount = async (accountId: string) => {
    const { accounts } = await readPoolStatus();
    const account = accounts.find((candidate) => candidate.id === accountId);

    if (account === undefined)
      throw new Error("This account is no longer pooled");

    return account;
  };

  const oauthAccount = async (accountId: string) => {
    const account = await pooledAccount(accountId);

    if (account.provider !== "codex" || account.kind !== "oauth")
      throw new Error(
        "For a Claude subscription, sign in directly in Claude Code.",
      );

    return account;
  };

  api.rpc.register(rpcContract, {
    telemetry: async (input) => {
      const signal = AbortSignal.timeout(POOL_READ_TIMEOUT_MS);

      const [pool, stats] = await Promise.all([
        api.sdk.plugins.callRpc({
          pluginId: ACCOUNT_POOL_PLUGIN_ID,
          method: "experimental_telemetry.v1.report",
          input,
          outputSchema: poolTelemetryReportSchema,
          signal,
        }),
        api.sdk.plugins.callRpc({
          pluginId: "stats",
          method: "report",
          input: {
            range: "month",
            groupBy: "model",
            filters: { provider: "codex" },
            offset: 0,
            limit: 100,
            search: "",
          },
          outputSchema: statsSpeedReportSchema,
          signal,
        }),
      ]);

      return {
        ...pool,
        speedRows: stats.speeds.flatMap((row) =>
          row.medianTps === null || row.medianSampleCount === 0
            ? []
            : [
                {
                  model: row.model,
                  effort: row.effort || null,
                  requestedTier: row.mode || null,
                  medianTps: row.medianTps,
                  measuredTurns: row.medianSampleCount ?? null,
                },
              ],
        ),
      };
    },
    snapshot: readStatus,
    refresh: refreshAll,
    codexResetCredits: async (input) => {
      const result = await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "experimental_codex-resets.v1.credits",
        input,
        outputSchema: codexResetCreditsSchema,
      });

      if (result.accountId !== input.accountId)
        throw new Error("Reset credits response account mismatch");

      return result;
    },
    codexRedeemReset: async (input, context) => {
      if (context.experimental_caller.kind !== "client")
        throw new Error("Codex reset caller is not authorized");

      const result = await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "experimental_codex-resets.v1.redeem",
        input: {
          accountId: input.accountId,
          creditId: input.creditId,
          redeemRequestId: input.redeemRequestId,
        },
        outputSchema: codexRedeemResetSchema,
      });

      if (result.accountId !== input.accountId)
        throw new Error("Reset response account mismatch");

      if (result.code === "reset" || result.code === "already_redeemed") {
        api.realtime.publish(USAGE_CHANGED_CHANNEL, { fetchedAt: Date.now() });
      }

      return result;
    },
    refreshAccount: async ({ accountId }, context) => {
      requireClient(context);
      const account = await pooledAccount(accountId);

      if (account.provider === "claude" && account.kind === "oauth")
        throw new Error(
          "Run /usage in Claude Code to see your current limits.",
        );

      try {
        await refreshAccountUsage(accountId);
      } finally {
        nudge();
      }

      return null;
    },
    signInStart: async ({ accountId }, context): Promise<SignInStart> => {
      requireClient(context);
      await oauthAccount(accountId);
      const target = { kind: "relogin", accountId } as const;

      const started = await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "codexLogin.start",
        input: target,
        outputSchema: codexLoginStartSchema,
      });

      return { provider: "codex", ...started };
    },
    signInFinish: (_input, context): SignInResult => {
      requireClient(context);

      return {
        status: "error",
        message: "For a Claude subscription, sign in directly in Claude Code.",
      };
    },
    signInPoll: async (
      { accountId, sessionId },
      context,
    ): Promise<SignInResult> => {
      requireClient(context);

      const polled = await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "codexLogin.poll",
        input: { sessionId },
        outputSchema: codexLoginPollSchema,
      });

      if (polled.status !== "complete") return polled;

      return signedInAgain(accountId, polled.account.id);
    },
    signInCancel: async ({ sessionId }, context) => {
      requireClient(context);
      await api.sdk.plugins.callRpc({
        pluginId: ACCOUNT_POOL_PLUGIN_ID,
        method: "codexLogin.cancel",
        input: { sessionId },
        outputSchema: z.unknown(),
      });

      return null;
    },
  });

  api.events.on("thread.idle", nudge);
  api.events.on("thread.failed", nudge);
}
