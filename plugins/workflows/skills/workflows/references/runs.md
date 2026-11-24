# Workflow run lifecycle

## Running and resuming

`omnyo_workflow_run` and `omnyo workflows validate` accept exactly one source mode:

- `script`: inline JavaScript.
- `scriptPath`: a relative path or an absolute path confined to the workflow
  origin environment's workspace.
- `name`: a lowercase kebab-case name resolved as
  `.omnyo/workflows/<name>.js` in the current project workspace.

The existing `source` field remains a supported alias for inline `script`, but
do not provide both. File and name resolution happens through the origin
environment's `hostId` and workspace root. Traversal, outside absolute/UNC
paths, missing workspace roots, non-UTF-8 files, and sources over 512 KiB are
rejected. QuickJS receives source text only; it never gets filesystem access.
Plugin-bundled workflow discovery is not supported.

`omnyo_workflow_run` also accepts optional JSON `args` and optional `resumeRunId`.
It returns a durable run ID immediately. Use the compact `omnyo workflows status`
summary, paged `omnyo workflows history`, `omnyo workflows list`, and
`omnyo workflows stop` afterward. Completion is sent back as an agent-only input:
it steers an active origin immediately or starts a turn when the origin is idle,
without rendering a user-facing message. Delivery is duplicate-tolerant
at-least-once because `threads.send` has no idempotency key. CLI status polling
remains authoritative.

`list` also returns compact summaries; it is safe for discovery but is not a
substitute for the redirected detailed history.

Detailed history can contain every prompt, critique, result, and call record,
so never print it directly into the agent transcript. Materialize one bounded
JSONL page on the execution host, then use normal file-navigation tools:

```bash
run=<run-id>
mkdir -p "$OMNYO_THREAD_STORAGE/workflows"
omnyo workflows history "$run" --cursor 0 --limit 100 \
  > "$OMNYO_THREAD_STORAGE/workflows/$run.jsonl"
jq -c 'select(.type == "page")' "$OMNYO_THREAD_STORAGE/workflows/$run.jsonl"
```

The last `page` record supplies `nextCursor`; fetch that cursor and append the
next page. Pages are snapshots, so rewrite from cursor `0` to refresh an active
run. Redirection is performed by your shell, which places the file in the
correct local or remote thread storage without giving the plugin arbitrary
host filesystem access.

To resume after a pause, stop, restart, or script edit, relaunch with the same
current source and `resumeRunId`. Resume requires a terminal prior run in the
same project and environment workspace and always creates a new run. The
longest unchanged prefix of successful `agent()` calls returns cached results;
the first edited or new call and everything after it runs live. The cache key
includes call order, prompt, resolved provider/model/reasoning/permission,
output schema, and worker protocol semantics. Display-only phase, label, and
title changes do not invalidate it.

Parallel calls receive cache identities in deterministic invocation order, so
concurrency alone does not stop replay. Successful calls that edited files or
performed other writes are cached too: resume is restricted to the same
environment workspace, where their side effects remain. Failed, cancelled,
incomplete, and null-result calls are not reusable; the first such call and the
entire suffix run live. Legacy runs without replay-safety metadata replay
nothing. A plugin restart applies the same longest-prefix rule.

When a worker's turn fails, the Provider Retry plugin decides whether to retry
it, exactly as for any other chat. The retry continues the same worker, so
overloads back off, rate limits wait for their reset, and the call keeps its
progress. The call fails with the worker's error once no retry is queued, about
35 seconds after the failure or after the last retry. The run's total timeout
still applies while a retry waits. Failing to start a worker, for example a
temporary network or server error, retries twice with bounded backoff; that
count is persisted and visible in workflow history.

The CLI equivalents are:

```bash
omnyo workflows validate --script '<javascript>'
omnyo workflows validate --file .omnyo/workflows/review-change.js
omnyo workflows validate --name review-change
omnyo workflows run --script '<javascript>' --args '<json>'
omnyo workflows run --file .omnyo/workflows/review-change.js --resume <run-id>
omnyo workflows run --name review-change
omnyo workflows status <run-id>
omnyo workflows history <run-id> --cursor 0 --limit 100
omnyo workflows list --limit 20
omnyo workflows stop <run-id>
omnyo provider list --environment "$OMNYO_ENVIRONMENT_ID" --json
omnyo provider models <provider-id> --environment "$OMNYO_ENVIRONMENT_ID" --json
```

The CLI's `--file` maps to the agent tool's `scriptPath`, but a relative CLI
path starts at the invoking CLI's current directory. Both that directory and
the resolved file must remain inside the origin workspace. `--source` remains
an inline alias for `--script`. Run and validate require exactly one of
`--script`, `--file`, or `--name` (counting `--source` as `--script`).

`omnyo workflows --help` and `omnyo workflows <command> --help` print the arguments,
option limits, and rules for a command and exit 0. Command output is JSON;
adding `--json` also reports a failure as `{"ok":false,"error":{…}}` on stdout,
alongside the readable message on stderr.

Workflow worker threads use hidden visibility and are plugin-attributed. They
stay out of sidebar organization without contributing unread/pending favicon
attention. Ordinary search, prompt history,
lifecycle, and direct operations remain available. Workers are root threads,
so no parent notification applies; a hidden thread that does have a parent
still reports its turns and blockers to it. Workflows does not create a
temporary Workflow folder.

`maxActiveRuns` is live plugin-global dispatch policy. Shared parent/child agent
concurrency and call count, total run timeout, retention, and UTF-8
completion-message size are snapshotted per run. `status` is bounded
to compact progress and call counts. Paged JSONL `history` carries ordered
call-level execution, cache, child-thread, repair, result, and error details.

Workers are hidden and owned by the workflow plugin across every retry attempt.
Finished, replaced, cancelled, and unattached workers are stopped and archived
by maintenance without waiting for history retention. Cleanup retries across
restarts and survives history expiry. Archiving or deleting an origin cancels
its outstanding workflows and retires its owned workers while preserving
retained history. Completion notification becomes `abandoned` for an archived
or deleted origin; unrelated send conflicts and transient failures retry.
Upgrades recover existing call references; older attempts already missing from
those references require a separate historical audit.
