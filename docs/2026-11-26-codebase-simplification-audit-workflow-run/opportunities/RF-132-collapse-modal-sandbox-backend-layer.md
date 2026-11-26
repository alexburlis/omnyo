# RF-132 — Replace the generic `SandboxBackend<Inputs, Resource>` extension point in the Modal plugin with a Modal-typed registration

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low. The change removes one speculative layer: a generic interface, five generic context types, a definition record and three parse or key indirections. All of it is inside one experimental plugin. About 45 to 70 handwritten production lines go away, which is fewer than the sweep's estimate of 60 to 100.
- **Confidence:** high that the layer has exactly one implementation and no consumer outside the plugin. Medium on the line estimate, because the Modal-typed lifecycle contexts that replace the generic ones still need some lines.
- **Readiness:** decision-needed. `plugins/environment-modal-sandbox/providers/README.md` documents the layer as a deliberate extension point for further sandbox vendors. Only Alex can say whether a second vendor, such as E2B, Daytona or Cua, is planned for the near term, or whether forks should get a ready-made vendor seam.
- **Effort:** small, about two to four hours including the moved test.
- **Risk:** low. The layer is plugin-internal, the plugin package is `private: true` with no `exports`, and the change preserves the persisted resource format and the registered provider ids.
- **Prerequisites:** the owner decision in the investigation gate (step 0).
- **Related or overlapping opportunities:** none in this audit. RF-003 also deals with backend registration, but it covers the production plugin API and the SDK fake host, not this plugin.
- **Why it deserves its place:** it is a clean example of a single-implementation abstraction whose own caller already reaches past it. The gain is small, so it belongs near the bottom of the index. Execute it only if the owner confirms that no second vendor is planned.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The audit's read-only worktree for that snapshot no longer existed when this card was written. All reads used `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` and `git grep <pattern> e9e1b74c3b... -- <scope>`.

What the subsystem does: the optional, experimental "Modal Sandbox" plugin (`plugins/environment-modal-sandbox`, whose manifest name is `Modal Sandbox [Experimental]`) registers a machine provider and a composed environment (Modal machine plus `project-checkout`) through the plugin SDK. Core owns daemon bootstrap and the durable lifecycle. The plugin owns Modal allocation, snapshots, cleanup and idle pausing.

Observed facts (Proven by inspection):

