# Sentry investigations inside Omnyo

Turn an actionable Sentry issue into a visible local investigation in the correct project.
A solver on the model you pick sets a goal, traces the root cause, reproduces it, repairs the
isolated source, has the change reviewed in a separate chat and submits its evidence. Required
checks run before an explicitly enabled draft PR is published.

- Opt-in watched projects, a current open-issue inbox and an icon count with freshness.
- Manual solvers by default; optional per-project auto solve with a configurable 10/day UTC cap.
- Model pickers for Solve, Solve all and Review, saved as defaults (GPT-6.1 Sol unless changed).
- Warm visits retain the last complete inbox while refreshing within the current session.
- Project-wide Solve all with explicit subagents and related-issue packages.
- Compact project setup discovers existing Sentry projects and local repositories.
- Exact project, machine, repository and branch routing, including umbrella projects.
- One isolated package worker at a time, with durable ownership and restart reconciliation.
- Local commits by default; deliberate per-route draft PR publication.
- Optional merge of a reviewed PR after required CI checks pass (off by default).
- Issue triage after solving: resolved in the next release, resolved, archived until escalating, or a logging correction for expected conditions.
- Existing Omnyo completion notifications with a concise result and evidence links.

No deployment, release or paid Sentry AI is included. Merging happens only with its setting on.

State Machines maintenance can own each configured issue through proven diagnosis, independent review, traceable PR merge, the smallest required update and runtime verification. A repository whose pull requests get no GitHub checks merges on the run's own verification and approved review. Unproven issues stay open with a recorded reason. Signed issue webhooks trigger intake, with a one-minute reconciliation scan. Each run gets a "Sentry fix · ISSUE" chat with its step chats nested under it. When a step stops, that chat asks whether to retry the step or keep the issue open, and shows the step's error.
