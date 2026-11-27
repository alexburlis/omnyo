---
name: fastloop
description: Verify browser changes from an Omnyo thread, inspect its evidence, and recheck the same requirements after an edit.
---

Use the registered FastLoop native tools in Omnyo. Do not submit the same request through native tools, MCP and CLI. Standalone clients remain independent.

Call `fastloop_verify` with a unique requestId, explicit URL, caller goal and non-secret requirements. Each requirement has id, text, functional/visual kind, required and caller/project_spec origin. Preserve required scope. `fastloop_run` performs bounded navigation or exploration; exploration completion does not establish a passing application requirement.

A short call returns the canonical result when available. An asynchronous handle retains runId and sessionId. One completion owner reports its terminal result. Read `fastloop_result` or the thread's FastLoop panel for canonical checks and evidence. If callback delivery is uncertain, use the accessible result; do not resubmit the browser operation.

After editing, pass the original sessionId and previousRunId plus an explicit change with changeId, changed relative files, optional source revision in baseRef and observed buildId. Source patches are optional, bounded and non-secret. The coding agent starts its dev server through the normal execution path. Do not invent build success or replacement assertion values.

Use `fastloop_cancel` for one owned run. Omnyo's Stop also cancels detached work through fresh durable interruption events. A cancellation does not undo a dispatched effect. Results remain available after browser cleanup. Idle thread leases expire after 60 seconds; an expired session requires an explicit new request rather than an authenticated replacement.

The canonical evidence UI is the thread's FastLoop panel. An assistant response may include `::fastloop-run{run="RUN_ID"}` when the provider supports message directives; tool output alone does not render a card.

Missing runtime, protected provider configuration, platform support or policy fails visibly. Never put credentials into requirements, goals, tool arguments or source patches. No tool call authorizes provider spending or external mutations beyond the user's existing scope.
