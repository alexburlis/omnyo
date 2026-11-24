import { defineRpcContract, type PluginRpcHandlers } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  CLAUDE_POOL_LOGIN_RETIRED,
  accountAddInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSummarySchema,
  bypassInputSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  loginCompleteInputSchema,
  loginStartSchema,
  loginTargetSchema,
  routedThreadStatusListSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";
import type {
  PluginApi,
  ExperimentalPluginRpcHandlerContext,
} from "@omnyo/plugin-sdk";
import { codexResetRpcContract } from "./codex-reset-contract.js";
import type { AccountPoolHub } from "./hub.js";

export function registerCodexResetRpc(
  api: PluginApi,
  hub: AccountPoolHub,
): void {
  const authorize = (context: ExperimentalPluginRpcHandlerContext) => {
    if (
      context.experimental_caller.kind !== "plugin" ||
      context.experimental_caller.pluginId !== "omnyo--account-usage"
    )
      throw new Error("Codex resets caller is not authorized");
  };

  api.rpc.register(codexResetRpcContract, {
    "experimental_codex-resets.v1.credits": (input, context) => {
      authorize(context);

      return hub.codexResetCredits(input.accountId);
    },
    "experimental_codex-resets.v1.redeem": (input, context) => {
      authorize(context);

      return hub.codexRedeemReset(input);
    },
  });
}

export const accountPoolRpcContract = defineRpcContract({
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: z.enum(["claude", "codex"]), enabled: z.boolean() })
      .strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "login.start": {
    input: loginTargetSchema,
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "codexLogin.start": {
    input: loginTargetSchema,
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "status.routedThreads": {
    input: z.null(),
    output: routedThreadStatusListSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassInputSchema,
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
): PluginRpcHandlers<typeof accountPoolRpcContract> {
  return {
    "account.add": (input) => operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }) => ({
      account: await operations.disable(id),
    }),
    "account.setPriority": async ({ accountId, priority }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.refreshUsage": async ({ accountId }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({ provider, accountIds }) => {
      await operations.reorder(provider, accountIds);

      return null;
    },
    "routing.set": async ({ provider, enabled }) => {
      await operations.setRouting(provider, enabled);

      return { provider, enabled };
    },
    "config.get": () => config.get(),
    "config.set": (input) => config.set(input),
    "login.start": () => {
      throw new Error(CLAUDE_POOL_LOGIN_RETIRED);
    },
    "login.complete": () => {
      throw new Error(CLAUDE_POOL_LOGIN_RETIRED);
    },
    "codexLogin.start": (target) => codexLogin.start(target),
    "codexLogin.poll": (input) => codexLogin.poll(input),
    "codexLogin.cancel": (input) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "status.routedThreads": () => operations.routedThreadsWithoutLocalLogin(),
    "token.rotate": ({ machine }) => operations.rotateToken(machine),
    "bypass.set": ({ threadId, bypassed }) =>
      operations.setBypass(threadId, bypassed),
  };
}
