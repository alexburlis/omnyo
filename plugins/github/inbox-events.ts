import { z } from "zod";

export const GITHUB_EVENT_KINDS = ["pr", "checks"] as const;

export const PR_EVENT_FIELDS = "state,mergedAt,statusCheckRollup";

export interface GithubEventKey {
  kind: (typeof GITHUB_EVENT_KINDS)[number];
  repo: string;
  number: number;
}

const KEY =
  /^github-(pr|checks):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

export const prEventViewSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().nullable(),
  statusCheckRollup: z
    .array(
      z.object({
        status: z.string().nullish(),
        conclusion: z.string().nullish(),
        state: z.string().nullish(),
      }),
    )
    .nullable(),
});

export type PrEventView = z.infer<typeof prEventViewSchema>;

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export function parseGithubEventKey(key: string): GithubEventKey | null {
  const match = KEY.exec(key);

  if (match === null) return null;

  return {
    kind: match[1] === "pr" ? "pr" : "checks",
    repo: match[2] ?? "",
    number: Number(match[3]),
  };
}

export function githubEventResult(
  key: GithubEventKey,
  view: PrEventView,
): string | null {
  if (key.kind === "pr") {
    if (view.state === "MERGED") return `${key.repo}#${key.number} merged.`;

    return view.state === "CLOSED"
      ? `${key.repo}#${key.number} closed without merging.`
      : null;
  }

  const checks = view.statusCheckRollup ?? [];

  if (checks.length === 0) return null;

  const outcomes = checks.map((check) =>
    check.status !== null && check.status !== undefined
      ? check.status === "COMPLETED"
        ? (check.conclusion ?? "NEUTRAL")
        : null
      : check.state === "PENDING" || check.state === "EXPECTED"
        ? null
        : (check.state ?? null),
  );

  if (outcomes.some((outcome) => outcome === null)) return null;

  const failed = outcomes.filter(
    (outcome) => outcome !== null && FAILED.has(outcome),
  ).length;

  return `Checks finished on ${key.repo}#${key.number}: ${checks.length - failed} passed, ${failed} failed.`;
}

export function githubEventSourceShape(kind: GithubEventKey["kind"]) {
  const family = `github-${kind}`;

  return {
    family,
    label:
      kind === "pr"
        ? "A GitHub pull request merges or closes"
        : "Every check on a GitHub pull request finishes",
    keyFormat: `${family}:<owner>/<repo>#<number>`,
    examples: [`${family}:get-bb/bb#123`],
    approval: "none" as const,
    validate: (target: string) =>
      parseGithubEventKey(`${family}:${target}`) === null
        ? "expected <owner>/<repo>#<number>"
        : null,
    describe: (target: string) =>
      kind === "pr" ? `${target} merges or closes` : `Checks finish on ${target}`,
  };
}
