---
name: database-scale-test
description: Build bounded synthetic database workloads that test real query correctness, latency, and reliability as data and concurrency grow.
license: MIT
---

# Database Scale Test

Measure how an application's real database queries behave as data size, relationship density, and concurrency change. Use disposable synthetic data and explicit correctness checks. A result describes the tested environment and workload, not production capacity in general.

## Define the workload before running it

Inspect the schema, migrations, query entry points, and expected user operations. Map each selected query to its parameters, authorization boundary, result contract, ordering, pagination, and joins. Exercise the production query function or SQL through a small adapter; do not benchmark a simplified replacement.

Record database and runtime versions, relevant settings, source revision, hardware, storage, connection pool, cache state, and concurrent machine activity. Select the smallest workload that can answer the task. Define time, disk, memory, concurrency, and row-count limits before allocation. Use only an explicitly owned disposable target and refuse an unexpected path or server identity.

Separate these dimensions:

- Population: more independent accounts or top-level entities.
- Fan-out: more children per parent, including dense relationships.
- Distribution: empty entities, typical entities, hot entities, and selective filters.
- Concurrency: simultaneous operations and the relevant read/write mix.

Do not call a test “10× scale” without stating which dimension changed. Keep other dimensions fixed when diagnosing one cause.

## Generate coherent synthetic data

Seed deterministic generators from an explicit seed and use the real migrations. Generate parent rows before children, valid references, meaningful timestamps, and values that exercise application predicates. Cover empty results, ties, page boundaries, deleted/archived records, and tenant isolation where relevant.

Verify counts, foreign-key integrity, expected selectivity, and known query results before timing. Derive expected results independently from the generated fixture definition; copying the query's filtering logic into its oracle can repeat the same bug. A query returning no rows quickly is not evidence that the intended workload is fast.

A portable adapter contract can be implemented in the project's language:

```text
createOwnedDatabase(target, runId)
applyMigrations(database)
seed(database, seed, scale) -> fixtureFacts
verifyFixtures(database, fixtureFacts)
executeOperation(database, operation, parameters) -> result
assertResult(result, fixtureFacts, operation)
dropOwnedDatabase(database, runId)
```

The cleanup operation must verify ownership again. Do not disable authorization or replace query semantics to make the adapter easier to build.

## Run bounded measurements

Keep migration, seeding, integrity checks, warmup, and measured operations separate. Record monotonic elapsed time for each attempt with operation, scale, parameters or parameter class, outcome, and rows returned. Count errors, timeouts, cancellations, retries, and incomplete attempts explicitly.

State whether load is closed-loop, where clients wait for results, or arrival-driven. Record offered rate, achieved throughput, active concurrency, and pool waits. A saturated load generator can conceal database capacity; inspect its CPU and I/O as well as the database's.

Use the same parameter distribution and fixture seed for before/after comparisons. Alternate baseline and candidate runs when cache or machine drift matters. Preserve raw samples and declare how many independent runs contribute to each summary. Do not replace a timeout with an exact latency equal to its deadline.

Stop at the stated resource or time bound. After two equivalent failures, investigate the smallest causal hypothesis instead of launching the same large run again. Preserve a compact failure record and stop only the owned producer.

## Diagnose and verify a change

Locate the first failing scale or distribution. Inspect the actual query plan, cardinality estimates, scan/join work, lock waits, and index usage. Explain why the observed plan produces the measured failure before changing SQL or indexes.

If a fix is authorized, preserve result semantics, permissions, ordering, and pagination. Measure index size and write cost where an added index changes them. Rerun correctness and the affected scale cells with unchanged comparison conditions. A faster query returning the wrong rows fails.

Report medians and tail quantiles with sample counts; use uncertainty intervals when the sample supports them. Distinguish `improved`, `regressed`, `no detectable difference`, and `inconclusive`. Failure to detect a difference does not prove equivalence.

## Deliver and clean up

Provide a query-by-scale table or heatmap showing latency and failure rate, with unmeasured cells distinct from zero. Link raw samples, fixture seed, commands, environment, correctness checks, and query plans. State the measured capacity boundary and untested dimensions.

Stop owned processes, remove only verified disposable data, and confirm cleanup. Retain compact evidence and explain any target kept for an active investigation. Never clean shared databases, caches, or another run's output as part of this workflow.
