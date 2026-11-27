# Operating State Machines

## Ownership and authority

A machine is a versioned graph. An instance pins one immutable version; publishing affects future instances. Actions run only in their configured persistent environment through finite host or agent adapters. Realtime messages are refresh hints; after reconnect, read persisted status.

Effects are `local-read`, `local-edit`, `external-read` and `external-write`. Repository and Release labels grant nothing. Exact existing standing authority may satisfy a permitted effect. The plugin cannot infer that a UI, CLI or agent client is a person. Manual gates select branches; they do not grant new authority. Never introduce additional provider spend, accounts or services through a workflow.

## Commands and responses

Normal successful commands write `{ "ok": true, "value": ... }`. Domain errors write `{ "ok": false, "error": { "code", "message", "issues"? } }`, print a short message to stderr and exit nonzero. Add `--json` for machine-readable parser/local validation failures. Export success writes the canonical definition directly. Help performs no work.

| Intent                    | Command                                          | Required correlation                                                               |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| List machines             | `list`                                           | Optional project                                                                   |
| Create draft              | `create`                                         | Project, name, request ID; environment for local-check-loop                        |
| Read/edit draft           | `draft` / `import`                               | Machine; edit adds expected draft revision, document, request ID                   |
| Validate/publish          | `validate` / `publish`                           | Exact draft revision; publish adds request ID                                      |
| Inspect versions          | `versions` / `version` / `export`                | Machine and version when applicable                                                |
| Start                     | `start`                                          | Machine, version, persistent environment, context, request ID; optional home chat  |
| Inspect runs              | `instances` / `status`                           | Bounded filters or exact instance                                                  |
| Deliver event             | `signal`                                         | Exact entry/subscription/epoch/type, source/event/subject IDs, payload, request ID |
| Pause/drain/resume/stop   | `pause` / `pause-after-step` / `resume` / `stop` | Expected control revision, request ID                                              |
| Cancel step               | `cancel-step`                                    | Invocation, entry, control revision, request ID                                    |
| Acknowledge uncertainty   | `mark-unknown`                                   | Invocation, entry, control and instance revisions, reason, evidence, request ID    |
| Inspect/resolve gates     | `attention` / `resolve`                          | Resolve adds attention, entry, instance revision, decision, evidence, request ID   |
| Inspect history           | `history` / `state-history`                      | Optional exclusive `--after`, `--limit 1..100`; optional state filter              |
| Inspect ingress           | `events`                                         | Exact instance; returns current subscription windows                               |
| Read output               | `logs`                                           | Invocation, byte cursor, limit up to 32768 bytes                                   |
| Inspect execution choices | `environments`                                   | Project; does not provision                                                        |

Use one new request ID per intended mutation and stable source/event IDs for signal deduplication. Reuse IDs only with identical content. Never substitute an old entry/epoch to deliver a result into a new visit. No command has a force flag.

The Omnyo CLI materializes stdin on the invoking machine. `--<option>-stdin` supports one non-empty line up to 16 KiB and only one stdin option per invocation. Inline document/context/payload text is bounded to 262144/65536/16384 UTF-8 bytes. The shared RPC schema enforces JSON depth, node count, field shapes and safe keys. Large local inputs use `omnyo plugin rpc call --input-file` with complete method input JSON; the caller reads that file before transport. Do not pass file paths to handlers expecting JSON.

Export to a new local path. Shell redirection can overwrite files; preserve existing content. Imported `machineId` must match the target. Moving definitions between machines requires an intentional machine-ID edit before import.

## SDK and discoverability

```sh
omnyo plugin rpc list state-machines --json
omnyo plugin rpc inspect state-machines sm_instance_control --json
omnyo plugin rpc call state-machines sm_instance_control --input-file exact-control.json --json
```

SDK consumers call `sdk.plugins.callRpc({ pluginId: "state-machines", method, input, outputSchema, signal })`. Obtain the current schemas from discovery. The UI and CLI use the same methods. Consumers never import core internals or send an actor/approval claim.

## Lifecycle and recovery

