---
kind: instruction
title: Omnyo Guide JSON Output
summary: The --json contract for core Omnyo commands, including output shapes and the error envelope.
intent: Let agents parse Omnyo output on the first try instead of probing its shape.
editingNotes: Every shape here must match real command output. The CLI help JSON lines come from apps/cli/src/json-shapes.ts, and a CLI test fails when that file and this chapter disagree.
---
JSON output

Every core command accepts --json except the plugin authoring tools (`omnyo plugin
new`, `types`, `migrate`, `build`, `dev`, `run`, `logs`, `update`). Success
prints one JSON value on stdout and exits 0. Nothing else is written to stdout.

Errors

A failed command exits non-zero. With --json it prints this envelope on stdout
and still prints the readable message on stderr:

  {"ok": false, "error": {"code": "unknown_option", "message": "...", "hint": "..."}}

`hint` is present only when Omnyo knows the fix: the flag to add, the nearest
command or option, or the usage line. Codes for mistakes in the invocation:
unknown_command, unknown_option, missing_required, unexpected_argument,
invalid_value, missing_command. A failed server request uses the server's error
code, such as thread_not_found or terminal_output_unavailable; otherwise the
code is http_<status> or error.

Parse stdout only. `2>&1` mixes the readable message into the JSON, and
`2>/dev/null` hides it. Check the exit code, or test `.ok == false`, before
reading fields.

Shapes

