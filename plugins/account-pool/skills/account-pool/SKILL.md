---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through omnyo pool."
---

# Account Pooler

Use `omnyo pool` for this plugin's accounts and routes. Inspect current state with
`omnyo pool status --json` and `omnyo pool account list --json` before changing routing.
Use `omnyo pool --help` for available commands.

Codex reset credits are available through `omnyo pool account reset-credits <id> --json`
and the Account Usage sidebar. Listing is read-only. `omnyo pool account reset <id>
--confirm --request-id <uuid> [--credit-id <provider-id>]` consumes one existing
credit; use only when Alex authorizes that account action. Retry an uncertain
attempt with the same account, credit and request UUID. There is no purchase flow.

For account sign-in and re-login, secret handling, quota refresh, routing settings,

ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or the supported sign-in flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

Pooled rate-limit failures can be retried by Provider Retry using the pool’s
earliest usable account, even if the provider omits structured quota events.
Inspect `omnyo provider-retry explain <thread-id> --json` for the last decision
and `omnyo provider-retry status <thread-id> --json` for pending retries.
Composer Predictions reuses a pooled Codex subscription for every chat provider.
Read [prediction boundaries](references/composer-predictions.md) for allowance and
failure behavior.

## Throughput and observed quota windows

`omnyo pool telemetry --json` reports metadata-only measurements from the last
30 days. The same query is `experimental_telemetry.v1.report` with
`{accountId: null}` or one account identifier. Records start after installation;
older requests are not reconstructed. Only Codex requests through this pool are
collected. Requested and provider-reported tiers remain separate.

TPS is output tokens including reasoning divided by upstream request-to-terminal
time, including queueing and network overhead. First-event latency is transport
arrival, not first generated text. Quota changes are account-window observations,
not measured per-request charges. Concurrent, unfinished and mixed-tier intervals
are marked; direct traffic and delayed provider accounting remain unknown even
for a homogeneous interval. Zero change can mean below provider resolution.

No prompts, generated content or credentials are stored. Failed, canceled and
unmeasured requests remain visible. Storage retains 30 days; report caps and
collection failures are explicit in `truncated` and `collectionErrors`.
