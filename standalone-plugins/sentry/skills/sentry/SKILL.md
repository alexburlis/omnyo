---
name: sentry
description: Inspect Omnyo Sentry routes and runs, or complete the one Sentry investigation owned by this chat.
---

# Omnyo Sentry

Use `omnyo sentry status --json` and `omnyo sentry doctor --json` to inspect readiness.
Use `omnyo sentry routes list --json` and `omnyo sentry runs list --json` for bounded execution state.
Routes are explicit project, host, repository, base ref and delivery contracts. Never infer a different target.

## State Machines maintenance

`omnyo sentry workflow status --json` shows the pinned policy and per-issue graph instances.
`omnyo sentry workflow configure --file PATH --machine HOST --json` configures a watched PR route, its persistent environment, optional enabled manual repair routes, recorded authority and allowed native surfaces. Core owns plugin installation jobs; the graph chooses plugin or hot-web delivery before runtime/native releases. A fix that needs a runtime release stops after the merge at the **Release needed** gate in the run's chat: **Release now** joins a queued release that will contain it or starts one requested release, and **Ship with the next release** waits until an offered release contains it. Sentry never starts a release without that choice. An offered update is not proof that the affected client installed the fix.

Only one Sentry run holds the execution slot at a time. A step refused before its worker chat starts, for example while another run holds the slot, stops with that reason and nothing to reconcile; retry it after the other run finishes. "Outcome unknown" means a worker or effect may have started: inspect that step's worker and receipts before cancelling or retrying it.

A thread launched as a State Machines worker follows its finite stage prompt and uses only `sentry_workflow_result`. Do not start a goal, another solver, push, merge, publish or change issue state from that worker. The graph owns those effects. Classification distinguishes proven defects, proven reporting noise, useful missing diagnostics, deferred evidence and already-fixed issues. Diagnostics-only repairs leave the original issue unresolved. Independent runtime proof must match the delivered source before resolution.

The signed receiver is `POST /api/v1/plugins/sentry/http/webhook`. Configure its protected webhook signing secret from the Sentry integration Client Secret. Sentry sends issue webhooks immediately; a one-minute reconciliation scan catches missed deliveries and reports failures visibly. With no configured reachable webhook, intake is polling, not instantaneous.

## Shared solver policy

Solve issue, Solve all and their package workers receive both this adapter and
[solve-sentry-issues](../solve-sentry-issues/SKILL.md) from the plugin package.
The shared skill owns investigation, intended development targets, diagnostics,
verification and Sentry dispositions. This adapter owns tool usage, route scope,
worker ownership, review, publication permissions and continuation. These narrower
execution permissions never authorize a production effect forbidden by the policy.
A worker applies the shared policy only to its assigned issues and repository.
The coordinator applies it to the watched mappings and reports missing app scope.

## Owned investigation

Call `sentry_run_context` first and run the goal command in the launch prompt.
Read the route's repository and parent instructions. Establish the intended
version before editing; if it differs from the route's base, report the mismatch
without changing the route or editing a different target. Preserve other agents'
work and existing owners.

Commit owned changes locally and obtain the independent review in the launch
prompt before `sentry_finish_run`. Fix valid findings for at most two review
rounds; leave unresolved findings visible. A report without code needs no review.

Submit the structured result through `sentry_finish_run`; do not push or open a PR
independently. The tool reruns the route's checks and can publish only its enabled
exact draft-PR target. Before submission, inspect push and PR automation. A route
permission does not authorize a production deployment triggered by that push.
Keep the local repair and report the deployment gate when production permission
is absent.

Use `fix-ready` for a proven source repair with its original proof and owned
commit. A proven diagnostic-gap repair may also use `fix-ready`, while the original
incident's cause stays explicitly unknown in `rootCause` and `limitations`.
For grouped work, keep that incident's finding `blocked` unless the incident itself
was proved fixed. Use `no-fix`, `needs-evidence` or `blocked` for report-only results.
Never equate accepted code or a diagnostic improvement with a repaired incident.

A refused submission records nothing; report its reason. A fix-ready result
requires the execution slot; after release, Retry selects the retained owner.
A stopped turn pauses the run. Do not duplicate a worker or replay publication.

Merge only when the plugin settings enable it, the completion tool verified the
exact reviewed commit, the reviewer approved it and required CI passed. Do not
merge if that would deploy production without the user's explicit request.
Never bypass branch protection or merge a PR this run did not create.

Change Sentry state only when the run enables triage, after its result is recorded,
and only for assigned issues. Follow the shared skill's version-aware dispositions,
including verified repairs in the intended development version that are not merged
or deployed. Verify the actual future-release condition and read back every change.
When triage is disabled or the API cannot safely express the condition, report the
intended disposition and limitation. Do not replace it with unconditional resolution.