List commands do not share one wrapper. Most print a bare array; a few wrap it.
Fields beyond those shown exist; these are the ones scripts use.

  omnyo status --json
    {project: {id, name} | null, thread: {id, status, title, pinnedAt, shelvedAt, parentThreadId, environment: {hostId, display} | null} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir}

  omnyo thread list --json
    [{id, projectId, environmentId, providerId, title, status, parentThreadId, sectionId, groupId, visibility, archivedAt, pinnedAt, shelvedAt, createdAt, updatedAt, activity}]    (bare array; title can be null)

  shelvedAt is the shelf time in epoch milliseconds, or null when the thread is
  not shelved. Archived threads always report null.

  omnyo thread show <id> --json
    {thread: {id, status, title, projectId, environmentId, parentThreadId, ...}, environment: {id, hostId, path, branchName, ...} | null, pendingTodos}    (thread fields are under .thread)

  omnyo thread log <id> --json
    [{id, seq, type, createdAt, threadId, scope, data}]    (bare array of event envelopes with redacted or withheld text, oldest first; page with --after-seq <seq>); with --message: {message, before, after} of conversation rows

  omnyo thread log <id> --format conversation [--limit <1-100>] [--after-seq <seq>] [--through-seq <maxSeq>]
    {rows: [{seq, role, text}], hasMore, nextAfterSeq, maxSeq}    (ascending messages; preserve maxSeq on subsequent pages; --all holds the snapshot)

  History exports mask environment values and redact supported credential text.
  Raw JSON keeps its event array shape.

  omnyo thread output <id> --json
    {output}

  omnyo thread spawn ... --json
    the created thread: {id, status, title, projectId, environmentId, ...}

  omnyo thread tell <id> ... --json
    {threadId, ...delivery outcome}

  omnyo thread wait <id> --json
    {threadId, matched: true, target}

  omnyo thread count --json
    {total}

  omnyo thread search <query> --json
    {active: {total, results}, archived: {total, results}}

  omnyo inbox --json
    {revision, generatedAt, inbox: [entry], waiting: [entry], running: [entry], shelf: [entry], counts: {inbox, needsYou, questions, running, waiting, onYou, nextBackAt}, lastMove: {moveId, kind, threadId, at} | null}    (entry: {threadId, projectId, title, shelved, automationId, view, state, reason: {kind, text, threadId}, recap, archiveReady, optionalQuestion, pendingResults, card, waiting, running, sortAt, latch}; lists keep the app's order)

  omnyo inbox act <thread-id> <action> --json, omnyo inbox undo [<move-id>] --json
    {moveId: string | null, entry: entry | null}

  omnyo wait [<thread-id>] --key <key> --for "..." ... --json
    {threadId, wait: {id, key, generation, kind, status, forText, marker, deadline, nextCheckAt, checkCount, createdBy, ownerAccepted, conditions: [{key, kind, label, met}]}, existing}

  omnyo wait list [<thread-id>] --json
    {threadId, waits: [wait]}    (open waits only)

  omnyo wait rearm|met|done|cancel <wait-id> --json
    {threadId, wait, proposed}    (proposed: an agent's cancel of a wait the owner created or accepted became a proposal)

  omnyo wait sources --json
    {sources: [{family, owner, label, keyFormat, examples, approval, kind, everyMs, pendingKeys, health: {state, lastCheckAt, lastOkAt, lastError, consecutiveFailures, proof}}]}

  omnyo wait check <key> --json
    {key, family, valid, error, describe, kind, approval, fired, result}    (fired: null when no check ran)

  omnyo prompt-history list --json
    {entries: [{id, createdAt, input, projectId, threadId, scope}], nextCursor: string | null}

  omnyo preview register ... --json
    {id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}    (private launch recipe omitted)

  omnyo preview show <id> --json
    {id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}    (private launch recipe omitted)

  omnyo preview list --thread <id> --json
    {previews: [{id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}]}    (wrapped in .previews)

  omnyo preview status <id> --json
    {state, checkedAt, detail, runId}

  omnyo preview restart <id> --json
    {state, checkedAt, detail, runId}

  omnyo preview remove <id> --json
    {ok: true}

  Status can be online, stopped, starting, host-offline, conflict, error or
  unknown. Restart exits 0 only when online; otherwise it returns the error
  envelope with code preview_not_ready. Neither operation exposes the launch
  recipe or environment values.

  omnyo thread section list --json
    [{id, name, createdAt, updatedAt}]

  omnyo thread group list --json
    [{id, projectId, name, createdAt, updatedAt}]    (bare array)

  omnyo thread group create <threadIds...> --json
    {group: {id, projectId, name, createdAt, updatedAt}, threadIds}

  omnyo thread queue list <id> --json, omnyo thread interactions list <id> --json, omnyo thread history <id> --json
    bare arrays

  omnyo project list --json
    [{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path, isDefault}]}]    (bare array)

  omnyo project show <id> --json
    {id, kind, name, gitRemoteUrl, sources}

  omnyo machine housekeeping <id-or-name> --json
    {status: not-run | failed | complete, checkedAt?, memoryPressure?, idleGraceMs?, reapedSessions?, retainedSessions?: [{threadId, environmentId, providerId, processId, reason, idleForMs, memory}]}    (failed checks have unknown retained sessions; RSS is per process, not per hosted session)

  omnyo machine list --json
    [{id, name, type, status, lifecycle, maxPermissionMode, lastSeenAt, runtimeVersion}]    (bare array)
    runtimeVersion: the connected daemon's runtime version, null when disconnected or unreported, absent from older coordinators

  omnyo provider list --json
    [{id, displayName, available, capabilities, reasoningLevels, serviceTiers}]    (bare array)

  omnyo provider models [providerId] --json
    [{id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, supportedServiceTiers?, isDefault}]    (bare array)

  omnyo environment list --json
    [{id, name, projectId, hostId, path, branchName, status, lifecycle}]    (bare array)

  omnyo environment show <id> --json
    {id, name, projectId, hostId, path, branchName, baseBranch, status, lifecycle}

  omnyo terminal list --thread <id> --json
    {sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}    (wrapped in .sessions)

  omnyo terminal output <terminalId> --json
    {chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}    (chunk data is base64; status is "exited" once the command has finished)

  omnyo terminal wait <terminalId> ... --json
    {terminalId, matched, nextSeq, exitCode}

  omnyo plugin list --json
    {plugins: [{id, version, enabled, status, source, rootDir}]}    (wrapped in .plugins)

  omnyo skill list --json
    {skills: [{id, name, description, scope, provider, filePath}]}    (wrapped in .skills)

  omnyo explore [<type>/<slug>] --json
    {items: [item]}    (with a <type>/<slug> key: {item}; item: {kind, slug, title, summary, publisher, tags, path, preview, cta, url}; url is absolute)

  omnyo explore skills [--query <text>] --json
    {items: [{slug, title, category, publisher, license, keywords, sourceUrl, source, revision, sha256, summary?, detailPath}]}
    (source is github or omnyo; detailPath is site-relative; no installation occurs)

  omnyo explore marketplace [--type skill|workflow|connector] [--query <text>] [--category <category>] [--publisher <publisher>] --json
    {items: [{kind, slug, title, summary?, publisher, category, keywords, detailPath, ...}]}
    (skill adds source, sourceUrl, revision, sha256, license; workflow adds sha256, requirements; connector adds pluginId, service, requirements, availability)
    (detailPath is site-relative; browsing installs nothing)

  omnyo marketplace list --json
    bare array

  omnyo settings show --json
    one object keyed by settings area (generalSettings, serverAccess, keybindings, experiments, appearance, ...)

  omnyo guide commands [group] --json
    {chapter, commands: [{path, aliases, arguments, options, description}]}

Commands contributed by plugins document their own JSON in `omnyo <command> --help`
and the plugin's skill.
