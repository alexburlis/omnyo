import { z } from "zod";

// eslint-disable-next-line no-control-regex
const providerText = /^[^\x00-\x1f\x7f]+$/;

const boundedIdentifier = z.string().min(1).max(256).regex(providerText);

export const codexResetCreditsInputSchema = z.strictObject({
  accountId: z.uuid(),
});

export const codexResetCreditsSchema = z.strictObject({
  accountId: z.uuid(),
  availableCount: z.number().int().min(0).max(10_000),
  credits: z
    .array(
      z.strictObject({
        id: boundedIdentifier,
        status: z.string().min(1).max(64).regex(providerText),
        expiresAt: z.iso.datetime({ offset: true }).nullable(),
      }),
    )
    .max(100),
  fetchedAt: z.number().int().nonnegative(),
});

export const codexRedeemResetInputSchema = z.strictObject({
  accountId: z.uuid(),
  creditId: boundedIdentifier,
  redeemRequestId: z.uuid(),
  confirmed: z.literal(true),
});

export const codexRedeemResetSchema = z.strictObject({
  accountId: z.uuid(),
  code: z.enum(["reset", "already_redeemed", "no_credit", "nothing_to_reset"]),
  usageRefreshError: z.string().max(256).nullable(),
});

export type CodexResetCredits = z.infer<typeof codexResetCreditsSchema>;

export type CodexRedeemReset = z.infer<typeof codexRedeemResetSchema>;
