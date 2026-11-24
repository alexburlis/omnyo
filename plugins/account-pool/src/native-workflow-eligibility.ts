import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  type WorkflowModelCapabilities,
} from "./workflow-contract.js";

type NativeInput = { providerId: "codex" | "claude-code"; model: string };

const unavailable =
  "The native CLI account does not have verified included-only workflow allowance.";

const personalPlan = z.enum(["free", "go", "plus", "pro", "promax", "prolite"]);

const authSchema = z.object({
  auth_mode: z.enum(["chatgpt"]).nullish(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

const windowSchema = z.object({
  usedPercent: z.number().min(0).lt(100),
  resetsAt: z.number().positive(),
  windowDurationMins: z.number().positive(),
});

const limitsSchema = z.object({
  planType: personalPlan,
  primary: windowSchema.nullable(),
  secondary: windowSchema.nullable(),
  credits: z.object({
    hasCredits: z.literal(false),
    unlimited: z.literal(false),
    balance: z.string().regex(/^0(?:\.0+)?$/u),
  }),
  spendControlReached: z.literal(false).nullable(),
  rateLimitReachedType: z.null(),
});

const snapshotSchema = z.object({
  account: z.object({
    account: z.object({ type: z.literal("chatgpt"), planType: personalPlan }),
  }),
  quota: z.object({
    ordinaryUsageAllowed: z.literal(true),
    accountId: z.string().min(1),
    rateLimits: limitsSchema,
    rateLimitsByLimitId: z.record(z.string(), limitsSchema).nullish(),
  }),
});

export function validateNativeCodexAllowance(
  raw: unknown,
  accountId: string,
  now = Date.now(),
): void {
  const parsed = snapshotSchema.safeParse(raw);

  if (!parsed.success) throw new Error(unavailable);
  const { account, quota } = parsed.data;

  if (
    quota.accountId !== accountId ||
    account.account.planType !== quota.rateLimits.planType
  )
    throw new Error(unavailable);

  for (const limits of [
    quota.rateLimits,
    ...Object.values(quota.rateLimitsByLimitId ?? {}),
  ]) {
    const windows = [limits.primary, limits.secondary].filter(
      (window) => window !== null,
    );

    if (
      windows.length === 0 ||
      windows.some((window) => window.resetsAt * 1000 <= now)
    )
      throw new Error(unavailable);
  }
}

async function readAuth() {
  try {
    const home = path.resolve(
      process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
    );

    return authSchema.parse(
      JSON.parse(await readFile(path.join(home, "auth.json"), "utf8")),
    );
  } catch {
    throw new Error(unavailable);
  }
}

async function nativeCodexSnapshot(signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim() || "codex",
      ["app-server"],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );

    let buffer = "";
    let account: unknown;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let result: { error?: Error; value?: unknown } | undefined;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      result = { error, value };
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.kill();
      cleanupTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      closeTimer = setTimeout(() => reject(new Error(unavailable)), 3000);
    };

    child.once("close", () => {
      clearTimeout(cleanupTimer);
      clearTimeout(closeTimer);

      if (!settled) finish(new Error(unavailable));
      clearTimeout(cleanupTimer);
      clearTimeout(closeTimer);

      if (result?.error) reject(result.error);
      else resolve(result?.value);
    });
    const abort = () => finish(new Error(unavailable));
    const timer = setTimeout(abort, 15_000);
    signal.addEventListener("abort", abort, { once: true });

    const send = (value: unknown) =>
      child.stdin.write(JSON.stringify(value) + "\n");

    child.on("error", abort);
    child.on("exit", () => {
      if (!settled) abort();
    });
    child.stdin.on("error", abort);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      if (Buffer.byteLength(buffer) > 256 * 1024) {
        abort();

        return;
      }

      let newline: number;

      while ((newline = buffer.indexOf("\n")) >= 0 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        try {
          const message = z
            .object({
              id: z.number().optional(),
              error: z.unknown().optional(),
              result: z.unknown().optional(),
            })
            .parse(JSON.parse(line));

          if (message.error !== undefined) {
            abort();

            return;
          }

          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({
              id: 2,
              method: "account/read",
              params: { refreshToken: false },
            });
          } else if (message.id === 2) {
            account = message.result;
            send({ id: 3, method: "account/rateLimits/read", params: {} });
          } else if (message.id === 3)
            finish(undefined, { account, quota: message.result });
        } catch {
          abort();
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "omnyo_workflow_allowance", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function withNativeWorkflowAccount<T>(
  signal: AbortSignal,
  consume: (account: {
    headers: Headers;
    accountId: string;
    url: string;
  }) => Promise<T>,
): Promise<T> {
  const before = await readAuth();
  const snapshot = await nativeCodexSnapshot(signal);
  validateNativeCodexAllowance(snapshot, before.tokens.account_id);
  const after = await readAuth();

  if (
    after.tokens.account_id !== before.tokens.account_id ||
    after.tokens.access_token !== before.tokens.access_token
  )
    throw new Error(unavailable);
  signal.throwIfAborted();

  return consume({
    accountId: after.tokens.account_id,
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: new Headers({
      Authorization: `Bearer ${after.tokens.access_token}`,
      "ChatGPT-Account-Id": after.tokens.account_id,
    }),
  });
}

export async function nativeWorkflowEligibility(
  input: NativeInput,
  signal: AbortSignal,
): Promise<WorkflowModelCapabilities> {
  if (input.providerId === "claude-code")
    return {
      available: false,
      code: "allowance_unavailable",
      message: CLAUDE_WORKFLOW_UNAVAILABLE,
    };

  try {
    await withNativeWorkflowAccount(signal, async () => undefined);

    return { available: true };
  } catch {
    return {
      available: false,
      code: "allowance_unavailable",
      message: unavailable,
    };
  }
}