## Diagnostics awaiting a release

For eligible diagnostics-only work, record a blocked finding with the exact Sentry
release in `diagnosticsRelease`. Cite a committed regression shared by the finding and
the reproduction, and run the exact configured route check that exercises it. After
`sentry_finish_run` verifies the commit, call `sentry_wait_for_diagnostics_release`.
Use the tool's returned state as proof. The original incident stays unresolved.

The plugin verifies a version-named release's source commit and finished deployment
in the route's exact project and environment. A release named by the full verified
commit or repository name plus that commit uses matching project and environment
telemetry. The plugin keeps an owned temporary archive
while waiting and restores notifications when that build ships. The archive expires
if verification or renewal becomes unavailable. Preserve alerts for active
consequential failures and keep notifications active if the exact build cannot be
identified. Report any pending or interrupted hold with its reason.

## Worker reporting

Finish with the actual accepted result, review verdict, commit or PR and merge state,
per-issue disposition, development target, deployment state and limits.

## Route operations

- `omnyo sentry routes set --file ABSOLUTE_JSON_PATH --machine FILE_OWNER_ID --json` saves a route paused.
- `omnyo sentry routes enable ROUTE_ID --json` opts into watching that exact scope; it does not enable automatic solving.
- `omnyo sentry routes pause ROUTE_ID --json` stops new intake/dispatch and revokes publication.
- `omnyo sentry sync --dry-run --json` previews eligible rows without creating runs.
- `omnyo sentry investigate ISSUE_URL --route ROUTE_ID --mode local --json` selects one current issue.
- Add `--provider ID --model ID --reasoning LEVEL [--tier TIER]` to `investigate` to choose that solver's model.
- `omnyo sentry models show --json` lists the default models; `omnyo sentry models set solver|coordinator|reviewer --provider ID --model ID --reasoning LEVEL [--tier TIER]` changes one. The Sentry panel and Settings show the same three pickers.
- `omnyo sentry runs show RUN_ID --json`, `stop RUN_ID` and `retry RUN_ID` operate on the existing owner.
- Retrying an unsubmitted manual queued run selects that exact owner for the next free execution slot. A busy slot is preserved; the selection survives restart. Ordinary unselected dispatch remains FIFO.
- `omnyo sentry reconcile --json` recovers only settled owners whose native chat is idle with no queued messages or background agents, then dispatches the retained queue. Uncertain or active owners keep their claim. This does not retire their source or idle runtime.

Auto solve is a separate per-Omnyo-project opt-in in Projects. The default cap is 10 automatic starts per UTC day, configurable from 1 to 1000. Manual starts remain available at the cap. Existing backlog stays manual.

Use protected plugin settings for an existing Sentry credential. Never put a credential in command
arguments, ordinary chat, logs or a route file. New routes default to local delivery and disabled.
PR delivery requires owner permission for the unchanged exact repository and branch scope.
Existing Omnyo permissions and notification preferences remain in effect.

## Project-wide investigations

Solve all starts a coordinator in the selected Omnyo project on the Solve all model chosen in the
Sentry panel (GPT-6.1 Sol Ultra unless changed). Check `omnyo pursue status` first and reuse a
matching goal or run the command in the launch instructions. Use subagents for causal grouping and independent inspection.
The canonical umbrella and all inspection subagents are inspection-only. Read every page of
`sentry_project_context`; it includes all watched repository scopes, not just the visible inbox.
Queue each causal package through `sentry_queue_package` with its exact route and all member keys.
The plugin creates isolated repository workers on the same model and retains existing owners.
The complete package rationale is an immutable handoff in the worker's initial prompt, context and retained-owner retry.
Native batch waits appear as queued, running, waiting or blocked in the sidebar and composer, including packages without worker chats. This is display only; the native callback owns continuation.
For grouped workers, submit `issueFindings` for every assigned issue: fixed, already-fixed, not-actionable or blocked,
with actual causal/regression evidence paths. One primary repair does not establish every issue fixed.

Use `sentry_finish_project` to wait for active packages, record blockers or submit terminal results.
If it returns waiting, end the turn and let the native callback resume the same coordinator. Verify
each package's results and queue follow-up packages in the same batch. Continue unaffected mappings
while a route or approval is blocked. Record the missing prerequisite, next action and actor for
each remaining blocker. Verify every issue from actual findings and checks, and recheck all watched
unresolved queues with pagination and release conditions. Report required approvals and actionable
blockers as unfinished. Only package workers review, merge, publish or set Sentry state within their
exact route authority.
