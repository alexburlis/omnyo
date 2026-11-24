---
name: launch-qa-personas
description: Exercise a web app through five simulated first-time journeys, consolidate observed problems, and rerun authorized fixes.
license: MIT
---

# Launch QA Personas

Find confusing or broken first-use paths in a running web app. The five viewpoints are simulations that guide exploration; their reactions are not customer research or conversion metrics.

## Define the run

Identify the exact build, entry URL, first successful user outcome, supported viewport, and permitted actions. Use a local or staging environment and disposable test state where available. Establish a stopping point before payment, messages, invitations, destructive changes, or external account creation unless those exact actions are authorized.

Use an available browser automation tool such as Playwright, or a supported browser-control integration. Keep one independent browser context per viewpoint, or clear only owned test state between sequential runs. Do not assume that opening another tab isolates cookies. Agree on a bounded time or action budget for each journey.

Run a smoke check first. If the app cannot load, record that failure with its response or console evidence and stop persona exploration until the access problem is understood.

## Explore five viewpoints

Give each run the same objective and only information a first-time visitor would have. Do not disclose the implementation, hidden routes, or intended solution. These viewpoints can run sequentially; parallel execution is optional and requires isolated state.

| Viewpoint            | Exploration emphasis                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Time-limited visitor | Find the primary action quickly; notice competing choices and unnecessary steps.         |
| Cautious evaluator   | Understand cost, permissions, data use, reversibility, and evidence behind claims.       |
| Small-screen visitor | Complete the task at the agreed mobile width, with measured throttling if available.     |
| Literal reader       | Follow labels as written; notice jargon, ambiguous references, and missing instructions. |
| Boundary explorer    | Try empty, long, duplicate, and invalid inputs within the permitted test scope.          |

Do not impersonate a demographic or infer a disability from one viewpoint. Simulated throttling is a test condition, not evidence from a real mobile network. Exercise keyboard and assistive behavior explicitly if those checks are requested.

For each meaningful step, record the visible state, action, expected outcome, actual outcome, and evidence. Capture screenshots at failures and enough successful checkpoints to show the route taken. Include console or network evidence where it explains a technical error. Stop rather than bypassing an authentication or authorization boundary.

Use a compact finding record:

```json
{
  "id": "F-01",
  "viewpoint": "literal-reader",
  "step": "Choose a workspace",
  "action": "Select Create",
  "expected": "A workspace name form appears",
  "actual": "An unlabeled spinner remains",
  "classification": "observed failure",
  "evidence": ["F-01.png", "F-01-network.txt"],
  "reproduction": ["Open the entry page", "Select Create"]
}
```

All example content is synthetic. A subjective reaction belongs under `hypothesis`; do not manufacture an observed error to justify it.

## Consolidate and verify

Merge findings that share a demonstrated cause while preserving every contributing viewpoint and its evidence. Keep distinct causes separate even if they occur on one screen. Rank by user impact first, then frequency across these runs and position in the journey. A reproducible task blocker can outrank a widely shared cosmetic opinion.

Use impact labels: `blocks outcome`, `recoverable failure`, `confusing but usable`, and `cosmetic`. Reproduce blockers and repeated findings in a fresh context. Downgrade an unreproduced finding to an unresolved observation or hypothesis; retain it with the attempted reproduction rather than silently dropping it.

If fixes are authorized, make the smallest changes that address the verified causes and preserve unrelated design decisions. If this is an audit, stop at findings. Rerun the same conditions and affected journeys after changes. Classify each item as `resolved`, `still present`, `regressed`, or `not retested`, with before/after evidence.

## Deliver

Return the build and scope, first-success definition, viewpoint-by-step coverage table, prioritized findings, authorized changes, and rerun results. Separate technical failures from predicted reactions. Do not present five simulated completions, timings, or satisfaction judgments as population estimates. State the real-user research still needed for behavioral claims and any branches blocked by unavailable access or authority.
