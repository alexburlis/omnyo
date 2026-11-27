import { z } from "zod";
import { relativePath, sha, text } from "./contract-fields";

const checkReceiptSchema = z
  .object({
    name: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/u)
      .max(30)
      .optional(),
    termination: z.enum(["timeout", "cancelled", "output-limit", "spawn-error"]).optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
    output: z.string().max(1000),
  })
  .strict();

export type CheckReceipt = z.infer<typeof checkReceiptSchema>;

export function checkPassed(receipt: Pick<CheckReceipt, "exitCode" | "termination" | "signal">) {
  return receipt.exitCode === 0 && !receipt.termination && !receipt.signal;
}

export const verificationSchema = z
  .object({
    head: sha,
    tree: sha,
    changedFiles: z.array(relativePath),
    checks: z.array(checkReceiptSchema),
  })
  .strict();

export type Verification = z.infer<typeof verificationSchema>;

export const diagnosticsReleaseSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9_.@+:-]*$/iu);

const issueFindingSchema = z
  .object({
    key: z.string().min(1),
    outcome: z.enum(["fixed", "already-fixed", "not-actionable", "blocked"]),
    summary: text,
    evidence: z.array(relativePath).max(20),
    diagnosticsRelease: diagnosticsReleaseSchema.optional(),
  })
  .strict()
  .refine((finding) => !finding.diagnosticsRelease || finding.outcome === "blocked", {
    message: "A diagnostics release leaves the original issue blocked",
  });

export const completionSchema = z
  .object({
    outcome: z.enum(["fix-ready", "no-fix", "needs-evidence", "blocked"]),
    classification: z.enum(["Reproduced", "Proven by inspection", "Hypothesis"]),
    summary: text,
    rootCause: text,
    change: z.string().max(4000).default(""),
    commit: sha.nullable().default(null),
    changedFiles: z.array(relativePath).max(100).default([]),
    reproduction: z
      .object({
        command: text,
        before: text,
        after: text,
        evidence: z.array(relativePath).min(1).max(20),
      })
      .strict()
      .nullable()
      .default(null),
    checks: z.array(checkReceiptSchema).max(20).default([]),
    limitations: z.array(text).max(20).default([]),
    issueFindings: z.array(issueFindingSchema).max(100).optional(),
  })
  .strict();

export type Completion = z.infer<typeof completionSchema>;

export function assertRequiredChecks(
  route: { checks: readonly { name: string }[] },
  receipt: Verification,
) {
  if (
    route.checks.length !== receipt.checks.length ||
    route.checks.some(
      (check, index) =>
        receipt.checks[index]?.name !== check.name || !checkPassed(receipt.checks[index]),
    )
  )
    throw new Error("Required verification did not pass");
}
