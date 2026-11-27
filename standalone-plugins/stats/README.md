# Stats

Stats records local Omnyo agent and token analytics in `~/.omnyo/plugins/stats/data.db`. Collection continues while the plugin is enabled, independently of the dashboard. Captured totals survive chat archive/deletion.

## Dashboard

Open **Stats** in Omnyo navigation. Global cards show reported agents, five-minute recorded output throughput, lifetime output, and lifetime input. Overview charts show concurrency and total throughput over time; the throughput selector also shows pooled estimated model speed for the selected filters; drill down by machine, project, chat, provider, model, thinking effort, requested service mode, account, chat control, or execution role. Model speed compares pooled estimated turn throughput and recent medians. Coverage shows collector, backfill and storage health. CSV/JSON exports contain the displayed bounded report/page.

The dashboard reserves card, chart, table and control geometry while loading and refreshing. Real Chrome measured zero Stats layout shift for Overview, Model speed and Coverage at 1360 px and 384 px, including initial load, realtime updates, range changes and full reloads. The updating-status text is removed.

Stats retains Omnyo's primary stylesheet for the frontend generation and waits inside the panel before rendering the dashboard. Delayed CSS does not show an unstyled page or block unrelated host UI. CSS failure surfaces through Omnyo's panel error boundary; no duplicate stylesheet, extra request or polling is added.

## Agent control and execution roles

**Chat control** describes who owns the Omnyo chat lifecycle. **Execution role** describes the measured execution scope inside that chat. Provider-native subagents can execute inside a main chat, so these two views remain separate. Agent lifecycle ownership classifies subagent chats; independent chats and user forks without an agent owner remain main. A sidebar parent alone does not prove control: ambiguous chats receive one bounded creation-author check. Missing provenance stays Unknown; failed checks remain visible and can be retried with Refresh. Existing mixed main/native history retains Unknown execution role instead of being replayed or guessed.

The dashboard's execution fabric shows six independent distributions for the selected range: model, provider, machine, thinking level, chat control and execution role. Each distribution covers the complete filtered range, with five named groups and an explicit Other remainder. The branches show separate shares; they do not claim a correlated model-to-machine topology. Click a named group to filter, or open its breakdown. Live counts are current and token shares cover the selected historical range.

## Metric definitions

- Five-minute throughput sums output counter deltas with timestamps in `(now−300 seconds, now]`, then divides by exactly 300. Idle seconds count. Providers may report usage only after a call finishes, so this is recorded throughput rather than decoder streaming speed.
- Output already contains provider-counted reasoning. Reasoning is a subset, never added again.
- Provider `totalTokens` is preserved. Codex includes cache within input; Claude reports uncached input and adds cache to its provider total. Input and cache columns are raw provider fields, not a universally additive billing formula.
- Codex can forward independent native-agent cumulative counters under the parent's normalized session ID. Stats keeps a durable numeric baseline per stream and a durable turn-to-stream identity. A native parent tool ID identifies a child stream; client input acceptance with retained request metadata identifies the main stream. Unlinked turns remain separate uncertain streams. Native execution model, effort and mode remain Unknown when their metadata is unavailable.
- Claude's translator emits one cumulative usage ledger per Omnyo chat, including across nested scopes. Stats uses that shared ledger. Optional cache fields disappearing never reset unrelated input, output or total counters.
- Running agents count active Omnyo chats, including hidden and child chats, plus Omnyo-reported native background agents. Provider-internal agents without an Omnyo count/counter remain outside measurable coverage.
- Supplementary native task tokens, tool uses and duration are retained separately because native usage can overlap parent counters. They are never added to canonical token totals.
- Model speed is output divided by turn duration excluding the union of recorded foreground tool and interaction waits. Each historical model-speed point pools measured output/model time within that bucket; no measured time produces an unavailable gap. Incomplete counters/timing, inherited baselines and model fallback exclude estimated speed. Modes record Omnyo's requested service tier, including Normal, Fast and Ultrafast; thinking effort is separate.
- Lifetime totals cover captured available usage. Pre-install chat deletion, disabled periods followed by source deletion, core history pruning, inherited first counters and provider omissions cannot be reconstructed. Missing initial cumulative baselines use the supplied last-call counters and are marked uncertain.
- Account Pooler's read-only roster is displayed. Its current API exposes no request/usage-to-account mapping. Tokens remain in **Unknown**; current/last-used accounts are never guessed.
- Concurrency averages use recorded agent-time divided by covered wall time. Global peak is recorded separately; filtered cohort peaks cannot be added. Collection gaps render as gaps. UTC bucket boundaries are displayed in local time.

