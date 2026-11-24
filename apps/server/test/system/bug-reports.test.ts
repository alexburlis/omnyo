import { describe, expect, it } from "vitest";
import { bugReportResponseSchema } from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function postBugReport(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/system/bug-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bug report route", () => {
  it("says reports are unavailable without a Sentry client instead of claiming success", async () => {
    await withTestHarness(async (harness) => {
      const response = await postBugReport(harness, {
        message: "The sidebar froze",
        email: "person@example.test",
      });

      expect(response.status).toBe(200);
      expect(bugReportResponseSchema.parse(await readJson(response))).toEqual({
        status: "unavailable",
        reason: "not-configured",
      });
    });
  });

  it.each([
    { name: "an empty message", body: { message: "   " } },
    {
      name: "an invalid email",
      body: { message: "It broke", email: "not-an-email" },
    },
    {
      name: "a malformed linked event id",
      body: { message: "It broke", associatedEventId: "abc" },
    },
    {
      name: "unexpected fields",
      body: { message: "It broke", screenshot: "data:image/png;base64,AAAA" },
    },
  ])("rejects $name", async ({ body }) => {
    await withTestHarness(async (harness) => {
      expect((await postBugReport(harness, body)).status).toBe(400);
    });
  });
});
