import { describe, expect, it } from "vitest";
import { OmnyoHttpError } from "../sdk";
import { classifyOutboxFailure } from "./send-outbox-failure";

function httpError(
  status: number,
  code: string | null,
  body: unknown = { message: "Refused by the server" },
): OmnyoHttpError {
  return new OmnyoHttpError({ body, code, message: "failed", status });
}

describe("send outbox failure classification", () => {
  it("keeps a message waiting for lost connections, busy or older servers and signed-out sessions", () => {
    expect([
      classifyOutboxFailure(new TypeError("fetch failed")),
      classifyOutboxFailure(httpError(503, "coordinator_busy")),
      classifyOutboxFailure(httpError(404, null)),
      classifyOutboxFailure(httpError(401, "unauthorized")),
      classifyOutboxFailure(
        httpError(409, "busy", { message: "Try again", retryable: true }),
      ),
    ]).toEqual([
      { kind: "retry" },
      { kind: "retry" },
      { kind: "retry" },
      { kind: "retry" },
      { kind: "retry" },
    ]);
  });

  it("pauses a message the server refused for its content or destination", () => {
    expect([
      classifyOutboxFailure(httpError(409, "submission_conflict")),
      classifyOutboxFailure(httpError(404, "thread_not_found")),
      classifyOutboxFailure(httpError(400, null, null)),
    ]).toEqual([
      {
        kind: "terminal",
        code: "submission_conflict",
        message: "Refused by the server",
      },
      {
        kind: "terminal",
        code: "thread_not_found",
        message: "Refused by the server",
      },
      {
        kind: "terminal",
        code: "http_400",
        message: "The server did not accept this message.",
      },
    ]);
  });
});