- `plugins/environment-modal-sandbox/providers/sandbox-backend.ts:1-80` defines `SandboxOperationContext`, `SandboxCheckpointContext<Resource>`, `SandboxCreateContext<Inputs, Resource>`, `SandboxLifecycleContext<Resource>`, `SandboxResourceContext<Resource>`, `SandboxBackendDefinition<Inputs>` and `SandboxBackend<Inputs, Resource>`. That is 80 lines, 73 of them non-blank (`git show ... | wc -l` and `grep -cv '^\s*$'`).
- `plugins/environment-modal-sandbox/providers/register.ts:6` `registerSandboxBackend<Inputs, Resource>` (133 lines, 117 non-blank) translates the interface into `api.experimental_environments.register` (lines 31-38) and `api.experimental_machines.register` (lines 40-132). The translation is real and must survive. It times `api.experimental_machines.bootstrap` and logs `"<runtimeName> daemon connected in N ms"`, runs `throwIfAborted` checks, calls `onConnected(hostId)` after create and resume, and maps errors to `{ status: "failed", message }` for create, reconcileCleanup and remove. Suspend and resume deliberately propagate errors.
- `plugins/environment-modal-sandbox/providers/modal/backend.ts:56` `ModalSandboxBackend extends SandboxBackend<ModalMachineInputs, ModalMachineResource>` adds three Modal-only members: `connectionStatus`, `debugContext` and `inspect`. `createModalSandboxBackend` (line 126) is the only production implementation. Its `definition` block (lines 227-237) and `parseInputs`, `parseResource` and `allocationKey` (lines 238-244) exist only to feed the generic adapter. `allocationKey` returns `resource.key`.
- `plugins/environment-modal-sandbox/server.ts` already treats the backend as Modal-specific. It calls `backend.debugContext()` (lines 59 and 136), `backend.inspect(...)` (line 67) and `backend.connectionStatus()` (line 74), and it reads `resource.sandboxId`, `accountIdentity` and `appName` (lines 196-205). It routes `backend.definition.id` (lines 89, 104, 144 and 190), which always equals `PROVIDER_ID` from `provider-id.ts`, through the generic definition, and line 112 runs `backend.allocationKey(backend.parseResource(resource))`.
- Consumers. `git grep -n -E 'sandbox-backend|registerSandboxBackend|SandboxBackend|providers/register|Sandbox(Lifecycle|Operation|Resource|Create|Checkpoint)Context' e9e1b74c3b... -- .` matches only files inside `plugins/environment-modal-sandbox`: `backend.ts`, `register.ts`, `register.test.ts`, `sandbox-backend.ts`, `server.ts` and `providers/README.md`. The package `plugins/environment-modal-sandbox/package.json` is `private: true`, has no `exports` field, and its manifest points only at `./server.ts` and `./app.tsx`. Outside the plugin, the files that mention `environment-modal-sandbox` (the builtin registry, `scripts/forkable-plugins.json`, `plugins/omnyo-official.json`, `turbo.json`, app fixtures, `packages/plugin-build/src/builtin-server-artifacts.test.ts:84` and the ratchet test fixture) refer to the plugin directory or the provider id, not to these files or symbols.
- No other sandbox vendor exists. The snapshot has no other machine-provider sandbox plugin (`git ls-tree --name-only e9e1b74c3b... plugins/` lists only `environment-git-worktree`, `-modal-sandbox`, `-personal-workspace`, `-project-checkout` and `-temporary-copy`). `git grep -i -E 'e2b|daytona|another backend|second vendor' e9e1b74c3b... -- docs plugins/environment-modal-sandbox` finds only the README's "To add another backend". The prior audit `docs/2026-11-25-material-simplification-audit.md` does not mention this layer.
- History. The layer arrived with upstream bb PR #3274, "Machine providers: durable lifecycle and shared plugin APIs", as commit `b3c5434da8` (2026-09-11) in the retired private store. The commit message says the Modal vendor code "now lives under `providers/modal/`, with a shared adapter for machine lifecycle registration". No second implementation has been added in the 2.5 months since.
- Unique test obligations in `plugins/environment-modal-sandbox/providers/register.test.ts` (102 lines, a fake "example-sandbox" backend):
  - the composed environment registration fields (`machineProviderId`, `environmentProviderId: "project-checkout"`);
  - on create, `checkpoint` is called before `bootstrap`;
  - `onConnected` receives the bootstrapped host id.

  `server.test.ts` (2006 lines) does not reference `environmentCompositions` (no match for that string). It covers the resume ordering (lines 695-739) and shows that a failed create checkpoint prevents bootstrap (lines 533-549), but it never asserts the create-path order directly or the idle bump after connection. The other lifecycle behaviors are covered through the real plugin in `server.test.ts`. Examples are "creates once by key" (line 298), "reuses vendor allocation after bootstrap fails" (line 417), the reconcileCleanup tests (lines 551-630 and 922) and the suspend, resume and remove tests (lines 634-920).
- Core already validates inputs. `apps/server/src/services/machines/provider-orchestration.ts:478` `parseMachineProviderInputs` runs the inputs schema before `provider.validate`, so the plugin's second `parseInputs` call is defensive narrowing, not the only validation.

Maintenance cost today: changing a lifecycle signature, for example adding a Modal-only field to the resume result, means editing the generic interface, its type parameters, the adapter and the Modal implementation. The README also tells agents to keep that interface vendor-neutral for a vendor that does not exist. The definition record and the parse and key indirections add a hop to every read of the provider id or the allocation key.

Counterevidence:

