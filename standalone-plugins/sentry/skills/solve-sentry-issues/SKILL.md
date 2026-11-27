---
name: solve-sentry-issues
description: Audit and clear Sentry issues across an app's projects by reusing existing fixes, repairing the active development version, adding missing diagnostics, and reconciling issue states without automatic production deployment.
disable-model-invocation: true
---

# Solve Sentry Issues

Bring the requested app's Sentry queue to zero unresolved issues through verified
repairs and defensible dispositions. Every issue needs a treatment; a clean count
must not conceal a current actionable failure. A read-only audit stops at findings.
A request to fix or clear the queue includes local implementation and verification.
Honor the current request's authority for Sentry comments and status changes; an
explicit request to clear the queue includes those scoped issue updates unless
restricted by the user. Do not expand the task to unrelated projects or settings.

Follow the repository's diagnostic and access standards for the affected boundaries. Use existing authenticated Sentry tools and accounts. Never expose credentials or raw user payloads. If access is missing, report the precise limitation without treating it as an empty queue. Apply the workflow-specific development and release rules below:
verified repairs may be resolved in their intended future version before deployment.
This is distinct from claiming the exposed product is already repaired.

## Establish the development target before editing

Identify the app, its related Sentry projects, and the local version actually being
developed. Record the repository/worktree, branch, version or milestone, and the
source of that decision. Use the current conversation, repository instructions,
version files, release configuration and relevant checked-out development branches.
Keep the affected shipped version separate from the intended repair version.

Do not assume that `main`, the newest release tag or the currently deployed version
is the development target. For example, if the established work is an app's 2.0 development version,
all fixes and diagnostic changes belong in the 2.0 development source. An event
from 1.x does not authorize a 1.x patch, backport or production hotfix.

Before implementing each group, inspect current local changes, relevant Git history,
existing regression tests, and the relevant checked-out branches/worktrees. Previous
agents may have fixed the issue without updating Sentry or releasing the change.
Verify the actual causal fix and coverage; a commit title or agent's completion
claim is insufficient. Reuse a verified repair already in the target. If it exists
only elsewhere, integrate it into the established target with the project's normal
ownership rules and reverify it there. Do not duplicate it or overwrite foreign work. Preserve another agent's
uncommitted repair; do not silently commit or replace it. A fix on another branch is not a completed repair of this target.

Ask one concise question if the intended version or branch remains materially
ambiguous after inspection. Continue independent inventory work while waiting.
Never choose a stale production branch merely because its error is easier to
reproduce. Apply every owned edit only to the established development target.

## Production deployment requires a specific request

This workflow does **not** automatically deploy, publish, release, submit, install,
restart or activate a production artifact. This limit applies even if the repository
normally grants standing automatic-delivery authority. Requests to fix issues,
finish cleanup or reach zero unresolved are not production-deployment requests.
Do not push a branch that automatically deploys production without that authority.

Perform local builds, focused tests, permitted integration and commits. Prepare the
exact reviewed version, source and affected surfaces before requesting any missing
production permission. Deploy only when the user specifically requests that
production effect or confirms that concrete proposal. Honor narrower limits.
Production deployment is not a prerequisite for completing a verified future-version
repair and its supported Sentry resolution. Do not deploy merely to make Sentry's
count reach zero. Other provider settings, new release records, paid analysis, alert
recipients and infrastructure still require their own applicable authority.

## Inventory the whole requested app

Map each in-scope Sentry project to its repository, runtime and reporting entrypoint.
Include the app's relevant browser, server, worker, mobile, desktop, CLI and plugin
surfaces. Use existing accounts, SDKs and integrations.

Retrieve all unresolved issues in every identified project. Follow pagination and
verify query, environment and time-range limits; do not silently substitute a recent
window for the full queue. Review relevant resolved/archived groups for recurrence,
duplicates and unfinished prior fixes. Record starting counts and inaccessible scope.
Missing access, a capped response or no matching search result does not prove zero.

For each causal group, retain a compact row: project/issue IDs, affected runtime and
release, representative safe evidence, current relevance, intended repair target,
existing-fix location, cause/confidence, treatment, verification and final disposition.
Preserve important low-volume failures even when no user identity is available.

## Investigate and implement by causal group

Group related issues by demonstrated or plausible common cause, not title alone.
Use parallel agents for independent groups when available. Give each an explicit
development target, allowed files, evidence, verification requirement and side-effect
limits. One owner integrates shared changes and reconciles Sentry.

Use precise evidence labels:

- **Reproduced:** a harmless test or actual local path demonstrated the failure.
- **Proven by inspection:** an exact source, artifact or deterministic data-flow
  path establishes the defect and intended behavior.
- **Hypothesis:** plausible but not established; state the missing proof.

Trace representative failures through the original release, safe stack/symbols,
logs and source. Inspect the strongest contrary explanation before dismissing a
failure. A quiet observation window, old last-seen date, green health endpoint or
unrelated passing test does not prove a fix. An unsupported old release may still
have active users; record exposure separately from the chosen development target.

Give every group one concrete treatment:

