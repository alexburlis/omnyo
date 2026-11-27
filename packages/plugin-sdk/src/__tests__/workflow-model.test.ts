import { describe, expect, it } from "vitest";
import { experimental_workflowModelV1 } from "../workflow-model.js";

const {
  inputSchema,
  resultSchema,
  capabilitiesSchema,
  failureCodeSchema,
  contract,
} = experimental_workflowModelV1;

const input = {
  hostId: "host-test",
  attemptId: "attempt-test",
  model: "model-1",
  prompt: "text",
  timeoutMs: 1,
  maxOutputBytes: 1,
};

describe("workflow model contract v1", () => {
  it.each([
    [{}, true],
    [{ prompt: "a".repeat(128 * 1024) }, true],
    [{ prompt: "é".repeat(64 * 1024) }, true],
    [{ prompt: "é".repeat(64 * 1024 + 1) }, false],
    [{ prompt: "a".repeat(128 * 1024 + 1) }, false],
    [{ prompt: "" }, false],
    [{ tools: [] }, false],
    [{ model: "https://invalid.test" }, false],
    [{ model: ".model" }, false],
    [{ model: "a".repeat(100) }, true],
    [{ model: "a".repeat(101) }, false],
    [{ timeoutMs: 60_000 }, true],
    [{ timeoutMs: 60_001 }, false],
    [{ timeoutMs: 0 }, false],
    [{ timeoutMs: 1.1 }, false],
    [{ maxOutputBytes: 65_536 }, true],
    [{ maxOutputBytes: 65_537 }, false],
    [{ maxOutputBytes: 0 }, false],
  ])("preserves input bounds for %j", (change, accepted) => {
    expect(inputSchema.safeParse({ ...input, ...change }).success).toBe(
      accepted,
    );
  });

  it("requires identities and limits capability input to host and model", () => {
    expect(inputSchema.safeParse({}).success).toBe(false);
    const identity = { hostId: input.hostId, model: input.model };
    expect(contract.workflowModelCapabilities.input.parse(identity)).toEqual(
      identity,
    );
    expect(
      contract.workflowModelCapabilities.input.safeParse(input).success,
    ).toBe(false);
    expect(contract.workflowModelComplete.input).toBe(inputSchema);
    expect(contract.workflowModelComplete.output).toBe(resultSchema);
    expect(contract.workflowModelCapabilities.output).toBe(capabilitiesSchema);
  });

  it.each([
    [{ ok: true, attemptId: "a", text: "text" }, true],
    [{ ok: true, attemptId: "a", text: "é".repeat(32_768) }, true],
    [{ ok: true, attemptId: "a", text: "é".repeat(32_769) }, false],
    [{ ok: true, attemptId: "a", text: "text", tools: [] }, false],
    [{ ok: true, attemptId: "a", text: "" }, false],
    [{ ok: false, attemptId: "a", code: "other", message: "failure" }, false],
    [{ ok: false, attemptId: "a", code: "timeout", message: "" }, false],
    [
      { ok: false, attemptId: "a", code: "timeout", message: "a".repeat(501) },
      false,
    ],
    [
      {
        ok: false,
        attemptId: "a",
        code: "timeout",
        message: "failure",
        extra: true,
      },
      false,
    ],
  ])("preserves output bounds for %j", (value, accepted) => {
    expect(resultSchema.safeParse(value).success).toBe(accepted);
  });

  it.each(failureCodeSchema.options)(
    "accepts the %s failure variant",
    (code) => {
      expect(
        resultSchema.parse({
          ok: false,
          attemptId: "a",
          code,
          message: "failure",
        }),
      ).toEqual({ ok: false, attemptId: "a", code, message: "failure" });
    },
  );

  it.each<[unknown, boolean]>([
    [{ available: true }, true],
    [{ available: true, extra: 1 }, false],
    ...[
      "caller_not_allowed",
      "subscription_transport_unverified",
      "allowance_unavailable",
    ].map<[unknown, boolean]>((code) => [
      { available: false, code, message: "failure" },
      true,
    ]),
    [{ available: false, code: "timeout", message: "failure" }, false],
  ])("preserves capability variants for %j", (value, accepted) => {
    expect(capabilitiesSchema.safeParse(value).success).toBe(accepted);
  });
});
