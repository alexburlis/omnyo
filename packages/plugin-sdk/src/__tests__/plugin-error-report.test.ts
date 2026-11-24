import { describe, expect, it } from "vitest";
import { validatePluginErrorReport } from "../internal/host-policy.js";

describe("validatePluginErrorReport", () => {
  it("accepts an Error with fixed operation and code identifiers", () => {
    const error = new Error("Expo push receipt failed: InvalidCredentials");

    expect(
      validatePluginErrorReport(error, {
        operation: "expo.receipt",
        code: "InvalidCredentials",
      }),
    ).toEqual({
      error,
      operation: "expo.receipt",
      code: "InvalidCredentials",
    });
  });

  it("preserves bounded technical diagnostics and rejects content fields", () => {
    const error = new Error("private error body");

    const diagnostic = {
      stage: "receive",
      failureClass: "connection",
      outcome: "terminal",
      retryable: true,
      attempt: 3,
      itemCount: 20,
      transportCode: "ECONNRESET",
      status: 503,
    };

    expect(
      validatePluginErrorReport(error, {
        operation: "expo.receipts",
        code: "network",
        experimental_diagnostic: diagnostic,
      }),
    ).toEqual({
      error,
      operation: "expo.receipts",
      code: "network",
      experimental_diagnostic: diagnostic,
    });

    for (const extra of [
      { message: "private body" },
      { transportCode: "PRIVATE_CUSTOM_CODE" },
      { itemCount: 100001 },
      { status: 999 },
      { attempt: 0 },
    ]) {
      expect(() =>
        validatePluginErrorReport(error, {
          operation: "expo.receipts",
          code: "network",
          experimental_diagnostic: { ...diagnostic, ...extra },
        }),
      ).toThrow(TypeError);
    }
  });

  it.each([
    ["a non-Error value", "failed", { operation: "op", code: "x" }],
    ["a missing report", new Error("failed"), undefined],
    [
      "free text in the code",
      new Error("failed"),
      { operation: "op", code: "device token abc" },
    ],
    ["an empty operation", new Error("failed"), { operation: "", code: "x" }],
    [
      "an overlong code",
      new Error("failed"),
      { operation: "op", code: "x".repeat(65) },
    ],
  ])("refuses %s", (_case, error, report) => {
    expect(() => validatePluginErrorReport(error, report)).toThrow(TypeError);
  });
});
