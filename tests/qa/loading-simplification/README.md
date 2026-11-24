# Demand loading measurement

These scripts compare the real app loader before and after removing automatic
warming. They use fresh headless Chrome contexts, an HTTP server with immutable
asset caching, and complete static dependency closures. They do not intercept
browser requests. Byte counts are uncompressed HTTP response bodies, not wire
traffic. Timings measure this machine and workload, not physical iPhone behavior.

Use an existing Playwright installation. Run from the repository root with Node
22 or newer. Keep generated files in task scratch. Bound each command to 60
seconds and run one browser workload at a time.

1. Freeze the baseline app build and the original `define-split.tsx`,
   `split-prefetch.ts`, and `web-asset-prefetch.ts` before editing.
2. Run `node tests/qa/loading-simplification/build.mjs BEFORE BASELINE_SOURCE`
   and `node tests/qa/loading-simplification/build.mjs AFTER`. Each output records
   loader source hashes and emitted asset hashes.
3. Run `node tests/qa/loading-simplification/run.mjs PLAYWRIGHT BEFORE AFTER
RECORDS healthy 0 2`. Repeat for starts 2/count 2 and 4/count 1. Run the same
   three batches for `slow`, which adds 100 ms to each JavaScript response.
   Eight optional modules are available. The idle window is 750 ms; then the
   first feature is requested. The first-open cost includes pointer intent.
4. Run `measure.mjs PLAYWRIGHT BUILD RESULT SCENARIO` for `transient`,
   `transient-dependency`, `permanent`, and `hung`. The first two reject two
   requests; permanent rejects all requests until Try again; hung sends headers
   but stalls the body. The hung observation ends after 33.5 seconds. A timeout
   without an error screen is a censored failure, not a fast load. Every case
   checks that the synthetic draft survives.
5. Run `version-warming.mjs PLAYWRIGHT BASELINE_WEB_ASSET_PREFETCH RESULT`.
   Five alternating pairs measure two 50 KB future-version assets with 100 ms
   response delay. This isolates the removed working-set prefetcher. It reports
   saved speculative traffic and the cost of requesting the next version cold.
6. Run `run-app.mjs PLAYWRIGHT BEFORE_DIST AFTER_DIST RECORDS THREAD_PATH
READY_TEXT START COUNT [production]`, in batches of at most two pairs. This serves frozen
   static builds against the same existing loopback coordinator and checks a
   known message. Use a read-only thread. It records static requests for three
   seconds after the chat becomes visible. Backend data, browser caches and
   relay latency are not held constant by this check. The optional `production`
   argument sends the server's `Vary: Origin` header. Use it for realistic
   pre-download/import cache separation; omit it to isolate an ideal shared
   browser cache. Keep these profiles separate in reports.
7. Run `summarize.mjs RECORDS RESULT` for medians, ranges and failed-trial checks.
   Keep full-app records and fixture records together to combine the summary.

The existing `tests/qa/asset-loading/proof.mjs` independently checks retained
assets, cached module failure, Reload and synthetic draft restoration against
real server routes. Run it after loader edits. Unit tests cover stalled headers
and bodies without waiting 32 seconds each.

Remove generated builds, browser profiles and task scratch after preserving
compact JSON evidence. The scripts close their browser and loopback server.
