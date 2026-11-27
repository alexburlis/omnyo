import type { Completion, Incident, Route, Verification } from "../contract";
import { runMarker } from "./publication-identity";
import { assertRequiredChecks } from "./repair-result-contract";

export function assertPublishable(route: Route, proposal: Completion, receipt: Verification) {
  if (!route.enabled || route.delivery !== "pr" || !route.githubRepository)
    throw new Error("PR publication is not enabled for this route");

  if (
    proposal.outcome !== "fix-ready" ||
    proposal.classification === "Hypothesis" ||
    !proposal.reproduction
  )
    throw new Error("A proven repair and its original proof are required");

  if (proposal.commit !== receipt.head) throw new Error("Verified head differs from the proposal");

  if (
    !proposal.changedFiles.length ||
    [...receipt.changedFiles].sort().join("\n") !== [...proposal.changedFiles].sort().join("\n")
  )
    throw new Error("Changed files differ from the proposal");

  assertRequiredChecks(route, receipt);
}

export function renderPullRequest(
  incident: Incident,
  runId: string,
  proposal: Completion,
  related: Incident[] = [],
) {
  const lines = [
    proposal.summary,
    "",
    "Sentry: " + incident.url,
    "",
    "Root cause: " + proposal.rootCause,
    "",
    "Change: " + proposal.change,
    "",
    "Evidence: " + proposal.classification,
  ];

  if (related.length) {
    lines.push("", "Package issues:");

    for (const issue of related) {
      const finding = proposal.issueFindings?.find((finding) => finding.key === issue.key);
      lines.push(
        "- [" +
          issue.shortId +
          "](" +
          issue.url +
          "): " +
          (finding?.outcome ?? "needs evidence") +
          " — " +
          (finding?.summary ?? "No per-issue result was supplied"),
      );

      if (finding?.evidence.length) lines.push("  Evidence: " + finding.evidence.join(", "));
    }
  }

  if (proposal.reproduction)
    lines.push(
      "",
      "Reproduction: " + proposal.reproduction.command,
      "Before: " + proposal.reproduction.before,
      "After: " + proposal.reproduction.after,
      "Evidence files: " + proposal.reproduction.evidence.join(", "),
    );

  if (proposal.checks.length)
    lines.push(
      "",
      ...proposal.checks.map((check) => "- " + check.name + ": exit " + check.exitCode),
    );

  if (proposal.limitations.length)
    lines.push("", "Limits:", ...proposal.limitations.map((value) => "- " + value));
  lines.push("", "sentry-incident:" + incident.key, runMarker(runId), "", "> AGENT GENERATED", "");

  return lines.join("\n");
}
