import { describe, expect, it } from "vitest";
import { completionSchema } from "../contract";
import { assertPublishable, renderPullRequest } from "../src/report";
import { route, incident } from "./fixtures";

function proposal() {
  return completionSchema.parse({
    outcome: "fix-ready",
    classification: "Reproduced",
    summary: "Fix terminal operation failure",
    rootCause: "A missing state transition left the operation incomplete.",
    change: "Complete the existing transition.",
    commit: "a".repeat(40),
    changedFiles: ["src/operation.ts"],
    reproduction: {
      command: "node --test",
      before: "failed",
      after: "passed",
      evidence: ["proof.json"],
    },
    limitations: [],
    checks: [],
  });
}

describe("publication decision and content boundary", () => {
  it("refuses a hypothesis, unverified checks, paused route and wrong head", () => {
    const configured = {
      ...route(),
      enabled: true,
      delivery: "pr" as const,
      githubRepository: "owner/client",
    };

    const report = proposal();

    const verification = {
      head: "a".repeat(40),
      tree: "b".repeat(40),
      changedFiles: report.changedFiles,
      checks: [{ name: "Tests", exitCode: 0, durationMs: 10, output: "" }],
    };

    expect(() => assertPublishable(configured, report, verification)).not.toThrow();
    expect(() =>
      assertPublishable({ ...configured, enabled: false }, report, verification),
    ).toThrow();
    expect(() =>
      assertPublishable(configured, { ...report, classification: "Hypothesis" }, verification),
    ).toThrow();
    expect(() =>
      assertPublishable(configured, report, { ...verification, head: "c".repeat(40) }),
    ).toThrow();
    expect(() => assertPublishable(configured, report, { ...verification, checks: [] })).toThrow();
    expect(() =>
      assertPublishable(configured, report, {
        ...verification,
        checks: [{ ...verification.checks[0]!, termination: "timeout" }],
      }),
    ).toThrow("Required verification did not pass");
    expect(() =>
      assertPublishable(configured, report, {
        ...verification,
        checks: [{ ...verification.checks[0]!, signal: "SIGTERM" }],
      }),
    ).toThrow("Required verification did not pass");
  });

  it("includes proof, uncertainty, the exact incident marker and required attribution", () => {
    const body = renderPullRequest(incident(), "run-1", proposal());
    expect(body).toContain("https://acme.sentry.io/issues/101/");
    expect(body).toContain("sentry-run:run-1");
    expect(body).toContain("node --test");
    expect(body.trimEnd().endsWith("> AGENT GENERATED")).toBe(true);
  });
});