- The README states a deliberate multi-vendor plan. A forker who wants a different vendor would reuse the seam.
- The interface doubles as a compact statement of the lifecycle invariants. The end state keeps that statement as README prose and tests.

**Proposed end state and preservation argument**

What disappears:

- `providers/sandbox-backend.ts`, the whole file.
- The `<Inputs, Resource>` type parameters and the `SandboxBackendDefinition` record.
- `parseInputs`, `parseResource` and `allocationKey` as backend members.
- The "To add another backend" steps in `providers/README.md` (lines 19-32) and the generic wording on lines 3-6.
- `providers/register.test.ts`, whose three unique assertions move into `server.test.ts`.

What remains:

- `providers/modal/backend.ts` `createModalSandboxBackend` keeps every lifecycle method body unchanged.
- `ModalSandboxBackend` becomes a plain, self-contained Modal interface. Its context types are Modal-typed: `checkpoint(resource: ModalMachineResource)`, `inputs: ModalMachineInputs` and `resource: ModalMachineResource`.
- The registration body moves verbatim in behavior into `providers/modal/register.ts` as `registerModalMachineProvider(api, backend, { now, onConnected })`. It has no type parameters. It uses the constants `PROVIDER_ID`, `"Modal Sandbox"`, the two descriptions, `"./modal-logo.svg"`, `ephemeral: true` and `inputs: modalMachineInputsSchema`. It calls `modalMachineInputsSchema.parse` and `readModalMachineResource` directly and reads `resource.key`.
- `server.ts` uses `PROVIDER_ID` and `readModalMachineResource(...)` directly.

Canonical owner: `providers/modal/` owns Modal allocation and its registration. The SDK machine-provider contract (`packages/plugin-sdk/src/machine-provider.ts`) stays the only generic boundary.

Preserved contracts. The changed code must produce exactly the same values as before:

- The machine provider id and the environment composition id stay `PROVIDER_ID` (`modal-sandbox`).
- The display name, both descriptions, the icon path, `ephemeral: true` and the inputs schema stay the same.
- The environment provider stays `project-checkout`.
- The bootstrap log text stays `Modal daemon connected in N ms`.
- The order of `checkpoint`, `throwIfAborted`, `bootstrap` and `onConnected` stays the same.
- Errors map to the same result statuses: create, reconcileCleanup and remove return `failed`; suspend and resume throw.
- The bootstrap key on resume stays `resource.key`.
- The persisted `ModalMachineResource` format (`providers/modal/resource.ts`) and the allocation records do not change.

UI, CLI and RPC surfaces see no change.

Why this is the simplest sufficient option: the SDK already defines the generic machine-provider contract. A second, plugin-internal generic layer with one implementation duplicates that role.

Non-goals:

- Do not change Modal lifecycle semantics, retries, idle timing or the allocation sweep.
- Do not merge `register.ts` into `server.ts`. Keeping it as a separate Modal file keeps `server.ts` focused on settings, idle timing and import.

Reachability proof: see the `git grep` command in Context, which finds no consumer outside the plugin. Remaining uncertainty: an unmerged branch or a fork could implement `SandboxBackend`. Step 0 asks about this.

**Expected gain and cost**

These figures are projections, not measurements.

- Production code: `sandbox-backend.ts` loses 80 lines. The adapter's generic noise and indirections lose about 10 lines, and `backend.ts` loses about 20 lines of `definition`, parse and key members and generic imports. In exchange, `backend.ts` gains about 25 to 35 lines of Modal-typed context types and an explicit member list for `ModalSandboxBackend`. Net: about 45 to 70 handwritten production lines removed.
- Mechanisms removed: one generic interface with two type parameters, five generic context types, one definition record and three indirection members.
- Documentation: `providers/README.md` shrinks by about 15 to 20 lines, from 64. The lifecycle invariants (lines 34-64) stay.
- Tests: deleting `register.test.ts` removes 102 lines, and about 30 to 40 lines are added to `server.test.ts`. Net: about 60 to 70 test lines removed.
- Performance: neutral, by inspection. The same calls run, with one fewer object indirection.
- Causal maintenance gain: a Modal lifecycle change touches the Modal files only, with concrete types instead of generic parameters.
- Cost: the plugin loses its ready-made seam for a second vendor. Adding one later means reintroducing an interface, ideally only when the second implementation exists.

