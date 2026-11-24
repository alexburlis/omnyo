# CLI, Guide, And Skill

Keep the discoverable surfaces in sync whenever you add or change an `omnyo` CLI command, flag, or a user-facing configuration knob (env var, `.omnyo/` workspace file, settings field):

- Update the in-CLI guide templates under `packages/templates/src/templates/omnyo-guide-*.md`, turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- For core commands, update the omnyo-cli skill at `plugins/omnyo-guide/skills/omnyo-cli/SKILL.md` or its relevant reference. For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Keep plugin-specific behavior out of the core CLI skill. Configuration knobs also belong in `docs/configuration.md`.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

Environment lifecycle hooks are core policy: Omnyo runs `.omnyo-env-setup.sh` after
an environment provider creates an owned path, and `.omnyo-env-teardown.sh` before
provider removal. Each has a 15-minute timeout; setup failure fails provisioning,
while reported teardown script failure does not block removal. Transport failure
keeps cleanup pending until the daemon confirms hook termination. When a daemon
restart leaves the outcome unknown, automatic cleanup stops until the owner
inspects the workspace and runs `omnyo environment cleanup <id> --hook-stopped`.
Hook identity and completion persist across server restarts. Attached checkout and
personal-workspace paths skip both hooks. These semantics apply equally to CLI,
SDK, and app launches; see [worktrees.md](worktrees.md).
The finite V1 reader accepts an existing `.bb-env-setup.sh` or
`.bb-env-teardown.sh` only when its canonical counterpart is absent. Dual
hook files refuse before execution. The reader preserves user files and modes.

The Machines settings creation drawer prepares an existing-machine command when access is ready, otherwise shows setup guidance. After access is ready, Choose a machine provider reviews provider inputs and launches through `hosts.experimental_create`/`omnyo machine create`. A machine belongs to no project; projects reach it later through project sources.

`omnyo machine list` enumerates persistent machines and takes `--all` to include
disposable provider sandboxes, matching the app's Show all machines reveal.
`omnyo updates` and `omnyo skill install-cli-skills` default to persistent machines
and still accept a sandbox through an explicit `--machine`.

Machine maintenance state is part of `omnyo machine list --json`; there is no
separate machine lifecycle command. Keep the machine guide and omnyo-cli command
index aligned with this surface.

`omnyo machine rtk-status MACHINE --json` checks the agent PATH on the selected
machine. It returns `{"installed":true}` when the executable is available.

Local installed-daemon start, stop, and uninstall operations are flags on
`install-machine.sh`, not `omnyo machine` subcommands. `install-machine.sh --adopt` installs the
service for an already-enrolled data directory and backs
`omnyo server install-machine-service`.

Modal connection and machine commands are documented in [modal-sandboxes](../plugins/environment-modal-sandbox/skills/modal-sandboxes/SKILL.md). `omnyo modal image show [--json]` reads the Dockerfile shown in settings; `omnyo modal image set --file PATH [--json]` saves a validated plugin-wide override and `omnyo modal image reset [--json]` restores the bundled default for future machines; `omnyo modal account inspect --json` checks credentials; `omnyo machine create --provider modal-sandbox --json` automatically prepares the bundled image and installs the daemon. `omnyo machine remove MACHINE --yes` explicitly removes compute and private snapshots.

`omnyo thread spawn --machine-inputs <json>` configures either an explicit
`--new-machine` or the machine provider owned by a composed
`--environment-provider`; a composition rejects separate machine selectors.

Modal image debugging uses `omnyo modal image build`, `omnyo modal sandbox run`, `omnyo modal sandbox exec ID [--json] -- COMMAND...`, and `omnyo modal sandbox stop ID`. Debug compute expires after 30 minutes and skips Omnyo enrollment and project setup. See the plugin skill for output limits and typed RPC equivalents.

The desktop `public-beta` build channel and its preparation limits are documented in [the public macOS app](../apps/desktop/README.md#public-macos-app). The channel is a build-time input, not a runtime setting.

Portable workflow packages use the `omnyo automation workflow` command group; existing
finite script runs remain under `omnyo workflows`. Review a local file with
`cat reviewed.omnyoworkflow | omnyo automation workflow inspect --text-stdin --json`, or
inspect an official link with `omnyo automation workflow inspect --share-id ID --json`.
`import --project ID --review ID --digest SHA256 --request ID` saves one disabled
copy. Reuse the request ID when retrying. `list`, `bind`, `preview`, `confirm`,
`enable`, `run`, and `export` call the same validated workflow service as the UI.
`bind COPY --project ID --revision N --bindings-stdin` accepts recipient bindings
as JSON with `hostId`, `providerId`, `model`, and `inputs`. Run
`omnyo automation workflow options --host ID --json` to list that host’s
connected coding models. Use the returned provider ID (`codex` or
`claude-code`) and model when binding the copy.
`confirm COPY --project ID --revision N --digest SHA256` confirms the executable
content and current bindings; schedule enablement is a separate command.
`export-automation --project ID --automation ID --prompt-stdin` requires an
explicit sanitized prompt for an agent automation. `share` and `manage` return
the first-party relay dashboard URL; they do not transport account credentials,
upload files, or open a browser window. The current plugin CLI context has no
browser-open capability. Upload and revocation finish in the signed-in dashboard.

`inspect --template weekly-content-feed` reviews the fictional starter without
invoking a model. `artifacts COPY --project ID --run ID` reads the immutable
manifest and its files once the corresponding graph run completes.
