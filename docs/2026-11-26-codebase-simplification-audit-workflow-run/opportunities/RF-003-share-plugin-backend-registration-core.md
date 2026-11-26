# RF-003 — Give backend plugin registration policy one owner shared by the production plugin API and the SDK fake plugin host

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and the two copies have already drifted, but the sweep reports overstated the shareable scope. Several namespaces they listed are already thin wrappers over shared `host-policy.ts` normalizers, or they sit on host-specific backing stores (HTTP, RPC, background, CLI, settings, storage, secrets and host clients). Merging those namespaces would produce a switch-heavy helper and save little. Production staging (`createStagedRegistrations`) has no counterpart in the fake, so it stays in the server. The fake's missing activation phase cannot be fixed by refactoring alone: a fix changes the public test-harness contract and needs an owner decision (see ISS items in the summary).
- **Potential:** medium. One owner replaces two hand-synchronised copies of seven registration policies: thread event subscription and filters, the hook registry, agent configuration, instructions and tools, the three provider env/health/model-notice contributions, environment providers and compositions, machine providers, and `onInstall`. Three invocation validators also get one owner. Projected net reduction: 150–250 handwritten production lines, almost all of it from the shipped fake.
- **Confidence:** medium-high. The duplicated bodies and their drift are Proven by inspection. The line savings are a projection.
- **Readiness:** ready for the scoped slices below. Aligning the fake's activation gate for host calls is excluded and needs a decision.
- **Effort:** medium, about 1.5–3 focused days in four independently shippable slices, including a parity test.
- **Risk:** medium. Every backend plugin load goes through this code, and about 129 in-repo test files use `createFakePluginHost` (80 more in `omnyo-plugins`). The realistic regressions are an error raised at a different point or with a different message, a cross-plugin "taken" check skipped or applied to the fake, and record objects that are no longer the same `Map`/array instances `plugin-service.ts` reads.
- **Prerequisites:** none. The one-line fix ISS "fake `experimental_hooks.on` skips the liveness check" should land first, as its own commit, so the refactor itself does not change behaviour.
- **Related and overlapping items:**
  - RF-031 ("Derive plugin service factory contexts from the runtime type") and RF-120 ("Define the provider-retry availability contract once in the plugin SDK") also touch the plugin server/SDK boundary, but not these namespaces. There is no shared saving to double-count.
  - RF-041 ("Execute the scheduled SDK next-major removal batch") may delete `experimental_*` namespaces this card moves. Land RF-041's deletions first if both are scheduled together, so no slice moves code that is about to go.
  - The sweep also flagged `packages/plugin-sdk/src/testing/host.ts` vs `apps/host-daemon/src/plugin-host-worker.ts` (about 31 matching lines). That is a separate, smaller pair and is out of scope here.
- **Why this deserves its place:** the fake host exists so that external plugin tests reproduce production acceptance and rejection. That promise is kept today only by memory and comments ("the fake host must accept and reject provider declarations exactly like production", `packages/plugin-sdk/src/testing/fake-plugin-host.ts:1128`). In the private history since 2026-06-01, 70 of the 100 commits that touched `plugin-api.ts` also touched the fake (Reproduced: `git log --all --since=2026-06-01` on both paths in `$ARCHIVED_OMNYO_CHECKOUT`). The copies have already drifted, so plugin tests can pass on behaviour production rejects. The frontend already solved the same problem with one shared collector (`packages/plugin-sdk/src/internal/plugin-app-collector.ts`).

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named snapshot worktree no longer existed during verification, so the files were read with `git show e9e1b74c3:<path>`. All the files cited here are unchanged between that commit and local `main` at `5f2d3f895` (checked with `git diff --stat`). All paths are repository-relative. The public repository's history is squashed into `060950255` ("Publish Omnyo source", 2026-11-24). Co-change history therefore comes from the retired private store.

