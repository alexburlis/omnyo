# State Machines

Create workflows that cycle indefinitely while each command or agent step remains finite. SQLite stores the current state, events, timers, immutable versions and recovery receipts. Waiting does not start a model turn.

- [UI/UX design](DESIGN.md)
- [Operating reference](skills/state-machines/references/operating.md)
- [Public RPC contracts](src/contracts/rpc.ts)

Use Omnyo 0.46.24 or later with Plugin SDK 0.6.42 or later. Commands currently require a POSIX host; Windows execution returns a capability error. Choose an active, persistent project checkout. Temporary managed environments are rejected because the workflow must outlive its starting chat.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

The backend contributes `omnyo state-machines`, typed `sm_*` RPC methods, a finite worker result tool and a bounded inspect/pause/resume/stop tool. The State Machines panel provides the graph editor, live controls, attention and logs. All controls use the same service. See `omnyo state-machines --help` after installation; `omnyo plugin run state-machines` resolves command collisions.

```sh
omnyo state-machines create --project PROJECT_ID --name "Workspace checks" --template local-check-loop --environment ENVIRONMENT_ID --request-id create-checks --json
omnyo state-machines validate --machine MACHINE_ID --revision 0 --json
omnyo state-machines publish --machine MACHINE_ID --expected-revision 0 --request-id publish-checks --json
omnyo state-machines start --machine MACHINE_ID --version VERSION_ID --environment ENVIRONMENT_ID --request-id start-checks --json
omnyo state-machines status INSTANCE_ID --json
```

Every run gets a home chat in the machine's project. Its agent steps run in chats nested under it, and every gate, unknown outcome or stopped step opens there as a form that says which step stopped and why. The owner sees it in the sidebar, the Inbox and notifications, not only in this panel. Pass `--home-thread THREAD_ID` to `start` to use an existing chat instead of a new one.

`local-check-loop` reads the bound directory every five minutes. `release-loop` creates an incomplete draft modeled on the reference graph: select models, bind commands and supply actual authority before publishing or running it. Agent steps default to Full access. Choose another supported mode in the step's Permission mode picker or set `action.permissionMode` in the draft JSON. The plugin creates no provider account, credential, remote integration or paid service tier.

The release draft receives `source.new-sha` through a correlated CLI/SDK signal containing `sourceSha`. Connect an existing authorized event source; the plugin does not provision a repository webhook. Timer transitions can enter finite command states for local checks.

Publish creates an immutable version. Running instances keep their pinned version when the draft changes. Run controls require the current `controlRevision` and an idempotency `requestId`; draft edits require their expected revision. Signals require the current entry, subscription and epoch. Expired signals are rejected rather than resent.

Pause blocks new dispatch and transitions. Pause after current step drains owned work. Stop requests cancellation and remains Stopping until the exact process or worker is quiescent. A structured agent result is provisional until the worker ends. An ambiguous submission is never retried automatically; its ownership remains visible for reconciliation.

Effect labels describe intended scope; they are not an operating-system sandbox or proof of approval. Omnyo clients cannot prove human identity through the current plugin connection. The plugin cannot create new outward-effect grants and refuses `external-write` actions. A release template does not authorize builds, merges, publication or spending.

The dispatcher uses one plugin-owned SQLite database and finite host jobs. Closing the panel does not stop a run. Nothing executes while Omnyo or the plugin is unloaded; stored deadlines and subscriptions are reconciled on load. A finite soak verifies recovery for its measured window and cannot prove literal perpetual availability.

Build and reload this plugin through Omnyo's supported plugin route; changing it requires no core or native-app release.