**Execution steps**

0. **Investigation gate (owner decision, required before any edit).** Ask the owner: "Is a second sandbox vendor planned for the Omnyo Modal plugin, or should forks get a built-in vendor seam?" If the answer is yes, stop and mark RF-132 rejected. Also search the local and remote branches for other implementations of the seam: `git -C $OMNYO_CHECKOUT grep -n 'SandboxBackend' $(git -C $OMNYO_CHECKOUT for-each-ref --format='%(refname)' refs/heads refs/remotes)`. Any implementation outside `providers/modal/` invalidates this plan.
1. **Reconfirm the baseline** on the current branch head. Check that `providers/sandbox-backend.ts`, `providers/register.ts` and `providers/register.test.ts` still match the snapshot. Check that `server.ts` still calls `registerSandboxBackend` once. Rerun the consumer `git grep` from Context. If a new implementation of `SandboxBackend` exists, re-plan.
2. **Move the test obligations first (checkpoint A).** In `plugins/environment-modal-sandbox/server.test.ts`, inside `describe("Modal machine provider", ...)` (line 290), add one test that uses the existing `setup()` helper (around line 180). It must assert three things:
   - `fake.harness.registrations.environmentCompositions.get(PROVIDER_ID)` matches `{ id: PROVIDER_ID, machineProviderId: PROVIDER_ID, environmentProviderId: "project-checkout", icon: "./modal-logo.svg" }`.
   - On `provider.create(createContext())`, `context.checkpoint.mock.invocationCallOrder[0]` is less than `bootstrap.mock.invocationCallOrder[0]`.
   - After create, `api.storage.kv.get("idle/" + HOST_ID)` is a number. This shows that `onConnected` ran `bumpIdle`.

   Run the plugin tests against the unchanged code. The new test must pass before any production edit.
3. **Create `providers/modal/register.ts` (checkpoint B, a mechanical move).**
   - Copy `registerSandboxBackend` into a new function `registerModalMachineProvider(api: PluginApi, backend: ModalSandboxBackend, options: { now: () => number; onConnected: (hostId: string) => Promise<void> }): void`.
   - Replace the `definition.*` reads with literals or `PROVIDER_ID`, and replace `definition.runtimeName` with `"Modal"` in the log string.
   - Replace `backend.parseInputs(x)` with `modalMachineInputsSchema.parse(x)`.
   - Replace `backend.parseResource(x)` with `readModalMachineResource(x)`.
   - Replace `backend.allocationKey(r)` with `r.key`.
   - Keep the statement order and the try/catch boundaries exactly as they are.
4. **Make `providers/modal/backend.ts` self-contained.**
   - Remove the import from `../sandbox-backend.js`.
   - Declare Modal context types next to `ModalSandboxBackend`: `ModalOperationContext { report: PluginMachineProviderProgress; signal: AbortSignal }`, `ModalLifecycleContext` (adds `hostId`, `resource: ModalMachineResource` and `checkpoint(resource: ModalMachineResource): Promise<void>`), `ModalRemoveContext` (adds `hostId` and `resource`, without `checkpoint`), and `ModalCreateContext` (adds `key`, `attempt`, `inputs: ModalMachineInputs` and `checkpoint`).
   - Rewrite `ModalSandboxBackend` as a standalone interface. It lists `availability`, `validate`, `create`, `reconcileCleanup`, `suspend`, `resume`, `remove`, `displayName`, `close`, `connectionStatus`, `debugContext` and `inspect` with these types.
   - Delete the `definition`, `parseInputs`, `parseResource` and `allocationKey` members (lines 227-244). Keep `modalMachineInputsSchema` exported for the registration.
   - Do not touch the method bodies.