*What the subsystem is.* A backend plugin's factory receives a `PluginApi` object. In production, `createPluginApi` (`apps/server/src/services/plugins/plugin-api.ts:602`) builds that object. It returns a `PluginApiHandle` whose record stores (`threadEventHandlers`, `hooks`, `agentTools`, `providerEnvResolvers` and the others, returned at `plugin-api.ts:1746-1779`) are read by `apps/server/src/services/plugins/plugin-service.ts` and `plugin-runtime.ts`. `plugin-runtime.ts:2350` calls `createPluginApi`, and `plugin-runtime.ts:2740` calls `handle.activate()` after the factory. The public SDK ships a test double, `createFakePluginHost` (`packages/plugin-sdk/src/testing/fake-plugin-host.ts:715`). It is exported from `@omnyo/plugin-sdk/testing` (`packages/plugin-sdk/src/testing/index.ts`), and plugins in this repository and in `omnyo-plugins` use it. Both hosts already import validators from `packages/plugin-sdk/src/internal/host-policy.ts`. That module is an SDK subpath export (`./internal/host-policy` in `packages/plugin-sdk/package.json`), and the server imports it as `@omnyo/plugin-sdk/internal/host-policy`. Examples: `storePluginHook` (`host-policy.ts:2745`), `pluginHookAlreadyRegisteredMessage` (`:2754`), `normalizeAgentToolRegistration` (`:3740`), `validateProviderEnvContribution` (`:4034`), `createThreadEventFilter` (`:4453`), `undeclaredIconProblem` (`:2689`) and `KV_VALUE_MAX_BYTES` (`:112`).

*Observed duplication (Reproduced).* `python3 -I` difflib `SequenceMatcher` on whitespace-stripped lines, with `autojunk=False` and matching blocks of at least 6 lines, compared `plugin-api.ts` (1829 lines) with `fake-plugin-host.ts` (2653 lines). It found 34 blocks totalling 449 lines (384 non-blank). About 50 of those lines are import and type-name lists, so they are not policy. The policy-bearing pairs:

| Policy | Production (`plugin-api.ts`) | Fake (`fake-plugin-host.ts`) | Difference |
|---|---|---|---|
| Event-name map and filter store | `:708-729` `threadEventHandlers`, `threadEventFilters` | `:1334-1357` | Identical 18-name list |
| `events.on` (unknown event, filters only on `experimental_thread.events`) | `:1389-1419` | `:1638-1668` | Identical |
| `experimental_hooks.on` and `recheck` | `:731-733`, `:1421-1438` | `:1359-1363`, `:1706-1722` | Fake `on` omits `assertLive()`; `recheck` calls `requestQueueDrain()` in production and increments `requestedDrains` in the fake |
| `agents.configure`, `contributeInstructions`, `registerTool` | `:1126-1198` | `:1116-1123`, `:1215-1271` | Production adds the cross-plugin tool-name branch (`isAgentToolNameTaken`, report or stage into `pendingAgentToolProblems`) |
| `providers.experimental_contributeEnv`, `EnvHealth`, `ModelNotice` and their three maps | `:1114-1124`, `:1442-1472` | `:1087-1114`, `:1674-1704` | Identical bodies; fake spells the resolver types inline |
| `experimental_environments.register` and `recheck` | `:1474-1541` | `:1724-1775` | Production adds two `isEnvironmentProviderIdTaken` cross-plugin checks; `recheck` calls `requestEnvironmentProviderRecheck` in production and increments the counter in the fake |
| `experimental_machines.register` | `:1606-1637` (register part about 22 lines) | `:1783-1807` | Production adds `isMachineProviderIdTaken`; fake has a dead `target.icon === null` branch (`NormalizedPluginMachineProvider.icon` is `string`, `host-policy.ts:3083`) |
| `onDispose`, `onInstall` ("onInstall expects a function") | `:1731-1743` | `:1876-1888` | Identical |
| `PluginContextStaleError` | `:166` | `:164` | Same message and name; production caches one instance per handle (`:765-770`) |
| kv JSON-serializable and 256 KB check | `:831-868` | `:774-813` | Identical `set` validation; backing store differs (SQLite rows vs a `Map`) |

Invocation validators duplicated between `plugin-service.ts` and the fake (Proven by inspection):

- The websocket handler shape check ("websocket route handler must return an object", and "... `${name}` must be a function" for `onOpen`, `onMessage`, `onClose` and `onError`) appears at `plugin-service.ts:2543-2575` `invokeWebSocketRoute` and at `fake-plugin-host.ts:2309-2357` `experimental_openWebSocket` (23 identical lines).
- The provider env-health result rules ("label must not be empty", "statusMessage must not be empty") appear at `plugin-service.ts:2873-2910` and `fake-plugin-host.ts:2073-2103`. The model-notice rule ("message must not be empty") appears at `plugin-service.ts:2912-2945` and `fake-plugin-host.ts:2104-2128`.

