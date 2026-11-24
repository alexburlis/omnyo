import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex-adapter.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const adapter = createCodexAdapter({
  refreshUrl: "http://127.0.0.1:1/oauth/token",
  usageUrl: "http://127.0.0.1:1/usage",
  now: () => NOW,
});

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("Codex client error responses", () => {
  it("ends the Codex turn with a usage limit when the pool is blocked until a distant reset", async () => {
    const response = adapter.errorResponse(
      429,
      "No Account Pooler account is currently eligible.",
      { "retry-after": String(3 * 86_400) },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(3 * 86_400));
    expect(await body(response)).toEqual({
      error: {
        message: "No Account Pooler account is currently eligible.",
        type: "usage_limit_reached",
        resets_at: NOW / 1_000 + 3 * 86_400,
      },
    });
  });

  it.each([
    ["a short hold", { "retry-after": "20" }],
    ["the one-minute limit", { "retry-after": "60" }],
    ["no retry advice", {}],
  ])("keeps %s retryable inside Codex", async (_label, headers) => {
    expect(
      await body(adapter.errorResponse(429, "Rate limited.", headers)),
    ).toEqual({
      error: {
        message: "Rate limited.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
  });

  it("leaves non-429 failures as API errors even with distant retry advice", async () => {
    expect(
      await body(
        adapter.errorResponse(503, "Unavailable.", { "retry-after": "86400" }),
      ),
    ).toEqual({
      error: { message: "Unavailable.", type: "api_error", code: null },
    });
  });
});
