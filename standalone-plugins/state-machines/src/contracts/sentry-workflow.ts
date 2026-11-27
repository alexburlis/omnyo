import { z } from "zod";
import type { Effect, StateDefinition } from "./definition.js";

export const sentryWorkflowOperationSchema = z.enum([
  "investigate",
  "repair",
  "verify",
  "review",
  "publish",
  "merge",
  "plan-delivery",
  "release",
  "deliver",
  "verify-delivery",
  "resolve",
  "defer",
]);

export const sentryWorkflowEffects = {
  investigate: "external-read",
  repair: "local-edit",
  verify: "local-read",
  review: "external-read",
  publish: "external-write",
  merge: "external-write",
  "plan-delivery": "external-read",
  release: "external-write",
  deliver: "external-write",
  "verify-delivery": "external-read",
  resolve: "external-write",
  defer: "external-write",
} satisfies Record<z.infer<typeof sentryWorkflowOperationSchema>, Effect>;

export const sentryWorkflowCommandSchema = z.tuple([
  z.literal("omnyo"),
  z.literal("sentry"),
  z.literal("workflow-step"),
  sentryWorkflowOperationSchema,
  z.literal("--run"),
  z.string().regex(/^run_[a-zA-Z0-9_-]+$/u),
]);

const outcomes = {
  investigate: [
    "proven-defect",
    "reporting-noise",
    "needs-diagnostics",
    "deferred",
    "already-fixed",
  ],
  repair: ["fixed"],
  verify: ["verified"],
  review: ["approved", "changes-required"],
  publish: ["published"],
  merge: ["merged", "pending"],
  "plan-delivery": ["delivery-required", "no-delivery", "release-required"],
  release: ["released", "release-required"],
  deliver: ["delivered", "pending", "release-required"],
  "verify-delivery": ["verified", "awaiting-evidence", "pending"],
  resolve: ["resolved"],
  defer: ["recorded"],
} satisfies Record<z.infer<typeof sentryWorkflowOperationSchema>, string[]>;

export function sentryWorkflowOutcomes(state: StateDefinition): readonly string[] | null {
  if (state.kind !== "command" || state.action.shell !== false) return null;

  const argv = state.action.argv.map((part, index) =>
    "literal" in part ? part.literal : index === 5 ? "run_validation" : null,
  );

  const parsed = sentryWorkflowCommandSchema.safeParse(argv);

  if (!parsed.success || state.effect !== sentryWorkflowEffects[parsed.data[3]]) return null;

  return outcomes[parsed.data[3]];
}
