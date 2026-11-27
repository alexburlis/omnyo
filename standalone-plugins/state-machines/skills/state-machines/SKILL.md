---
name: state-machines
description: "Create, validate and operate durable cyclic State Machines workflows with exact revisions, finite steps and explicit recovery. Use for workflow graphs, event subscriptions, pause/stop controls and outcome reconciliation."
---

# State Machines

Use the installed plugin for workflows whose graph can cycle indefinitely while each action remains finite. Definitions and run history persist in plugin SQLite storage. Repeating actions still require explicit transitions, admission, deadlines and effect authority. No finite test proves literal perpetual execution.

Read [the operating reference](references/operating.md) before changing or recovering a run. The UI, CLI, SDK and tools share one policy implementation. Never edit SQLite rows, process journals or packaged files to bypass controls.

## Inspect before acting

```sh
omnyo state-machines --help
omnyo state-machines list --project PROJECT_ID --json
omnyo state-machines instances --machine MACHINE_ID --json
omnyo state-machines status INSTANCE_ID --json
omnyo state-machines attention --instance INSTANCE_ID --json
omnyo state-machines events INSTANCE_ID --json
```

Use actual IDs from returned data. Read the exact version, entry, subscription epoch and revisions immediately before a mutation. Use a new request ID per intended mutation; reuse it only for an identical retry after a lost response. A stale revision means reload and reconsider. Never force or silently retry with a newer revision.

## Author without running

```sh
omnyo state-machines create --name "Local checks" --project PROJECT_ID --template local-check-loop --environment ENVIRONMENT_ID --request-id REQUEST_ID --json
omnyo state-machines draft --machine MACHINE_ID --json
omnyo state-machines import --machine MACHINE_ID --expected-revision REVISION --request-id REQUEST_ID --document-stdin --json < compact-definition.json
omnyo state-machines validate --machine MACHINE_ID --revision REVISION --json
omnyo state-machines publish --machine MACHINE_ID --expected-revision REVISION --note "Verified check loop" --request-id REQUEST_ID --json
omnyo state-machines export --machine MACHINE_ID --version VERSION_ID > new-definition.json
```

`blank` and `release-loop` are also available. A release template is a draft, not permission to publish a product. Choose an existing model for each agent step. Permissions default to Full access (`full`) and can be changed per step. Do not introduce provider spend, accounts or services under workflow authority.

`--document-stdin`, `--context-stdin` and `--payload-stdin` use the invoking Omnyo CLI's supported one-line transport: one non-empty line, at most **16 KiB**. Compact JSON first. Inline document/context/payload limits are **256 KiB / 64 KiB / 16 KiB**. For larger local JSON use `omnyo plugin rpc call state-machines METHOD --input-file PATH --json` with the full method input; inspect its schema first. The coordinator never reads invoking-machine paths. Export writes canonical definition JSON without a success envelope, suitable for local shell redirection. Preserve existing output files.

## Operate exact runs

```sh
omnyo state-machines start --machine MACHINE_ID --version VERSION_ID --environment ENVIRONMENT_ID --context-stdin --request-id REQUEST_ID --json < compact-context.json
omnyo state-machines pause INSTANCE_ID --expected-revision CONTROL_REVISION --request-id REQUEST_ID --json
omnyo state-machines pause-after-step INSTANCE_ID --expected-revision CONTROL_REVISION --request-id REQUEST_ID --json
omnyo state-machines resume INSTANCE_ID --expected-revision CONTROL_REVISION --request-id REQUEST_ID --json
omnyo state-machines stop INSTANCE_ID --expected-revision CONTROL_REVISION --request-id REQUEST_ID --json
```

Every run has a **home chat** in the machine's project. `start` creates one named after the machine unless `--home-thread THREAD_ID` names an existing visible chat in that project. Agent steps run in visible chats nested under the home chat and stay there until the home chat is archived. Each gate, unknown outcome or stopped step opens as a form in the home chat, so it reaches the owner's Inbox and notifications; the panel and `attention` list the same item, and answering anywhere resolves it. A gate shows the step that stopped, how it ended and its reason. Never answer a home-chat form on the owner's behalf.

`--expected-revision` on run controls is **controlRevision**, not the instance's general revision. Pause blocks new dispatch and transitions; active work remains owned. Pause-after-step drains current owned work. Stop requests cancellation and can remain **stopping** while a worker or process remains live. A submitted result, idle notification, disconnected host or elapsed deadline does not prove quiescence.

```sh
omnyo state-machines signal INSTANCE_ID --entry ENTRY_ID --subscription SUBSCRIPTION_ID --epoch EPOCH --source SOURCE_ID --event-id EVENT_ID --subject SUBJECT_ID --type EVENT_TYPE --payload-stdin --request-id REQUEST_ID --json < compact-payload.json
```

A signal targets the exact current window and declared type. Client signals and decisions prove neither human identity nor outward-effect authority. Use only server-listed decisions and exact existing standing authority. `AUTHORITY_REQUIRED` cannot be repaired by inventing approval fields, changing effect labels or granting authority through an agent tool.

## Recover without replaying effects

Read `status`, `attention`, `history`, `state-history` and `logs` before retrying. Unknown outcomes retain ownership and block conflicting restarts. Never resubmit an external action because its response was lost.

`cancel-step` requires the exact invocation, entry and control revision. `mark-unknown` also requires the instance revision, reason and evidence. It is restricted to a stopping step that is not confirmed live and acknowledges uncertainty without releasing ownership. `resolve` requires current attention/entry IDs, instance revision, a server-listed decision and required evidence. Reconciliation must establish the exact worker's outcome and quiescence.

Use `omnyo state-machines COMMAND --help` for current options. Fallback for a command collision: `omnyo plugin run state-machines COMMAND ...`.
