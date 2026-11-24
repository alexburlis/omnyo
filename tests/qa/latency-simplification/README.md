# Latency comparison

`measure.mjs` opens the same existing chat through frozen production UI files
and the existing loopback coordinator. It measures visible chat readiness,
WebSocket opening, routing to another existing chat and back, and the first Settings opening. Settings is ready when the General
section's Show Git status switch is visible. It never changes a setting or
submits a message.

Each run uses a fresh desktop Chrome context. Chat switching uses the browser
history event consumed by the router, so it does not depend on a changing sidebar
list or measure pointer targeting. Static files use their existing
Brotli/gzip files when accepted. The `before` profile reproduces the old
`Vary: Origin` static response; `after` uses origin-independent immutable asset
headers. The proxy preserves ordinary application read RPCs. Any non-RPC POST
other than the file-list and thread-metadata read routes is blocked and fails the
measurement. Normal navigation may perform the application's existing implicit
view/notification bookkeeping; the harness does not invoke it separately.

Pass an existing Playwright module, frozen build directories, a scratch reports
directory and a scenario JSON containing `threadPath`, `threadId`, `readyText`,
`switchPath` and `switchThreadId`. Use known markers without storing conversation
content. Run from the repository root:

```sh
node tests/qa/latency-simplification/run.mjs PLAYWRIGHT BEFORE AFTER REPORTS SCENARIO 0 1
node tests/qa/latency-simplification/run.mjs PLAYWRIGHT BEFORE AFTER REPORTS SCENARIO 1 1
node tests/qa/latency-simplification/run.mjs PLAYWRIGHT BEFORE AFTER REPORTS SCENARIO 2 1
node tests/qa/latency-simplification/run.mjs PLAYWRIGHT BEFORE AFTER REPORTS SCENARIO 3 1
node tests/qa/latency-simplification/run.mjs PLAYWRIGHT BEFORE AFTER REPORTS SCENARIO 4 1
node tests/qa/latency-simplification/summarize.mjs REPORTS SUMMARY
```

Each pair alternates baseline and candidate, and normally completes in under
30 seconds. Keep one browser owner and the repository's 60-second command
limit. Per-child timeout is 55 seconds; if exceeded, investigate the failed run
before another pair. The harness closes the browser, sockets and loopback
server. Final JSON records cleanup and failures.

Encoded response-body bytes are compressed body bytes sent by the static
server, excluding protocol headers. Decoded response-body bytes are original
file lengths. These are not total network-wire bytes. Cached requests absent
from the server are not counted. Request timings include the local proxy and
live backend; backend activity and system load can vary. Optional plugin HTTP
failures are listed per run and do not silently become success. Core HTTP or
browser failures, blocked mutation attempts, and missing visible content fail
the run. The measurement does not cover physical phones, relay transit, or
provider time-to-first-token.