Lifecycle is running, paused, stopping, stopped, completed or failed. Phase describes waiting, queued, executing, waiting to retry, needs a person or outcome unknown. The named graph state is separate. `result-ready` means a structured result was submitted; the worker must finish before advancement.

**Stopped · outcome unknown** acknowledges uncertainty while ownership remains. It does not prove a process was killed, an external write succeeded, or an effect can be retried.

1. Read persisted status and current attention items.
2. Read bounded history and invocation output. Retain IDs, timestamps and non-secret evidence.
3. Inspect the exact owned worker/process receipt. A deadline or disconnected host is not quiescence.
4. Choose only a server-listed reconciliation decision. Confirmed live work cannot be marked unknown or replaced.
5. If authority, credentials or a human-only action is missing, report the exact gate and finish independent authorized work.
6. Re-read the instance before resuming. Inspect deadlines that passed during pause and use the current returned revision.

Never clear ownership, delete journals, modify SQLite, replay a lost submit, kill unrelated processes or suppress errors to advance a graph. Commands use program/argv with no shell. Agents require an existing model and a structured result bound to their exact worker. Permissions default to Full access and can be changed in the step's Permission mode picker or through `action.permissionMode` in the draft.

## Home chats

`start` gives every run one visible home chat in the machine's project: a new chat named after the machine, or the existing chat passed as `--home-thread` (RPC `home: { kind: "thread", threadId }`; omit it or pass `{ kind: "new", title? }` for a new one). Start fails with `HOME_THREAD_INVALID` for a missing, archived, hidden or other-project chat and `HOME_THREAD_UNAVAILABLE` when a new chat can't be created; no instance starts in either case. Runs started before home chats existed keep `homeThreadId: null` and stay panel-only.

Agent steps of a run with a home chat run in visible chats nested under it, titled `<step> · try <n>`, and are not archived when the step ends; archiving the home chat archives them. Each open attention item except `agent-input` opens once as a form in the home chat. The form shows the attention item's `cause` (the step, how it ended and its reason) and its decisions with their target state titles. Submitting resolves the item through the same `resolve` path; resolving it elsewhere withdraws the form. A rejected answer reopens the form with the error.

## Expected errors

| Code                                                            | Required response                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`, `NON_YIELDING_CYCLE`, `UNSUPPORTED_SCHEMA` | Correct the reported definition/input field.                                       |
| `REVISION_CONFLICT`                                             | Reload and reconsider at the new revision.                                         |
| `STALE_ENTRY`, `STALE_SUBSCRIPTION`, `EXPIRED_RECEIPT`          | Inspect the current visit/window; never automatically replay expired intent.       |
| `EVENT_ID_CONFLICT`                                             | Inspect the original receipt; an ID was reused with different content.             |
| `NOT_FOUND`, `SCOPE_MISMATCH`                                   | Verify exact object ownership and IDs.                                             |
| `ENVIRONMENT_LIFETIME_UNSUPPORTED`                              | Select an existing persistent environment.                                         |
| `HOME_THREAD_INVALID`, `HOME_THREAD_UNAVAILABLE`                | Pass a visible, unarchived chat in the machine's project, or let start create one. |
| `CAPABILITY_UNAVAILABLE`                                        | Restore the intended capability; do not substitute another provider.               |
| `AUTHORITY_REQUIRED`                                            | Use the exact pre-existing authority or obtain the required human authorization.   |
| `INVOCATION_UNCERTAIN`, `STOP_PENDING`                          | Reconcile the owned work before replacement.                                       |
| `BACKPRESSURE`                                                  | Inspect why accepted work is not advancing before submitting more.                 |
| `OUTPUT_LIMIT`                                                  | Reduce input/page size; never present truncated output as complete evidence.       |

Read retention/checkpoint bounds from the server. Compacted history is not a full lifetime archive; unchanged observations may be coalesced. Preserve active inputs, ownership receipts and unresolved-outcome evidence. Use producer-owned cleanup. A bounded soak proves only its tested duration, cycles and interruptions.
