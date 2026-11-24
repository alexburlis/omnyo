import { describe, expect, it } from "vitest";
import { recordTelemetryEventRequestSchema } from "../src/api/system.js";

describe("onboarding telemetry events", () => {
  it.each([
    "onboarding_step_reached",
    "onboarding_step_completed",
    "onboarding_step_skipped",
  ])("accepts %s for the chats step", (name) => {
    const event = {
      name,
      properties: { step: "chats", entry: "first_run" },
    };

    expect(recordTelemetryEventRequestSchema.parse(event)).toEqual(event);
  });

  it("accepts the automations step", () => {
    const event = {
      name: "onboarding_step_reached",
      properties: { step: "automations", entry: "first_run" },
    };

    expect(recordTelemetryEventRequestSchema.parse(event)).toEqual(event);
  });

  it("rejects a step that is not part of the setup guide", () => {
    const result = recordTelemetryEventRequestSchema.safeParse({
      name: "onboarding_step_reached",
      properties: { step: "import", entry: "first_run" },
    });

    expect(result.success).toBe(false);
  });
});