*Observed drift (Proven by inspection).*

1. Production `experimental_hooks.on` calls `assertLive()` before the duplicate check (`plugin-api.ts:1423`), and the fake does not (`fake-plugin-host.ts:1707`). After `harness.dispose()`, a fake-hosted plugin can still register a hook; production throws `PluginContextStaleError`. The disposal test (`packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts:1934-1943`) checks kv and `sdk`, not hooks.
2. Production `hosts.experimental_client` calls `assertLive()` when the client is created (`plugin-api.ts:1273`). Production `call` refuses before activation ("host plugin calls are unavailable during factory registration", `:1279-1283`) and rejects a non-string method. The fake does none of these (`fake-plugin-host.ts:1458-1466`), and it has no activation phase at all: `rg '\bactivated\b'` over the fake returns nothing. Its own test calls a host client straight after `createFakePluginHost()` (`fake-plugin-host.test.ts:197-210`). Plugin tests call their factory with `api` themselves, so the fake cannot know when the factory has finished.

*Counterevidence and limits.*

- Most other namespaces are not duplicated policy. `http.route`, `http.experimental_websocket`, `rpc.register`, `background.service`/`schedule`, `cli.register`, `settings.define` and `ui.registerMentionProvider` already delegate to shared normalizers. What remains in each host is `assertLive(); push(normalize(...))` over host-specific record types, such as production websocket records with `active` and `sockets`. Merging them saves little and couples record shapes.
- `createStagedRegistrations` (`plugin-api.ts:514-598`), which providers and AI services use, depends on production activation. The fake registers providers immediately (`registerProviderDeclaration`, `fake-plugin-host.ts:1124-1170`). Moving staging into the SDK would add machinery the fake does not use.
- `experimental_eventSources` and `experimental_serverAccess` (`plugin-api.ts:1543-1580`, fake `:1839-1866`) are 11–16 lines each, and production reads a process-global registry (`listServerAccessProviders`). They are optional for slice 3.
- Tests cannot run in this snapshot (no `node_modules`). All behaviour claims come from source and test inspection.

*Maintenance cost today.* Adding a thread event name, a hook, an agent rule or a provider contribution kind means editing both hosts identically and keeping the error messages byte-equal. Plugin tests then stay trustworthy only if nobody forgets the second edit. The two drift items above show that the second edit does get forgotten.

**Proposed end state and preservation argument**

Add one SDK-internal module, `packages/plugin-sdk/src/internal/backend-registrations.ts`, and re-export its symbols from `host-policy.ts`. Neither host then needs a new package subpath, `exports` entry or bundled-types group, and the server keeps importing `@omnyo/plugin-sdk/internal/host-policy`. The module exports `createBackendRegistrationCore(ports)`:

```ts
interface BackendRegistrationPorts {
  pluginId: string;
  declaredIconNames: ReadonlySet<string>;
  assertLive(): void;
  // Production supplies these; the fake returns undefined or does nothing.
  isAgentToolNameTaken?(name: string): string | undefined; // owner plugin id
  onForeignAgentToolName?(problem: string): void;            // report now or stage
  isEnvironmentProviderIdTaken?(id: string): string | undefined;
  isMachineProviderIdTaken?(id: string): string | undefined;
  onHookRecheck(): void;          // requestQueueDrain | requestedDrains += 1
  onEnvironmentRecheck(): void;   // requestEnvironmentProviderRecheck | counter
  disposeHooks: Array<() => void | Promise<void>>;
  installHandlers: Array<() => void | Promise<void>>;
}

function createBackendRegistrationCore(ports): {
  events: PluginEvents;
  experimental_hooks: PluginHooks;
  agents: PluginAgents;
  providerContributions: Pick<PluginProviders,
    "experimental_contributeEnv" | "experimental_contributeEnvHealth" | "experimental_contributeModelNotice">;
  experimental_environments: PluginEnvironments;
  registerMachineProvider: PluginMachines["register"];
  onDispose: PluginApi["onDispose"];
  onInstall: PluginApi["onInstall"];
  records: {
    threadEventHandlers; threadEventFilters; hooks; agentTools;
    providerEnvResolvers; providerEnvHealthResolvers; providerModelNoticeResolvers;
    environmentCompositions; environmentProviders; machineProviders;
    readonly agentConfigurationProvider; readonly instructionProvider;
  };
};
```

