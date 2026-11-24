export const JSON_SHAPE_BY_COMMAND_PATH: Readonly<Record<string, string>> = {
  status:
    "{project: {id, name} | null, thread: {id, status, title, pinnedAt, shelvedAt, parentThreadId, environment: {hostId, display} | null} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir}",
  "thread list":
    "[{id, projectId, environmentId, providerId, title, status, parentThreadId, sectionId, groupId, visibility, archivedAt, pinnedAt, shelvedAt, createdAt, updatedAt, activity}]    (bare array; title can be null)",
  "thread group list":
    "[{id, projectId, name, createdAt, updatedAt}]    (bare array)",
  "thread group create":
    "{group: {id, projectId, name, createdAt, updatedAt}, threadIds}",
  "thread show":
    "{thread: {id, status, title, projectId, environmentId, parentThreadId, ...}, environment: {id, hostId, path, branchName, ...} | null, pendingTodos}    (thread fields are under .thread)",
  "thread log":
    "[{id, seq, type, createdAt, threadId, scope, data}]    (bare array of event envelopes with redacted or withheld text, oldest first; page with --after-seq <seq>); with --message: {message, before, after} of conversation rows",
  "thread output": "{output}",
  "thread spawn":
    "the created thread: {id, status, title, projectId, environmentId, ...}",
  "thread wait": "{threadId, matched: true, target}",
  "thread search": "{active: {total, results}, archived: {total, results}}",
  inbox:
    "{revision, generatedAt, inbox: [entry], waiting: [entry], running: [entry], shelf: [entry], counts: {inbox, needsYou, questions, running, waiting, onYou, nextBackAt}, lastMove: {moveId, kind, threadId, at} | null}    (entry: {threadId, projectId, title, shelved, automationId, view, state, reason: {kind, text, threadId}, recap, archiveReady, optionalQuestion, pendingResults, card, waiting, running, sortAt, latch}; lists keep the app's order)",
  "inbox act": "{moveId: string | null, entry: entry | null}",
  wait: "{threadId, wait: {id, key, generation, kind, status, forText, marker, deadline, nextCheckAt, checkCount, createdBy, ownerAccepted, conditions: [{key, kind, label, met}]}, existing}",
  "wait list": "{threadId, waits: [wait]}    (open waits only)",
  "prompt-history list":
    "{entries: [{id, createdAt, input, projectId, threadId, scope}], nextCursor: string | null}",
  "project list":
    "[{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path, isDefault}]}]    (bare array)",
  "machine housekeeping":
    "{status: not-run | failed | complete, checkedAt?, memoryPressure?, idleGraceMs?, reapedSessions?, retainedSessions?: [{threadId, environmentId, providerId, processId, reason, idleForMs, memory}]}    (failed checks have unknown retained sessions; RSS is per process, not per hosted session)",
  "machine list":
    "[{id, name, type, status, lifecycle, maxPermissionMode, lastSeenAt, runtimeVersion}]    (bare array)",
  "provider list":
    "[{id, displayName, available, capabilities, reasoningLevels, serviceTiers}]    (bare array)",
  "provider models":
    "[{id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, supportedServiceTiers?, isDefault}]    (bare array)",
  "environment list":
    "[{id, name, projectId, hostId, path, branchName, status, lifecycle}]    (bare array)",
  "environment show":
    "{id, name, projectId, hostId, path, branchName, baseBranch, status, lifecycle}",
  "terminal list":
    "{sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}    (wrapped in .sessions)",
  "terminal output":
    '{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}    (chunk data is base64; status is "exited" once the command has finished)',
  "terminal wait": "{terminalId, matched, nextSeq, exitCode}",
  "preview register":
    "{id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}    (private launch recipe omitted)",
  "preview show":
    "{id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}    (private launch recipe omitted)",
  "preview list":
    "{previews: [{id, projectId, threadId, environmentId, hostId, url, remoteUrl, createdAt}]}    (wrapped in .previews)",
  "preview status": "{state, checkedAt, detail, runId}",
  "preview restart": "{state, checkedAt, detail, runId}",
  "preview remove": "{ok: true}",
  "plugin list":
    "{plugins: [{id, version, enabled, status, source, rootDir}]}    (wrapped in .plugins)",
  explore:
    "{items: [item]}    (with a <type>/<slug> key: {item}; item: {kind, slug, title, summary, publisher, tags, path, preview, cta, url}; url is absolute)",
  "skill list":
    "{skills: [{id, name, description, scope, provider, filePath}]}    (wrapped in .skills)",
};

export function jsonShapeHelp(commandPath: string): string | null {
  const shape = JSON_SHAPE_BY_COMMAND_PATH[commandPath];

  return shape === undefined
    ? null
    : `\nJSON (--json): ${shape}\nErrors with --json: {"ok": false, "error": {code, message, hint?}} on stdout. Run \`omnyo guide json\` for every shape.`;
}
