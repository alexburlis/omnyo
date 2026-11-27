# FastLoop for Omnyo

The adapter binds a FastLoop request to the current Omnyo thread, project, environment, execution host, checkout and policy. The standalone FastLoop runtime owns browser sessions, models, checks and results.

Routing, pinned runtime transfer, thread-owned lifecycle, native tool/CLI registrations, terminal outbox and UI routes are implemented. The authored planner fixture does not qualify natural-language planning or a real provider session; those and rendered UI delivery retain separate acceptance gates.

## Context and ownership

`routing.ts` reads `threads.get`, `projects.get`, `environments.get` and `hosts.get` through the current plugin SDK. `Environment.path` is the checkout candidate. The selected host's `inspectWorkspace` RPC must return a canonical directory, verified workspace containment and identity, platform, architecture and policy hash. The server never resolves a host path locally. `environments.paths` is unnecessary when the selected environment already supplies its path.

`inspectWorkspace` is this plugin's declared host method, not a built-in SDK method. The owning host entry implements its filesystem and policy checks before service admission. The existing typed `hosts.experimental_client` transports it; no core API addition is needed.

Native tools construct `Caller.kind = native_tool` from the framework's trusted `PluginAgentToolContext`. Caller-supplied thread/project/host overrides are ignored. A run or session owned by another native-tool thread is rejected before a runtime method executes.

Owner CLI/UI callers select a thread for runs. Bootstrap doctor/setup/status may select an explicit project and environment without creating a thread or dispatching a model. Inherited and explicit CLI selectors must agree. A selected context must match the stored run and session binding. These owner selectors are usability and context checks, not protection from another process controlled by the same OS user. The caller kind is constructed by the server registration, never accepted from a tool's JSON arguments.

Reuse requires the original thread, project, environment, host, canonical root, workspace identity, platform and policy. A different worktree in the same repository is a different binding. Missing environment/path, wrong project, disconnected host, workspace escape, unsupported platform, changed host, changed policy and changed worktree have distinct routing errors. Qualified platform/architecture pairs come from the runtime owner; there is no guessed default host or platform.

## Inline requirements

The SDK CLI declaration registers `--requirements-json` with `stdin: true`. The existing Omnyo CLI proxy reads `--requirements-json-stdin` on the invoking machine and forwards one compact JSON line, capped at 16 KiB. The adapter validates the requirement schema, duplicate IDs and required scope before submission.

The invoking shell produces the line itself:

```sh
jq -c . /local/requirements.json | omnyo fastloop verify --thread THREAD_ID --request-id UNIQUE_ID --url http://localhost:4173 --goal "Verify the requested change" --requirements-json-stdin
```

The adapter never receives a file path to open. Requirement content is non-secret. Provider secrets belong to the standalone runtime's protected configuration.

## Source verification

The package started from the `omnyo plugin new fastloop` scaffold with SDK `0.6.42`; its example UI and todo server were removed. SDK-declared type peers remain development dependencies; the adapter has no browser, provider or run-database dependency.