Add these to `host-policy.ts` beside the existing validators: `validateWebSocketRouteHandlers(value)`, `validateProviderEnvHealthResult(value)`, `validateProviderModelNoticeResult(value)`, `encodePluginKvValue(key, value): string` (the JSON-serializable and `KV_VALUE_MAX_BYTES` check) and `PluginContextStaleError`.

What remains in each host:

- **Production (`plugin-api.ts`)** keeps staging (`createStagedRegistrations`, `pendingAgentToolProblems`, `pendingSharedPorts`, `pendingNeedsConfiguration`), `activate()`, the `hosts` namespace with its activation gate, provider `register` and AI services, event sources, server access, storage, settings, secrets, logging, the bound SDK and `invalidate()`. Its `onForeignAgentToolName` port performs `if (activated) reportAgentToolProblem(p) else pendingAgentToolProblems.push(p)`, unchanged.
- **The fake** keeps its counters, temp storage, inspection getters, synchronous behaviour drivers, `registerProviderDeclaration` and `disposeHost`. It passes no "taken" ports, so cross-plugin checks stay production-only, as today.

Preservation argument:

- Every message string, its check order (validate, then icon, then the cross-plugin owner, then the in-plugin duplicate, exactly as each host does today), its thrown-versus-reported choice and its stored record is copied from production, the current authority.
- The record objects returned on `PluginApiHandle` stay the same `Map`/array/`WeakMap` instances that `plugin-service.ts` reads, so readers do not change.
- Production `PluginContextStaleError` keeps its cached per-handle instance (`stale()`, `plugin-api.ts:765-770`), and `plugin-runtime.ts:705` keeps its `instanceof` check. Both import the one class.
- Performance is neutral (Hypothesis, not measured): the same closures run in the same order at registration time, with one extra port call where a host-specific effect already ran.
- No UI, persisted format or public `PluginApi` type changes.

Intentional behaviour change: none inside the refactor. The hook liveness correction lands first as its own commit (ISS item). The fake's host-call activation gate is not changed (separate decision).

Non-goals:

- Moving `createStagedRegistrations` or production activation into the SDK.
- Giving the fake an activation phase.
- Merging HTTP, RPC, background, CLI, settings, storage, secrets, host-client or mention-provider wrappers.
- Changing `testing/host.ts`.

**Expected gain and cost**

