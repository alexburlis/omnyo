import {
  publicUsageListingSchema,
  type ProductUsageEvent,
} from "@omnyo/domain/usage-telemetry";

export const PRODUCT_USAGE_DICTIONARY = [
  {
    name: "activity",
    purpose: "Measure return use among clients that opted in, using UTC days.",
    fields: "first: true or false",
    example: { event: "activity", properties: { first: true } },
  },
  {
    name: "feature_used",
    purpose: "Count daily use of the named core features.",
    fields: "feature: chat, queued_message, plugin",
    example: { event: "feature_used", properties: { feature: "chat" } },
  },
  {
    name: "onboarding",
    purpose: "Compare entry into onboarding steps with completion or skipping.",
    fields:
      "step: agent, projects, chats, browser, plugins, automations, devices; outcome: reached, completed, skipped; entry: first_run, replay",
    example: {
      event: "onboarding",
      properties: { step: "agent", outcome: "completed", entry: "first_run" },
    },
  },
  {
    name: "operation",
    purpose:
      "Compare attempted operations with outcomes and coarse duration ranges.",
    fields:
      "operation: new_chat, message, agent_sign_in; outcome: started, accepted, failed, cancelled; failure_reason: nonzero_exit, start_rejected, unknown (failed sign-in only); latency: unknown, under_1s, 1_to_5s, 5_to_30s, over_30s",
    example: {
      event: "operation",
      properties: {
        operation: "agent_sign_in",
        outcome: "failed",
        failure_reason: "start_rejected",
        latency: "unknown",
      },
    },
  },
  {
    name: "first_accepted_action",
    purpose:
      "Measure time from an explicit analytics grant to the first accepted human chat or message, once per grant; this is not time to a model answer.",
    fields: "since_grant: under_1m, 1_to_10m, 10_to_60m, over_60m",
    example: {
      event: "first_accepted_action",
      properties: { since_grant: "1_to_10m" },
    },
  },
  {
    name: "public_plugin_installed",
    purpose:
      "Count completed, verified public connector installations explicitly requested by a consenting client.",
    fields: `listing: ${publicUsageListingSchema.options.join(", ")}`,
    example: {
      event: "public_plugin_installed",
      properties: { listing: "workspace-github" },
    },
  },
] satisfies ReadonlyArray<{
  name: ProductUsageEvent["event"];
  purpose: string;
  fields: string;
  example: ProductUsageEvent;
}>;
