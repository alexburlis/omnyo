import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

// eslint-disable-next-line no-control-regex
const providerText = /^[^\u0000-\u001f\u007f]+$/u;

const providerIdentifier = z.string().min(1).max(256).regex(providerText);

export const codexResetCreditsInputSchema = z
  .object({ accountId: z.string().uuid() })
  .strict();

export const codexRedeemResetInputSchema = codexResetCreditsInputSchema
  .extend({
    creditId: providerIdentifier.optional(),
    redeemRequestId: z.string().uuid(),
  })
  .strict();

export const codexResetCodeSchema = z.enum([
  "reset",
  "already_redeemed",
  "no_credit",
  "nothing_to_reset",
]);

export const codexResetCreditsSchema = z
  .object({
    accountId: z.string().uuid(),
    availableCount: z.number().int().min(0).max(10000),
    credits: z
      .array(
        z
          .object({
            id: providerIdentifier,
            status: z.string().min(1).max(64).regex(providerText),
            expiresAt: z.iso.datetime({ offset: true }).nullable(),
          })
          .strict(),
      )
      .max(100),
    fetchedAt: z.number().int().nonnegative(),
  })
  .strict();

export const codexRedeemResetSchema = z
  .object({
    accountId: z.string().uuid(),
    code: codexResetCodeSchema,
    usageRefreshError: z.string().max(256).nullable(),
  })
  .strict();

export const codexResetRpcContract = defineRpcContract({
  "experimental_codex-resets.v1.credits": {
    input: codexResetCreditsInputSchema,
    output: codexResetCreditsSchema,
  },
  "experimental_codex-resets.v1.redeem": {
    input: codexRedeemResetInputSchema,
    output: codexRedeemResetSchema,
  },
});

export type CodexResetCreditsInput = z.infer<
  typeof codexResetCreditsInputSchema
>;

export type CodexRedeemResetInput = z.infer<typeof codexRedeemResetInputSchema>;

export type CodexResetCredits = z.infer<typeof codexResetCreditsSchema>;

export type CodexRedeemReset = z.infer<typeof codexRedeemResetSchema>;

export const codexResetProviderListingSchema = z.object({
  available_count: codexResetCreditsSchema.shape.availableCount,
  credits: z
    .array(
      z.object({
        id: providerIdentifier,
        status: codexResetCreditsSchema.shape.credits.element.shape.status,
        expires_at: z.iso.datetime({ offset: true }).nullish(),
      }),
    )
    .max(100),
});