| Finding                                                             | Required work                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A matching repair is already in the target                          | Verify the causal change and focused coverage; reconcile Sentry without another implementation.                                      |
| A matching repair exists only in another development branch         | Integrate safely into the target and verify the combined source before resolving.                                                    |
| The defect is proven                                                | Fix the first broken ownership, state or data-flow boundary; add meaningful regression coverage.                                     |
| The event is expected or harmless                                   | Narrow or remove incorrect capture at the outcome owner while retaining genuine failures.                                            |
| A transient failure can recover safely                              | Use bounded recovery without duplicating user actions; report terminal failure rather than each retry.                               |
| The cause remains unknown                                           | Exhaust bounded safe investigation, identify evidence that separates plausible causes, and repair that diagnostic gap in the target. |
| The report is obsolete or an exact duplicate                        | Establish the evidence and canonical owner; archive/link without deleting history.                                                   |
| The correct behavior needs a product decision or unavailable access | Name the exact blocker and continue independent groups.                                                                              |

A current consequential, reproducible failure remains actionable when its cause is
unknown. Instrumentation is a completed diagnostic repair, not proof that the
underlying product defect has been fixed. Avoid speculative behavior changes.

## Keep diagnostics useful and bounded

Prefer one report at the terminal outcome owner. Preserve useful original safe
frames and exact release/runtime identity. Add fields only when they distinguish
plausible causes or choose the next repair: operation, stage, failure category,
status/transport code, attempts, recovery outcome and bounded counts/timings.

Exclude actual cancellations, expected rejection, recovered retries and routine
activity from error incidents. Preserve unexpected exceptions, fatal failures,
persistent outages, data-integrity failures and important low-volume failures.
Do not blanket-filter network errors, timeouts, 5xx responses or unknown exceptions.
Check grouping, deduplication, symbols and alert transitions when they affect the
changed path. Do not add verbose Logs, tracing, replay or another pipeline by default.

Respect existing consent and withdrawal behavior. Keep credentials, user content,
request bodies, private paths, sensitive identifiers and unrestricted objects out of
the final serialized payload. Validate the outbound envelope, not just caller inputs.
Use the existing local diagnostic/support path for evidence that cannot go to Sentry.

## Verify the repair in the intended version

For each change, rerun its original reproduction or causal check and the focused
tests covering failure, recovery and material negative cases. Exercise real
initialization/serialization boundaries where mocks cannot prove the behavior.
Verify that added diagnostics actually separate the relevant causes. Include
privacy, duplicate suppression and consent controls for changed reporting paths.

Use the repository's required formatter, lint, typecheck and appropriate build
checks. One integration owner verifies the combined target. Reuse valid evidence;
do not launch broad suites per agent or repeat unchanged failed checks indefinitely.
Separate product regressions from test/tool limitations. Preserve source, user data,
foreign changes and existing recovery inputs; clean up owned disposable output.

## Reconcile Sentry against the correct version

Use supported issue APIs and read back each status and condition. Every worked
issue needs an explicit disposition, including issues earlier agents already fixed.

- **Verified fix already exposed:** resolve against the actual fixed release using
  its matching artifact and behavior evidence. Continued matching failures on that
  release require renewed investigation.
- **Verified fix in the intended development version, not deployed:** mark it
  **resolved in the intended next version**, using Sentry's supported future-release
  resolution. Record the exact target version/milestone, branch, commit (or explicitly uncommitted source
  state), tests and “not deployed” in the issue note. This includes an earlier agent's verified fix.
  Do not describe production as fixed or deploy it to obtain a resolved status.
- **Future-release identity:** prefer a condition tied to the intended release.
  Use generic “next release” only if the app's release/project/channel ordering
  reliably makes that the intended version. Another branch's hotfix, internal
  build or unrelated component must not accidentally satisfy it. Verify the actual
  condition on readback. If the available API cannot represent it safely, state the
  precise limitation and intended disposition; do not substitute unconditional
  resolution or invent a released artifact.
- **Expected, obsolete or duplicate:** archive/link with the evidence-backed reason
  and canonical issue where relevant. Do not delete historical events.
- **Historical unknown with diagnostics repaired:** for an explicit zero-unresolved
  request, conditionally archive only when further current investigation has no
  justified next step. Record the unknown cause, missing evidence, verified new
  diagnostics, their target version and whether they are deployed, plus the return
  condition. Prefer reopening on the next relevant occurrence when supported.
  Verify that same-group recurrence and newly grouped failures remain actionable.
  This route excludes current recurring or reproducible consequential failures;
  undeployed diagnostics alone do not justify pausing those production incidents.
- **Current unresolved defect or real blocker:** keep an honest nonterminal state.
  State what remains and why. An empty queue does not override evidence or authority.

A future-version resolution is a verified source disposition, not a claim that old
installed versions cannot recur. Preserve actionable recurrence and alert behavior.
Do not mutate alerts or project settings merely to support a preferred queue count;
prepare a precise proposal if an essential change lacks authority.

## Completion

Rerun the full unresolved query for every in-scope project with pagination and range
checks. Read back issue conditions, not only aggregate counts. Do not claim zero if
inventory, access or status synchronization is incomplete.

Report concisely:

- Starting and ending counts per project, including future-version resolutions.
- A group table with cause/uncertainty, reused or implemented repair, target branch
  and version, proof, exposure state and final Sentry disposition.
- Exact blockers, unsafe/unsupported status conditions and any production decision
  still needed. A withheld deployment alone does not make local repair incomplete.
- Links to the verified changes and retained evidence, and cleanup status.

Distinguish inventory complete, source repair verified, diagnostics added, Sentry
synchronized, diagnosis paused awaiting evidence, and production deployed. Finish
all authorized independent work. Never claim a historical cause is proved because
diagnostics were added, or hide a current failure solely to reach zero unresolved.
