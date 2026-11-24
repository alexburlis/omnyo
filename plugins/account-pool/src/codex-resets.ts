import { z } from "zod";
import type { Account, AccountSecret, AccountQuota } from "./contracts.js";
import {
  DEFAULT_CODEX_USAGE_URL,
  codexQuotaFromUsage,
} from "./codex-adapter.js";
import {
  codexResetCodeSchema,
  codexResetProviderListingSchema,
  type CodexResetCredits,
  type CodexRedeemResetInput,
  type CodexRedeemReset,
} from "./codex-reset-contract.js";

const RESET_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const MAX_RESPONSE_BYTES = 64 * 1024;

type OAuth = Extract<AccountSecret, { kind: "oauth" }>;

export class CodexResetAuthorizationError extends Error {}

class CodexResetResponseError extends Error {}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null)
    throw new CodexResetResponseError(
      "OpenAI returned an invalid reset-credit response.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_RESPONSE_BYTES)
        throw new CodexResetResponseError(
          "OpenAI reset-credit response is too large.",
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof CodexResetResponseError) throw error;
    throw new Error(
      "Account Pooler could not read OpenAI's Codex reset response. Retry the same request ID if a reset was pending.",
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("OpenAI returned an invalid reset-credit response.");
  }
}

async function requestJson(
  upstream: typeof fetch,
  account: Account,
  oauth: OAuth,
  signal: AbortSignal,
  url: string,
  body?: object,
): Promise<unknown> {
  let response: Response;

  try {
    response = await upstream(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "chatgpt-account-id": account.codexAccountId ?? "",
        originator: "bb",
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch {
    throw new Error(
      "Account Pooler could not reach OpenAI for Codex resets. Retry the same request ID if a reset was pending.",
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);

    if (response.status === 401)
      throw new CodexResetAuthorizationError(
        "OpenAI rejected this Codex account login.",
      );
    throw new Error(`OpenAI Codex resets returned HTTP ${response.status}.`);
  }

  return readJson(response);
}

export async function fetchCodexResetCredits(
  upstream: typeof fetch,
  account: Account,
  oauth: OAuth,
  signal: AbortSignal,
  now: number,
): Promise<CodexResetCredits> {
  const result = codexResetProviderListingSchema.safeParse(
    await requestJson(upstream, account, oauth, signal, RESET_URL),
  );

  if (!result.success)
    throw new Error("OpenAI returned an invalid reset-credit response.");

  return {
    accountId: account.id,
    availableCount: result.data.available_count,
    credits: result.data.credits.map((credit) => ({
      id: credit.id,
      status: credit.status,
      expiresAt: credit.expires_at ?? null,
    })),
    fetchedAt: now,
  };
}

export async function redeemCodexReset(
  upstream: typeof fetch,
  account: Account,
  oauth: OAuth,
  signal: AbortSignal,
  input: CodexRedeemResetInput,
): Promise<CodexRedeemReset["code"]> {
  const parsed = z.object({ code: codexResetCodeSchema }).safeParse(
    await requestJson(
      upstream,
      account,
      oauth,
      signal,
      `${RESET_URL}/consume`,
      {
        ...(input.creditId === undefined ? {} : { credit_id: input.creditId }),
        redeem_request_id: input.redeemRequestId,
      },
    ),
  );

  if (!parsed.success)
    throw new Error("OpenAI returned an invalid reset-credit response.");

  return parsed.data.code;
}

export async function fetchCodexUsageAfterReset(
  upstream: typeof fetch,
  account: Account,
  oauth: OAuth,
  signal: AbortSignal,
  previous: AccountQuota,
  now: number,
): Promise<AccountQuota> {
  const payload = await requestJson(
    upstream,
    account,
    oauth,
    signal,
    DEFAULT_CODEX_USAGE_URL,
  );

  if (
    !z.object({ rate_limit: z.object({}).loose() }).safeParse(payload).success
  )
    throw new Error("OpenAI did not return observed Codex usage.");
  const quota = codexQuotaFromUsage(account.id, payload, previous, now);

  if (quota === null || quota.limitWindows.length === 0)
    throw new Error("OpenAI did not return observed Codex usage.");

  return { ...quota, heldUntil: null, error: null };
}