5. **Update `server.ts`.**
   - Import `registerModalMachineProvider` from `./providers/modal/register.js`, `PROVIDER_ID` from `./provider-id.js` and `readModalMachineResource` from `./providers/modal/resource.js`.
   - Replace `backend.definition.id` with `PROVIDER_ID` at lines 89, 104, 144 and 190.
   - Replace `backend.allocationKey(backend.parseResource(resource))` with `readModalMachineResource(resource).key` (line 112).
   - Replace `backend.parseResource(stored)` with `readModalMachineResource(stored)` (lines 67 and 196).
   - Replace the `registerSandboxBackend(...)` call (lines 184-187) with `registerModalMachineProvider(...)`, keeping the same position in the startup sequence.
6. **Remove the superseded machinery.** Delete `providers/sandbox-backend.ts`, `providers/register.ts` and `providers/register.test.ts`; these are clean tracked files, so name them in the report. Rewrite `providers/README.md`:
   - Replace lines 1-32 with a short layout note: `providers/modal/` holds the Modal client, image, resource, backend and registration.
   - Keep the lifecycle invariants (lines 34-64), and change "The backend must preserve" to "The Modal backend must preserve".
   - Drop "Use `register.test.ts` as the minimal non-Modal example".
7. **Verify and inspect.** Run the commands below. Then run `git diff --stat` and check that only the plugin's files changed. Recount with `wc -l` against the snapshot numbers in Context.

**Verification and acceptance criteria**

The working directory for every command is the repository root of the change worktree. Script names were read from `plugins/environment-modal-sandbox/package.json` and the root `package.json` at the snapshot. The audit snapshot had no `node_modules`, so none of these commands were run.

- `pnpm --filter omnyo-plugin-environment-modal-sandbox test`: all tests pass, including the test added in step 2, and that test passes both before and after the production edits.
- `pnpm --filter omnyo-plugin-environment-modal-sandbox typecheck`: no errors. In particular, `create` and `resume` in `backend.ts` must typecheck against the new Modal context types without casts.
- `pnpm --filter omnyo-plugin-environment-modal-sandbox lint`, and on the changed files `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings --format=agent`: clean.
- `pnpm --filter @omnyo/plugin-build test`: the `builtin-server-artifacts.test.ts` case for `environment-modal-sandbox` (line 84) still builds and inlines the plugin's server entry.
- Behavior checks that must pass without any change to their assertions: every existing `server.test.ts` lifecycle test, plus the new registration and ordering test. Do not edit the expected values of existing tests.
- Structural completion: `git grep -n -E 'SandboxBackend\b|registerSandboxBackend|sandbox-backend|SandboxBackendDefinition|parseInputs|allocationKey' -- plugins/environment-modal-sandbox` returns nothing. The README no longer describes adding a vendor. `providers/modal/register.ts` has no type parameters.
- UI: no UI file changes. A visual check is not needed.
- Performance: no measurement is needed, because the call sequence is unchanged.

**Rollback and stop conditions**

- Rollback boundary: one commit confined to `plugins/environment-modal-sandbox/`. Reverting it restores the generic layer. Rollback has no persisted-data or compatibility impact, because the resource format, provider ids and KV keys stay the same.
- Stop if The owner confirms a planned second vendor or wants the seam kept for forks.
- Stop if another implementation of `SandboxBackend` is found on any branch.
- Stop if the step 2 test cannot pass against the unchanged code. That would mean the documented ordering is not what the code does, and it needs separate diagnosis.
- Stop if any existing `server.test.ts` assertion would have to change to make the refactor pass.
- Smaller alternative if the owner wants to keep a seam: keep `SandboxBackend`, but remove only the `definition` indirection and the `allocationKey` member, and have `server.ts` use `PROVIDER_ID` directly. That saves about 15 lines and keeps the extension point.