## Retention and efficiency

Lifetime cohort totals, daily summaries, numeric stream baselines and turn-to-stream identities are permanent. Minute buckets and individual speed samples remain for 30 days; exact timestamp usage observations and concurrency coverage intervals remain for 24 hours. Older detail is compacted without subtracting lifetime/day counters. Chat and stream identities necessarily grow with new work; this plugin bounds dense detail rather than promising a fixed-size lifetime database.

Collection reads selected metric events in at most 100-row pages, coalesces notices, yields between pages, and commits counters plus the durable cursor in one SQLite transaction. One worker serializes writes. Live lifecycle integration uses 15-second active ticks; idle collection performs no repeated history scans. Queries use SQL aggregation, at most 100 breakdown rows and 600 chart points. SQLite WAL and busy timeout are host managed; maintenance uses bounded deletion and passive checkpoints, with no foreground vacuum. Prompt, reply, tool-body, environment and credential content are discarded.

The local real-SQLite benchmark stored 100,000 stream baselines, 100,000 turn scopes, 110,000 observations and 100,003 minute rows in 22.29 MB. With all six new facets included, P95 measurements were 4.32 ms per 100-observation transaction, 0.80 ms per 100 ledger writes, 54.45 ms for monthly reports and 281.48 ms for lifetime reports across 10,020 chats. These are measurements on one Mac, not portable performance guarantees. Recent detail expires; permanent summaries, identities and compact counter ledgers grow with recorded work.

Week, month and year comparisons start at a UTC day boundary to use compact daily summaries. The last-five-minute headline uses exact timestamps. Coverage reports collector uptime separately from available historical token data.

## CLI

    omnyo stats summary --json
    omnyo stats report --range week --group machine --json
    omnyo stats report --range all --group chat --limit 50 --offset 0
    omnyo stats report --group mode --filter model=gpt-6.1-sol
    omnyo stats report --group chatRole
    omnyo stats report --group agentRole --filter chatRole=main
    omnyo stats health --json
    omnyo stats refresh

Refresh queues reconciliation from saved cursors; it does not erase history. Disabling the plugin stops capture. Its database is independent of thread storage; back up the plugin database with Omnyo stopped or a SQLite-consistent backup.

## Development

Use pnpm. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`. The tests use the official SDK harness with real SQLite; browser acceptance uses installed headless Chrome and `OMNYO_TEST_URL`. In the provider sandbox pnpm's store verification can require `--config.verifyDepsBeforeRun=false` when running already-installed dependencies inside the provider sandbox.

The numeric-only source diagnostic reads the supported local Omnyo history API:

    node scripts/audit-source.mjs <thread-id> <receipt-path> <loopback-origin>

It caps each run at 10,000 selected events, records whether history ended, and writes no transcript bodies. This diagnostic establishes the stream separation needed for accounting; they do not reconcile provider billing or establish complete history coverage. Source contracts are in Omnyo's Codex `delta-translation.ts`, provider bridge `delta-assembler.ts`, and Claude `delta-translation.ts`/`sdk-extraction.ts`.

The public SDK is a production dependency because the shared RPC contract imports it at runtime. Development tools can be pruned after verification; production-only installation has been checked with the same rendered dashboard bundle.
