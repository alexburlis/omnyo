import { z } from "zod";
import type { Account } from "./contracts.js";
import { CLAUDE_WORKFLOW_UNAVAILABLE } from "./workflow-contract.js";

const zeroBalance = z.union([z.literal(0), z.string().regex(/^0(?:\.0+)?$/u)]);

const window = z.object({
  used_percent: z.number().min(0).lt(100),
  reset_at: z.number().positive().nullish(),
  reset_after_seconds: z.number().positive().nullish(),
});

const codexAllowance = z.object({
  account_id: z.string().optional(),
  plan_type: z.enum(["free", "go", "plus", "pro", "promax", "prolite"]),
  credits: z.object({
    has_credits: z.literal(false),
    unlimited: z.literal(false),
    balance: zeroBalance,
  }),
  spend_control: z.object({ reached: z.literal(false) }).nullish(),
  rate_limit_reached_type: z.null().optional(),
  rate_limit: z.object({
    allowed: z.literal(true),
    limit_reached: z.literal(false),
    primary_window: window.nullish(),
    secondary_window: window.nullish(),
  }),
});

export function validatePooledWorkflowAllowance(
  raw: unknown,
  account: Pick<Account, "provider" | "subscriptionType" | "codexAccountId">,
  now = Date.now(),
): void {
  if (account.provider === "claude")
    throw new Error(CLAUDE_WORKFLOW_UNAVAILABLE);

  const data = codexAllowance.parse(raw);

  if (
    data.plan_type !== account.subscriptionType ||
    (data.account_id !== undefined &&
      data.account_id !== account.codexAccountId)
  )
    throw new Error("Workflow subscription identity changed.");

  const windows = [
    data.rate_limit.primary_window,
    data.rate_limit.secondary_window,
  ].filter((value) => value != null);

  if (
    windows.length === 0 ||
    windows.some((value) =>
      value.reset_at != null
        ? value.reset_at * (value.reset_at < 1e12 ? 1000 : 1) <= now
        : value.reset_after_seconds == null,
    )
  )
    throw new Error("Workflow included allowance is unavailable.");
}