- **Measured:** 449 matching lines (384 non-blank) in 34 blocks between the two hosts, of which about 50 are imports and type names. 23 + about 12 duplicated invocation-validator lines sit between `plugin-service.ts` and the fake.
- **Projected:** the in-scope policy bodies are about 290 lines in production and about 270 in the fake (brace-span counts from the anchors above). After the change: a shared core of about 300–340 lines (production's bodies moved, plus ports), about 30–40 lines of production adapter wiring, about 30–50 lines of fake adapter wiring, and about 40 lines of shared validators replacing about 70. Net handwritten production reduction: **150–250 lines**, almost entirely in `packages/plugin-sdk/src/testing/fake-plugin-host.ts` (shipped SDK code). `plugin-api.ts` is roughly neutral because its bodies move; moved code is not counted as deleted.
- **Tests:** add one parity suite of about 150–250 lines. Existing tests are unchanged.
- **Mechanisms:** before, two implementations of seven registration policies plus three invocation validators, two copies of the 18-name event map, and two `PluginContextStaleError` classes. After, one owner of each, two thin adapters, and one parity test that pins the remaining differences (cross-plugin checks and staging are production-only).
- **Maintenance example:** adding a new thread event name or hook kind, or rewording "Event type filters require experimental_thread.events", is one edit in `backend-registrations.ts`. Both hosts and the parity test pick it up, and a forgotten liveness check can no longer exist in only one host.
- **Cost:** one new internal module and a ports object. The SDK must be rebuilt and repacked for external plugin repositories to see the change. Plugin tests pinned to older packed SDKs keep their bundled fake.

**Execution steps**

1. **Reconfirm.** Check out a fresh lane from current `main`. Re-run the difflib comparison above, and confirm the anchors and that both drift items still exist. Stop and re-plan if any of these hold: production gained activation-dependent behaviour in one of the in-scope namespaces; RF-041 deleted an `experimental_*` namespace listed here; or `host-policy.ts` is no longer the SDK-internal boundary the server imports.
2. **Prerequisite fix (separate commit).** In `fake-plugin-host.ts` `experimental_hooks.on` (`:1707`), add `assertLive();` as the first statement. Add a case to `fake-plugin-host.test.ts` near the disposal test (`:1934`): after `harness.dispose()`, `api.experimental_hooks.on("message.dispatch", …)` throws "used a stale API handle". Watch the test fail before the fix and pass after it.
3. **Baseline the contract (parity suite).** Create `packages/plugin-sdk/src/internal/__tests__/backend-registrations.test.ts`. It should run against `createFakePluginHost` and, through the new core, against a minimal production-like port set. Cover:
   - an unknown event name and its message;
   - a filter on a non-`experimental_thread.events` event;
   - a duplicate hook, a duplicate `configure` or `contributeInstructions`, and a non-function provider;
   - a duplicate tool;
   - a duplicate, empty-id or non-function provider env/health/notice contribution;
   - environment composition versus concrete-provider ID clashes in both orders;
   - an undeclared icon on environment and machine providers;
   - `onInstall` with a non-function;
   - every namespace after dispose.

   Assert exact messages. The cross-plugin "taken" cases and staged tool problems run only against the production adapter in `apps/server/test/services/plugins/` (extend `plugin-instance-lifecycle.test.ts` or `plugin-service.test.ts`, whichever already builds a loaded plugin). Write these tests against the current code first, so they pass before any move.
4. **Slice 1: events and hooks.** Create `backend-registrations.ts` with the event map (copied from `plugin-api.ts:708-729`), `threadEventFilters`, `events.on` (`:1389-1419`), the `hooks` record, `experimental_hooks.on` and `recheck` (which calls `ports.onHookRecheck()`), `onDispose` and `onInstall`. Re-export the module from `host-policy.ts`. In `createPluginApi`, build the core once after `assertLive` is defined, and spread or assign its members into `api`. Return `core.records.threadEventHandlers`, `threadEventFilters` and `hooks` on the handle. Delete the local copies, keeping the local `PluginThreadEventHandlers` and `PluginHookRecords` types only if `plugin-service.ts` imports them, otherwise move them too. Do the same in the fake, with `onHookRecheck: () => { requestedDrains += 1; }`, and keep the inspection getters (`:1976-1995`) reading `core.records`. Checkpoint: SDK and server typecheck, the parity suite, `plugin-thread-events.test.ts` and `fake-plugin-host.test.ts`.
5. **Slice 2: provider contributions and agents.** Move the three resolver maps and the `experimental_contribute*` bodies (`plugin-api.ts:1114-1124`, `:1442-1472`), and `agents` (`:1126-1198`), into the core. `registerTool` calls `ports.isAgentToolNameTaken?.(record.name)`. When that returns an owner, it builds the same `tool "<name>" is already registered by plugin "<owner>" — not registered` string, calls `ports.onForeignAgentToolName?.(problem)` and returns. Then it applies the in-plugin duplicate throw. Production passes `isAgentToolNameTaken` and `onForeignAgentToolName: (p) => activated ? reportAgentToolProblem(p) : pendingAgentToolProblems.push(p)`. The fake passes neither. `providers.register` stays in each host and is composed with `core.providerContributions` into `PluginProviders`. Checkpoint: as in step 4, plus `apps/server/test/services/plugins/plugin-provider-registration.test.ts` and `plugin-sdk.test.ts`.
6. **Slice 3: environments and machines.** Move the two maps, `experimental_environments.register`/`recheck` (`plugin-api.ts:1474-1541`) and the machine `register` body (`:1613-1636`) into the core, with the two optional `is*Taken` ports and `onEnvironmentRecheck`. Production `experimental_machines` keeps `createMachineBootstrapApi` and `getResource` and takes `register: core.registerMachineProvider`. The fake keeps its `machineBootstrap` and `machineResource` options. The fake's dead `icon === null` branch disappears with the move. Optionally move `experimental_eventSources` here too, with an `isEventSourceFamilyTaken` port. Leave `experimental_serverAccess` local, because production reads a global registry. Checkpoint: as in step 5, plus the environment-provider tests that `rg -l "experimental_environments" apps/server/test` finds.
7. **Slice 4: invocation validators and small shared rules.** Add `validateWebSocketRouteHandlers`, `validateProviderEnvHealthResult`, `validateProviderModelNoticeResult`, `encodePluginKvValue` and `PluginContextStaleError` to `host-policy.ts`. Call them from `plugin-service.ts:2543-2575`, `:2873-2945`, `plugin-api.ts` `kv.set` (`:840-857`), and the fake's `:2329-2357`, `:2073-2128` and `kv.set` (`:783-800`). Delete the local `PluginContextStaleError` classes, and import the shared class in `plugin-api.ts`, `plugin-runtime.ts:111` and `testing/index.ts` (keep the public export name). Production's cached `stale()` instance stays. Checkpoint: as in step 5, plus `plugin-instance-lifecycle.test.ts`.
8. **Clean up and recount.** Remove now-unused imports from both hosts and the stale "must match production" comments the core now enforces. Re-run the difflib comparison: the remaining matches should be imports and the intentionally local wrappers. Recount with `wc -l` against the same baseline and report the actual net change.

**Verification and acceptance criteria**

Commands come from the `package.json` scripts read at the snapshot. Run them from the repository root after `pnpm install` in a working lane. They could not be run during this audit because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/plugin-sdk typecheck` and `pnpm --filter @omnyo/server typecheck` (both scripts are `tsc --noEmit`).
- `pnpm --filter @omnyo/plugin-sdk test` (script `vitest run --config vitest.config.ts`; it includes `src/**/*.test.ts`, so it covers the new parity suite and `src/testing/__tests__/fake-plugin-host.test.ts`).
- `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-thread-events.test.ts test/services/plugins/plugin-provider-registration.test.ts test/services/plugins/plugin-instance-lifecycle.test.ts test/services/plugins/plugin-sdk.test.ts test/services/plugins/plugin-service.test.ts`. The file filter after `--` is standard vitest usage but was not executed here.
- The plugin tests that most exercise the fake: `pnpm --filter <plugin package> test` for `plugins/tasks`, `plugins/account-pool`, `plugins/storage-retention` and `plugins/workflows`. Read each plugin's `package.json` for its package name and script first; they were not confirmed here.
- The packed-SDK check: `pnpm --filter @omnyo/plugin-sdk build:types` and `pnpm --filter @omnyo/plugin-sdk build`. They confirm that the new internal module bundles into `dist/testing` and the bundled declarations without a new `exports` entry.

Acceptance criteria:

- Every existing assertion passes unchanged. The only new behaviour is the step 2 correction.
- The parity suite asserts identical messages for both adapters. Cross-plugin and staging cases pass only in the production adapter.
- `rg -n '"Event type filters require experimental_thread.events"|agent configuration is already registered|onInstall expects a function|websocket route handler must return an object|statusMessage must not be empty' apps packages` finds each string once, in `packages/plugin-sdk/src/internal/`, plus in tests.
- `rg -n 'class PluginContextStaleError' apps packages` finds one definition.
- Structural: the fake no longer defines the event map, the hooks record, `agents`, the provider contribution bodies or the environment/machine register bodies.
- No UI is affected. Performance needs no benchmark: the code runs once per registration call, and no hot path changes. Report any measured plugin-load time change seen in the existing tests' timings.

**Rollback and stop conditions**

- Each slice is a separate commit that touches the core, both adapters and the tests. Reverting one slice restores both local copies. There are no data, persisted-format or public type changes, so rollback has no compatibility implications. Plugins pinned to an older packed SDK are unaffected either way.
- Stop if a slice needs a caller-specific branch inside the core beyond the named ports, for example a production-only record shape or an activation check. Leave that namespace explicit in both hosts instead.
- Stop if an existing plugin or server test fails because the error order or message changed. Production's current behaviour is the authority: fix the core, not the test.
- Stop if `plugin-service.ts` or `plugin-runtime.ts` turns out to depend on record identity or mutation timing that the core changes, for example replacing a `Map` on reload.
- Stop if the SDK bundled declarations would expose the core's port types on a public subpath beyond `internal/host-policy`.
- If any of these stops trigger, the safe smaller alternative is the prior audit's minimum: slice 1 alone (events and hooks) plus the step 2 fix. That removes the observed drift class for the most-used registrations.