Run each bounded check from this directory:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm test -- tests/routing.test.ts
pnpm run verify:source
```

`verify:source` checks the current canonical Omnyo source contracts and installed SDK, then runs the focused checks within a 14-second command budget. An optional positional path selects an Omnyo source checkout for this read-only verification only. It never selects an execution host or workspace.

The adapter target is Node 22.19+ and ES2022.

## Runtime package validation source

`runtime.lock.json` pins candidate `0.1.0` with package SHA-256 `003b98988499c84d0a25f56294c609c28ef8ae794354406bb92cf70069a2fbec`, manifest, compatibility, protocol and separate native archive hashes. It is a qualified private candidate, not a public release.

`package-payload.ts` validates the pinned archive, manifest, file hashes, compatibility and protocol identity, declared dependencies and separately pinned native archive. It bounds compressed and expanded data, rejects unsafe tar paths and link layouts, disallows lifecycle hooks and accepts only declared package files. It never executes archive code.

Run the focused parser tests with:

```sh
pnpm test -- tests/package-payload.test.ts
```

Preparation uses:

```sh
pnpm runtime:prepare -- --package ABSOLUTE_TARBALL --sha256 EXPECTED_DIGEST
```

Preparation requires Node 22.19 or newer for native erasable TypeScript tooling. The worker stays compatible with Node 22. It reads the manifest-declared native archive beside the package, verifies both archives before writing, and atomically emits only verified bytes and metadata into ignored `generated/runtime-payload.ts`. Missing or mismatched pins fail visibly. Preparation does not install or start anything, download Node or Chromium, or alter Omnyo's runtime.

`pnpm build` checks the prepared archive against the committed lock before using the supported `omnyo plugin build .`. Missing or stale generated data fails. Only the host bundle embeds the opaque JavaScript archive; the coordinator imports small qualified-platform metadata. Native executable bytes are excluded.

The host materializes into digest-addressed plugin data storage, verifies files and links on warm use, and refuses corruption. Setup requires an absolute Node 24 executable and proves its SQLite capability. It does not download Node, Chrome or binaries. Optional native setup requires an explicit trusted binary path matching the manifest digest and explicit license paths on the selected host.

```sh
omnyo fastloop setup --project PROJECT_ID --environment ENVIRONMENT_ID --node /absolute/node24
omnyo fastloop doctor --project PROJECT_ID --environment ENVIRONMENT_ID
```

A doctor with `--probe-service` explicitly starts and closes an ephemeral standalone public SDK coordinator and verifies its owned data-root cleanup. Normal doctor does not start a coordinator. Neither path calls a provider or launches a browser.

Focused `tests/runtime.test.ts` proves Node 22 materialization, explicit Node 24 resolution, warm verification, missing-native reporting and corruption refusal. It requires an installed Node 24 under the local NVM toolchain.

## Thread lifecycle and commands

`fastloop_run`, `fastloop_verify`, `fastloop_result` and `fastloop_cancel` use the framework's trusted thread context. Their strict request schemas project the standalone wire contract; the engine still owns validation, planning, execution, verification and verdicts. The registered skill chooses native tools as the normal Omnyo path. Standalone CLI/MCP remain independent.

Plugin CLI replies are JSON by default. Plugin commands do not accept `--json`; core Omnyo and standalone FastLoop commands have separate option contracts.

The CLI exposes `run`, `verify`, `result`, `events`, `cancel`, `doctor` and explicit `setup`. Use `--request-id` for a stable explicit retry. `verify` takes bounded inline requirements, optional original `--session` and `--previous-run`, and explicit `--change-json`. A recheck preserves check meanings and expected values. `run --mode navigate|explore` requires an explicit URL and goal. Neither completed exploration nor a completed job implies a passing requirement. Final exit codes are 0 for a passed completed objective, 1 for failed, 2 for blocked/inconclusive and 130 for cancelled; an accepted asynchronous handle exits 0.

The host uses the public SDK with an opaque client ID derived from the immutable thread/workspace binding. All thread clients connect to the same canonical-project coordinator. Read-only admission lookup recovers an unknown reply without invoking submit. Explicit scope disposal cancels and closes only that thread's owned work; ordinary observer close remains separate. The public SDK verifies the exact runtime JavaScript digest, so a new package cannot silently attach an older runtime with the same version string.

Before admission the server installs lifecycle listeners and persists its thread-event cursor and ownership intent. Fresh `manual-stop` events, archive/delete, plugin disposal and host loss reach the scoped lifecycle. Historical interruptions and ordinary idle do not cancel a later run. Worker retention survives short RPC settlement. Active work retains its worker; completed idle leases have a 60-second cap matching the current standalone session window. UI reads do not extend that window.

A terminal outbox stores only compact producer-owned result summaries, delivery receipts and per-run Stop fences. A synchronous result creates no extra agent message. Uncertain sends reconcile exact receipts and are never blindly resent. The canonical panel keeps the result accessible and shows uncertain delivery.

## Focused checks

Focused checks include:

```sh
pnpm test -- tests/routing.test.ts tests/cli.test.ts tests/host-lifecycle.test.ts tests/session-ownership.test.ts tests/bridge.test.ts
pnpm test -- tests/package-payload.test.ts tests/runtime.test.ts
pnpm test -- tests/completion.test.ts tests/app.test.tsx
```

The E2E producer in `tests/e2e/lifecycle-fixture.mjs` imports sealed package internals only as an explicit test seam. Production adapter files never import the engine's private modules. `tests/e2e/detached-stop.mjs` drives the actual source CLI, waits for fixture effects, issues public Stop and checks the canonical result. Its before-save and after-submit scenarios preserve their distinct claims. Native-provider and rendered UI acceptance belong to the remaining integration gates.

## Persistent evidence

New host leases choose `<hostDataDir>/projects/<SHA256(canonicalRoot)>` as the explicit standalone data root. The host lease ledger persists that descriptor and known run IDs independently of the checkout. Threads retain separate SDK client IDs. Standalone clients without an explicit data root discover the same existing binding; an explicit conflicting root is refused.

Existing leases without a storage descriptor keep SDK discovery for reads while their checkout exists. New admission on these legacy leases returns `DATA_ROOT_CONFLICT`; the adapter never migrates existing journals. Legacy archive reads without a known descriptor return `ARCHIVE_STORAGE_DESCRIPTOR_REQUIRED`.

After the original checkout is removed, result and artifact reads validate the current trusted thread, project, environment and connected host against the saved binding. The host independently confirms the canonical checkout is absent, validates the known run in its lease ledger, and opens the public read-only archive. The archive requires stopped producers and a checkpointed journal. It cannot start a coordinator, browser, admission or provider. Live-workspace reads keep the normal SDK path; arbitrary SDK errors never trigger archive fallback. The pinned runtime includes the public archive API.

## Acceptance evidence

`pnpm acceptance -- omnyo-core /absolute/index.json` runs bounded offline boundary tests and validates a supplied native repair evidence index. The index has `schema: 1`, SHA-256 `{path, sha256}` references named `brokenResult`, `repairedResult`, `brokenRegistry`, `repairedRegistry` and `nativeEvents`, plus `checkArtifacts` references with `runId` and `evidenceId`. Paths are absolute. Required state artifacts must match the canonical evidence hash, session and build generation. The validator requires FAILED then PASSED with immutable checks in the same session, fresh repair evidence, matching native handles and exactly one accepted completion per detached handle. It never dispatches a provider.

Without that evidence, the command returns BLOCKED with exit code 2 even when offline tests pass. `omnyo-full` also retains an explicit block for the remaining complete native flow matrix; a passing unit suite cannot satisfy those gates.
