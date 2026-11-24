import { describe, expect, it } from "vitest";
import {
  shouldFlushEventsBeforeReportingCommandResult,
  type HostDaemonCommand,
} from "../src/commands.js";

describe("interactive resolution event ordering", () => {
  it.each(["allow_once", "deny"] as const)(
    "acknowledges %s without waiting for unrelated daemon events",
    (decision) => {
      const command: Extract<
        HostDaemonCommand,
        { type: "interactive.resolve" }
      > = {
        type: "interactive.resolve",
        environmentId: "env-approval-events",
        threadId: "thread-approval-events",
        interactionId: "interaction-approval-events",
        providerId: "claude-code",
        providerThreadId: "provider-thread-approval-events",
        providerRequestId: "provider-request-approval-events",
        resolution: { decision, grantedPermissions: null },
      };

      expect(shouldFlushEventsBeforeReportingCommandResult(command)).toBe(
        false,
      );
    },
  );
});
