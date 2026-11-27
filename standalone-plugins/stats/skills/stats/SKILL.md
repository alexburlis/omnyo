---
name: stats
description: Inspect durable local Omnyo agents, token totals, throughput, model speed and collection health.
---

# Stats

Use `omnyo stats summary --json` for global current agents, recorded output throughput over exactly five minutes and lifetime counters. Use `omnyo stats report --range hour|day|week|month|year|all --group machine|project|chat|provider|model|effort|mode|account|chatRole|agentRole --json` for a bounded breakdown; add `--filter dimension=value`, `--limit 1..100` and `--offset N` to drill/paginate. `omnyo stats health --json` reports source coverage and database health. `omnyo stats refresh` queues cursor-based reconciliation.

`chatRole` separates Main chats, Subagent chats and Unknown using retained public Omnyo evidence. Lifecycle-owned chats are subagent chats. A fork without lifecycle ownership remains a main chat, even with a sidebar parent. Independent chats are main chats. Parent assignment alone is editable and does not establish agent control. An unresolved child gets one bounded first-request read: only an original spawn/thread-start with an agent initiator and sender establishes subagent control; a user initiator establishes a main chat. Generic agent messages do not. The probe result is retained across reload/refresh without replaying history; a later original spawn event can resolve an initially empty history. Missing evidence remains Unknown after deletion. Probe failures stay visible in health, while token collection continues; explicit Refresh retries failed probes.

`agentRole` separates Main executions, Subagent executions and Unknown. Positive provider parent links identify native subagent usage. An accepted root turn uses its chat role; unmatched streams remain Unknown. Older cohorts mixed root and native usage, so migration preserves their execution role as Unknown and leaves all token totals unchanged. Native task totals remain supplementary and are never added twice. Report facets cover the entire filtered range, independently of table paging, with five groups plus an explicit Other remainder; their active counts are current.

Output includes reasoning. Preserve reported provider totalTokens; cache/input semantics differ. Recorded TPS uses counter timestamps, not decoder timings. Running agents include active Omnyo chats plus reported native background agents. Lifetime history survives chat deletion, but missing source data cannot be recovered. Account Pooler currently provides a roster without exact usage attribution; Unknown means unavailable, never infer from its current account.
