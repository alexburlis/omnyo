---
date: 2026-11-25
researcher: Codex
git_commit: eb5a9bc7d70093c95097d864fc7ef2ca8b4b2e13
branch: main
repository: omnyo
topic: Material opportunities to simplify Omnyo
tags: [refactoring, maintenance, audit]
status: researched
last_updated: 2026-11-25
last_updated_by: Codex
---

# Where Omnyo can delete code and maintain fewer implementations

## Purpose / Big Picture

I found **17 implementation changes and three conditional retirements** worth pursuing in the local Omnyo checkout. I would start with thread-storage retention, callback state and the obsolete timeline-cache APIs. The first two already give different answers depending on the caller. The third offers a small, verifiable deletion. For straightforward volume reduction, provider usage reporting is the best first project. The largest decision is whether Omnyo still needs to maintain two ACP engines.

| Where I would spend time                    | What Omnyo gains                                                                                               | Evidence                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Thread storage and callbacks (§1–2)         | One retention rule and one answer about whether a callback source is working                                   | Source trace of both deletion paths and an executed two-reader SQLite fixture                 |
| Timeline cache and provider usage (§3–4)    | Two obsolete repositories removed and four usage implementations reduced to one shared implementation          | Four cache exports traced, 122 cache source lines and 828 usage source lines measured         |
| ACP support (§5–6, §18)                     | Either one supported engine or one maintained copy of 1,495 identical lines across the two engine/plugin pairs | Nine byte-for-byte comparisons and the published SDK export surface                           |
| Plugin registrations and inbox facts (§7–8) | A test host that enforces the production rule and fewer transformations of the same thread state               | A missing lifecycle check and a traced request that loads waits and queues twice              |
| Rename tooling and design lab (§19–20)      | Whole tools or experiments can leave active maintenance if their owners confirm retirement                     | 6,220 lines of rename tooling and 5,466 lines of scene/shader code in six registered variants |

The figures measure **existing source in scope** unless specifically described as identical lines. They are not a forecast of net deletions. The ACP retirement overlaps three smaller findings. Adding the numbers would double count.

## Plan Metadata

Schema: 2
Kind: refactor
State: draft
Risk: elevated
Boundary: local-only
Mutation: none

## Scope Contract

Requested outcome: A saved, evidence-backed audit identifying the largest credible simplifications and how to carry them out.
In scope: Current local application, host, server, database, SDK, plugin, CLI, desktop, web and repository-tooling source. The only deliverable in this pass is this document.
Out of scope: Product changes, data deletion, provider cutovers, removal of published APIs or URLs, releases and deployments.
Authority: Alex requested inspection and a written implementation plan. The proposed code changes and retirements are future work.
Acceptance signal: Each listed change identifies a specific mechanism or duplicate, a replacement, and a way to establish that the intended behavior survives. Conditional retirements name the decision they need.

## Current Facts and Sources

The audit examined local `main` at `eb5a9bc7d70093c95097d864fc7ef2ca8b4b2e13`, with existing uncommitted work present. The local tracking ref for `origin/main` advanced during the audit. The links and counts below refer to the inspected checkout. Refresh those paths before implementing on a newer revision.

The inventory contained 9,742 tracked paths. A first-pass filter found 4,672 source-like files under `apps`, `packages`, `plugins` and `scripts` (2,769, 1,034, 818 and 51 respectively). It counted tracked files with a TS, TSX, JS, JSX, MJS, CJS, Swift, Go, Rust or Python suffix, excluding named test/fixture/story/generated/build directories and common test/story/generated filename suffixes. This inventory guided the search. Candidate review followed owners, imports, callers, tests, analogous implementations and documented compatibility requirements. It did not establish semantic equivalence across all 4,672 files.

**Evidence levels.** “Reproduced” means local code ran and produced the stated result. “Proven by inspection” identifies a concrete source path or comparison. Proposed designs and potential savings are engineering judgments. The callback fixture below ran against an in-memory database. No production data, destructive cleanup, release, visual comparison or performance benchmark was involved.

## Plan of Work

### 1. Give thread-storage deletion one host-owned retention rule

**Proven by inspection.** Normal deletion checks for a retention receipt twice, on either side of process termination. Orphan cleanup finds directory-shaped thread IDs missing from the database and dispatches generic recursive path removal. That path checks containment and filesystem type but does not read the receipt. A restored or retained directory with no database row can therefore take a different deletion path. No removal was performed for this audit. [Normal thread deletion](../apps/host-daemon/src/command-handlers/thread.ts#L63) · [Orphan dispatch](../apps/server/src/services/threads/thread-storage-orphans.ts#L128) · [Candidate selection](../apps/server/src/services/threads/thread-storage-orphans.ts#L165) · [Generic path removal](../apps/host-daemon/src/command-handlers/path-mutations.ts#L136)

**Change and proof.** Keep orphan discovery, session matching, maintenance checks and batch limits on the server. Have the host derive the storage path from its own root and the thread ID. Make both operations use one host function enforcing containment, symlink policy and both receipt checks. The existing lifecycle command also carries thread/environment metadata, so reuse its filesystem operation without inventing a database row for an orphan. Exercise retained, unretained, symlink, missing-directory, disconnected-host and retry cases on disposable fixtures. The main saving is one deletion policy to maintain. [Lifecycle command builder](../apps/server/src/services/threads/thread-commands.ts#L642) · [Host tests](../apps/host-daemon/src/thread-storage-deletion.test.ts) · [Orphan tests](../apps/server/test/threads/thread-storage-orphans.test.ts) · [Retention tests](../apps/server/test/threads/thread-storage-deletion-retention-receipt.test.ts)

### 2. Compute callback source state once for the list and attention views

**Reproduced.** An idle source thread with one running background shell command produced `{"callbackList":"idle","attentionFacts":"working"}` through two real database entry points. The single-source path checks background agents and native workers. The batch path also counts background commands and workflows. The paths also evaluate a queued request for human input at different points relative to errors and active work. Both readers feed application surfaces. [Single-source reader and callback list](../packages/db/src/data/thread-attention.ts#L85) · [Batch reader](../packages/db/src/data/thread-attention.ts#L309) · [Attention route](../apps/server/src/routes/thread-attention.ts#L42) · [Runtime display](../apps/server/src/services/threads/thread-runtime-display.ts#L658)

**Change and proof.** Use the existing batch fact loader for one or many sources and classify each source exactly once. Keep callback-owner eligibility, ordering and title fallback. Make the precedence for simultaneous queued input, work and errors explicit in a small table of expected results. Run both public readers over each row, including null, missing, archived and deleted sources. For the reproduced case, both must return `working`. The fixture is included below. [Existing attention tests](../packages/db/test/data/thread-attention.test.ts)

### 3. Delete the superseded primary-database timeline-cache APIs

**Proven by inspection.** Two private database files, **82 and 40 lines**, expose four operations for timeline records and conversation outlines. A repository symbol search found their declarations, barrel exports and tests. The current history worker opens a separate cache database, and the root-cache reader uses that storage. Some tests deliberately write the old store to exercise independent primary-database activity. [Old timeline repository](../packages/db/src/data/timeline-derived-cache.ts#L41) · [Old outline repository](../packages/db/src/data/thread-conversation-outlines.ts#L10) · [Current worker](../apps/server/src/services/threads/timeline-worker.ts#L85) · [Current root cache](../apps/server/src/services/threads/timeline-root-cache.ts#L116) · [Test using the old API](../apps/server/test/services/threads/timeline-page-builder.test.ts#L795)

**Change and proof.** Remove the four exports and their two implementations. Replace the unrelated-write fixture with another harmless primary-database write. Preserve tests for read-only history, invalidation, epoch/rewrite behavior and lock contention. Leave historical migrations and physical tables in place, including schema declarations needed by migration tooling. Repeat the symbol search, typecheck the private DB consumers, and run the current history-worker and root-cache cases. This retires a persistence API without a data migration. [Root-cache tests](../apps/server/test/services/threads/timeline-root-cache.test.ts) · [Contention fixture](../apps/server/test/performance/history-stalls-peer.mjs#L18)

### 4. Replace four provider-usage implementations with one SDK implementation

**Proven by inspection.** Codex, Claude Code, ACP and ACP Next maintain **210, 210, 204 and 204 lines** of usage reporting. Codex and Claude Code share 205 matching lines out of 210. Each implementation deals with resource ownership, caching, refresh coalescing and unavailable results. The SDK already owns provider-usage types and helpers. [Codex](../plugins/provider-codex/src/usage-source.ts#L28) · [Claude Code](../plugins/provider-claude-code/src/usage-source.ts#L28) · [ACP](../plugins/provider-acp/src/usage-source.ts#L28) · [ACP Next](../plugins/provider-acp-next/src/usage-source.ts#L28) · [Existing SDK code](../packages/plugin-sdk/src/provider-usage.ts#L128)

**Change and proof.** Put the common implementation beside the existing SDK helper. Each plugin passes its ownership predicate, source description and registration identity. Keep one cache instance per registration, the 60-second expiry, forced-refresh coalescing and the distinction between unsupported, unavailable and empty usage. ACP Next must retain its runtime plugin identity. Port identical behavioral cases to the shared owner and keep a registration/ownership test per plugin, including a forked plugin. Roughly 600 net lines could go if the wrappers stay small. Measure the actual diff after wiring all four. [Existing usage cases](../plugins/provider-codex/src/usage-source.test.ts#L196) · [Independent plugin contract](../docs/forkable-plugins.md#L21)

### 5. Share the seven identical ACP native-root resolvers

**Proven by inspection.** All seven corresponding files compare byte-for-byte equal between classic ACP and ACP Next. One set occupies **1,101 lines**. The provider-specific dispatchers and agent registration still belong to each plugin. [Classic resolver directory](../plugins/provider-acp/src/native-roots) · [Next resolver directory](../plugins/provider-acp-next/src/native-roots) · [Dispatcher](../plugins/provider-acp/src/native-roots/index.ts#L12) · [Host caller](../plugins/provider-acp/src/host.ts#L5)

**Change and proof.** If both engines will remain, ship these resolvers through a host-side entry point in the packed plugin SDK. Both plugins can then delegate to the same implementation while retaining independent agent selection. Direct sibling-plugin imports would break standalone forks. Preserve path normalization, missing roots and agent-specific lookup behavior. Run the resolver fixtures through both dispatchers and build/typecheck each plugin as an isolated fork against the packed SDK. Check the minimum compatible SDK version for each plugin. If classic retirement is imminent, skip this move. [Classic fixtures](../plugins/provider-acp/src/native-roots/native-roots.test.ts) · [Next fixtures](../plugins/provider-acp-next/src/native-roots/native-roots.test.ts) · [Fork checks](../docs/forkable-plugins.md#L21)

### 6. Keep one implementation of ACP permissions and Cursor model selection

**Proven by inspection.** The two bridge kits each contain the same **230-line** interaction module and **164-line** Cursor model-selection module. The production bridges call these paths for approvals and model listing. The interaction implementations already import shared ACP presentation/classification code. [Classic interactions](../packages/provider-bridge-acp/src/interactions.ts#L140) · [Next interactions](../packages/provider-bridge-acp-next/src/interactions.ts#L140) · [Cursor selection](../packages/provider-bridge-acp/src/cursor-model-selection.ts#L33) · [Classic bridge caller](../packages/provider-bridge-acp/src/bridge/bridge.ts#L1704) · [Next bridge caller](../packages/provider-bridge-acp-next/src/bridge/bridge.ts#L2055)

**Change and proof.** If both engines remain, move the pure operations to the existing shared ACP protocol code. Keep engine-specific types and model-family lookup at their boundaries. Centralize identical pure-helper tests and retain both engines’ end-to-end permission and model-selection cases. Keep the engines’ distinct stop-reason schemas and event visibility rules. Check approval options, cancellation and model/reasoning round trips. The 394-line duplicated copy gives an upper bound before any adapters. [Classic wire contract](../packages/provider-bridge-acp/src/wire.ts) · [Next wire contract](../packages/provider-bridge-acp-next/src/wire.ts)

### 7. Make the backend plugin test host enforce the production registration rules

**Proven by inspection.** Production calls `assertLive()` before registering a hook. The fake host checks for a duplicate and stores the handler without the lifecycle assertion. Its disposal tests exercise other APIs. A plugin that registers a previously unused hook after disposal can therefore pass the fake's registration check and fail in production. Event filters, provider contributions and agent configuration also maintain parallel registration policy. The frontend already shares a collector between real and fake hosts. [Production hooks and events](../apps/server/src/services/plugins/plugin-api.ts#L1389) · [Fake hooks](../packages/plugin-sdk/src/testing/fake-plugin-host.ts#L1706) · [Disposal tests](../packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts#L1934) · [Frontend precedent](../packages/plugin-sdk/src/internal/plugin-app-collector.ts#L490)

**Change and proof.** Start with hook registration. Move the lifecycle/duplicate check and handler insertion together into SDK internals. Have both adapters use it, with production queue wakeups and fake counters kept local. Expand to event filters or provider contributions only where the entire policy can be removed from both sides. Run the same live, duplicate and disposed cases against the two adapters and check staged activation separately. This removes the need to remember to patch the harness every time registration policy changes.

### 8. Load waits and queued messages once per inbox request

**Proven by inspection.** The inbox collector constructs thread-list entries and work summaries, which load waits, conditions and queued messages. The same collector then reads waits/conditions and queues again and translates parts of the finished summary back into inputs for its inbox projection. The work-summary wait helper alone spans 72 lines. The overlap is in gathering facts. The two presentations have different eligibility and ordering rules. [First pass](../apps/server/src/services/inbox/collect.ts#L196) · [Summary builder](../apps/server/src/services/threads/thread-runtime-display.ts#L627) · [Wait reads](../apps/server/src/services/threads/thread-work.ts#L414) · [Queue reads](../apps/server/src/services/threads/thread-work.ts#L586) · [Second pass](../apps/server/src/services/inbox/collect.ts#L222) · [Translation](../apps/server/src/services/inbox/collect.ts#L405)

**Change and proof.** Start with the intersection of raw facts for the same thread IDs. Pass a request-local batch of waits, conditions and queues to the existing projectors. Keep each projector's filters and source-ID expansion explicit. Delete the second queries and grouping code once output matches for roots, children, stopped sources and failed queues. Count the queries as well as comparing returned entries. There is no measured latency claim. [Inbox scenarios](../apps/server/test/inbox/inbox-scenarios.test.ts) · [Background-work cases](../apps/server/test/inbox/inbox-background-work.test.ts) · [Public work response](../apps/server/test/public/public-thread-work.test.ts)

### 9. Move Git default-branch discovery into the existing shared query factory

**Proven by inspection.** The host workspace and environment-provider helpers separately implement local default-branch preference, origin-HEAD discovery and ahead/behind relation handling. Both already inject their Git runner and error type into the same query factory. Changes to default selection currently need to agree across the branch picker, worktrees and temporary copies. [Host implementation](../packages/host-workspace/src/git.ts#L1170) · [Provider implementation](../packages/environment-provider-host/src/git.ts#L389) · [Existing factory](../packages/environment-provider-host/src/git-queries.ts#L28) · [Branch picker](../apps/host-daemon/src/command-handlers/host-branches.ts#L311) · [Temporary-copy caller](../plugins/environment-temporary-copy/host/copy.ts#L378)

**Change and proof.** Move the equal default-selection and ref-relation calculations into that factory, then delegate from the existing public methods. Keep runner deadlines, output caps, remote access and error mapping local to the caller. Compare both entry points for bare repositories, missing/stale origin HEAD, custom defaults, diverged branches and offline refs. The gain is one answer for how to choose and compare a branch. [Host ref tests](../packages/host-workspace/test/git.refs.test.ts#L23) · [Provider ref reader](../packages/environment-provider-host/src/git.ts#L579)

### 10. Give the browser, mobile and SDK one subscription-counting rule

**Proven by inspection.** Three realtime implementations total **1,933 lines**. Each tracks a target while it has subscribers, emits the first subscribe and final unsubscribe, and replays active targets on reconnect. Browser and mobile also decode the same incoming frame families. The SDK presents a narrower listener API. Transport lifecycle, authentication, resume policies and event delivery differ by runtime. [Browser subscriptions](../apps/app/src/lib/ws.ts#L495) · [Mobile subscriptions](../apps/mobile/src/lib/realtime/mobile-realtime.ts#L480) · [SDK subscriptions](../packages/sdk/src/realtime-client.ts#L320) · [Browser decoder](../apps/app/src/lib/ws.ts#L409) · [Mobile decoder](../apps/mobile/src/lib/realtime/mobile-realtime.ts#L390)

**Change and proof.** Extract only target identity, retain/release and active-target iteration into a dependency all three already use. Let each caller send its own frames. Compare the exact sent-frame sequence for two listeners on one target, partial unsubscribe, reconnect, final unsubscribe and disposal. Consider a shared decoder for web/mobile only after the first extraction removes real branches. Keep browser resume coalescing, mobile suspension/authentication and SDK listener semantics with their current owners. The 1,933 lines describe the surrounding code, not achievable savings. [Browser tests](../apps/app/src/lib/ws.test.ts#L147) · [Mobile tests](../apps/mobile/src/lib/realtime/mobile-realtime.test.ts#L38) · [SDK tests](../packages/sdk/test/realtime-client.test.ts#L15)

### 11. Run new-thread and existing-thread composer selections through one queue

**Proven by inspection.** Both composers serialize selection requests, set an overall deadline and wait for committed React state after changing execution selections. The compared blocks span 143 and 99 lines with 65 nonblank lines matching in order. The existing settling module already owns observers, deadlines and committed-state checks. [New thread](../apps/app/src/components/promptbox/NewThreadComposer.tsx#L2301) · [Existing thread](../apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx#L1236) · [Existing settling code](../apps/app/src/components/promptbox/composer-selection-settle.ts#L99)

**Change and proof.** Move the queue and common ordered execution selections alongside the settling code. Leave project/environment changes, refusal, picker locks and handoff behavior with each composer. Preserve one deadline per request and recovery after an earlier queued operation rejects. Check back-to-back selections, timeout, refusal and the finally committed provider/model/reasoning values through both component entry points. [New-thread integration tests](../apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx#L3620) · [Existing-thread integration tests](../apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx#L2434)

### 12. Build secondary-panel tab descriptions once across both views

**Proven by inspection.** Root compose and thread detail separately turn the same eight file-panel tab kinds into labels, icons, close/select handlers and renderer metadata. The two mapping blocks share **109 nonblank lines in matching order**. Their close-window paths also repeat terminal-versus-file behavior. Both views already use the same terminal hook. [Root mapping](../apps/app/src/views/RootComposeView.tsx#L1269) · [Thread mapping](../apps/app/src/views/thread-detail/ThreadDetailView.tsx#L3431) · [Root close path](../apps/app/src/views/RootComposeView.tsx#L1166) · [Thread terminal operations](../apps/app/src/views/thread-detail/ThreadDetailView.tsx#L1897)

**Change and proof.** Move the per-kind display mapping into the secondary-panel component directory. Each view supplies its content renderer, current plugin action and activation/close callbacks. Keep view-specific pane context, plugin-details priority and terminal cleanup. Check labels and selection in both views, then close a terminal, a file, an open plugin detail and the final pane through the existing command handlers. [Root command tests](../apps/app/src/views/RootComposePanelCommandHandlers.test.tsx#L81) · [Terminal tests](../apps/app/src/components/secondary-panel/usePanelTerminals.test.tsx#L269)

### 13. Derive the eleven persisted panel-tab types from the schemas

**Proven by inspection.** One file describes the same eleven tab shapes twice, once as strict Zod objects and once as TypeScript interfaces and unions. Fields such as optional file-opener ownership and browser targets thus have two declarations to update whenever persisted state changes. [Schemas](../packages/client-core/src/panel/fixed-panel-tabs-state.ts#L71) · [Interfaces and union](../packages/client-core/src/panel/fixed-panel-tabs-state.ts#L230)

**Change and proof.** Infer the persisted discriminated union and keep current exported type names as aliases for its variants. Preserve local-only fields, historical parsing and exact optional-property semantics where explicit types do additional work. No storage format change is needed. Typecheck current consumers and run existing restore, normalization, expiry and runtime-tab persistence fixtures against unchanged stored data. The saving is deleting hand-maintained declarations for the same data. [Persistence fixtures](../apps/app/src/lib/fixed-panel-tabs-state.test.ts#L43)

### 14. Use the existing plugin SDK client in CLI settings commands

**Proven by inspection.** The CLI's plugin command has nine call sites for its own HTTP helper. The SDK already owns settings GET/PUT and several adjacent operations. The CLI also parses response descriptors through a smaller schema. That schema omits multiline, placeholder, option labels and section descriptions supported by the server contract. Parsed output therefore loses those fields before JSON printing. The CLI additionally treats several HTTP error statuses as structured command results. [Local parser](../apps/cli/src/commands/plugin.ts#L159) · [Local HTTP helper](../apps/cli/src/commands/plugin.ts#L431) · [Config output](../apps/cli/src/commands/plugin.ts#L2310) · [Server descriptor](../packages/server-contract/src/api/plugins.ts#L416) · [SDK settings GET](../packages/sdk/src/areas/plugins.ts#L791) · [SDK settings PUT](../packages/sdk/src/areas/plugins.ts#L864)

**Change and proof.** Migrate the settings reads and writes to the existing SDK and remove the CLI descriptor copy. Preserve the CLI's output envelope, redaction, status/exit behavior and text formatting, while explicitly testing the restored JSON metadata. Then migrate additional call sites only where they have the same contract. Keep uncovered operations such as logs local. Check 400, 404, 409 and 422 paths before deleting the generic helper. [CLI config tests](../apps/cli/src/__tests__/command-output/plugin-config.test.ts) · [Enable tests](../apps/cli/src/__tests__/command-output/plugin-enable.test.ts) · [Remove tests](../apps/cli/src/__tests__/command-output/plugin-remove.test.ts)

### 15. Share the Explore catalog vocabulary and filter

**Proven by inspection.** The site and SDK separately declare catalog kinds, item/CTA shapes, query length, normalization and filtering. The site already has an explicit parity test comparing these implementations. Both the website and CLI expose search over this catalog. [Site vocabulary](../apps/web/src/explore/catalog.ts#L3) · [Site filter](../apps/web/src/explore/catalog.ts#L125) · [SDK vocabulary](../packages/sdk/src/explore.ts#L7) · [SDK search](../packages/sdk/src/explore.ts#L650) · [CLI caller](../apps/cli/src/commands/explore.ts#L352) · [Parity test](../apps/web/src/explore/sdk-contract.test.ts#L118)

**Change and proof.** Put the shared catalog shapes and pure search functions in one small existing package entry point accessible to both. Preserve SDK exports, site labels, routing, catalog generation, response-size limits and SDK network validation. Keep a producer/consumer test that reads actual v1/v2 responses and filters the published items. The ongoing saving is changing the meaning of a search or catalog kind in one place. [Catalog compatibility fixtures](../apps/web/src/explore/sdk-contract.test.ts#L100)

### 16. Derive simple runtime bridge commands from protocol request parameters

**Proven by inspection.** The runtime defines execution options and an 18-variant internal command union. Several arms redeclare fields already owned by the protocol. Other arms perform genuine translation, including fork capability checks, merging settings and translating IDs. An indiscriminate rewrite would hide those decisions. [Runtime declarations](../packages/agent-runtime/src/provider-adapter.ts#L26) · [Protocol requests](../packages/provider-bridge-protocol/src/requests.ts#L33) · [Execution options](../packages/provider-bridge-protocol/src/execution-options.ts#L10) · [Runtime translation](../packages/agent-runtime/src/bridge-protocol-adapter.ts#L271)

**Change and proof.** Derive the parameter types for exact matches such as simple provider reads, keeping existing command discriminants. Delete duplicated field lists incrementally. Leave commands with different mutability, capability checks, stop intent or option merging explicit. Stop if the remaining extraction requires an elaborate generic mapping. Check emitted requests and refusal behavior with the existing runtime and bridge contract suites. [Command contract](../packages/agent-runtime/src/runtime.command-contract.test.ts) · [Adapter tests](../packages/agent-runtime/src/bridge-protocol-adapter.test.ts)

### 17. Define desktop release-channel identity once

**Proven by inspection.** Packaging and runtime independently map latest, nightly and public-beta to the app name, profile name, icon and release tag. A current test checks the same beta identity through both functions. The runtime parser accepts three channels while its error message lists two. Profile and release-tag drift here can select the wrong user directory or update channel. [Packaging map](../apps/desktop/scripts/desktop-release-channel.mjs#L64) · [Runtime map and validator](../apps/desktop/src/desktop-update-provider.ts#L13) · [Parity test](../apps/desktop/test/public-beta.test.ts#L122)

**Change and proof.** Keep the identity fields in one platform-neutral lookup in the existing release-channel module and expose them through its existing typed declaration. Packaging adds installer IDs and platform rules. Runtime adds feed/support policy. Test all three channels, default and invalid inputs, profile paths and the existing macOS-only beta packaging restriction. Verify via local unit tests without building or publishing a release. [Typed declaration](../apps/desktop/scripts/desktop-release-channel.d.mts) · [Update-provider tests](../apps/desktop/test/desktop-update-provider.test.ts)

### 18. Decide whether ACP Next can replace the original engine

**Conditional retirement.** The original bridge has **7,854 lines in 14 non-test source files**. Its plugin has another **2,225 lines in 18 TS/MJS files** under the audit filter, including plugin test configuration. The SDK exposes both bridge kits. The documented purpose of running them side by side is to compare them before selecting a successor. Enabling the replacement carries `customAgents` across. Next changes transport and adds features, so a file comparison cannot establish readiness. [Comparison and replacement contract](api_to_audit.md#L1315) · [SDK exports](../packages/plugin-sdk/package.json#L46) · [Settings transfer](../apps/server/src/services/plugins/builtin-registry.ts#L300) · [Original bridge](../packages/provider-bridge-acp/src/bridge/bridge.ts) · [Next bridge](../packages/provider-bridge-acp-next/src/bridge/bridge.ts)

**Decision and plan.** Decide whether the original is still a supported implementation. If so, take §5–6. If Next is the intended replacement, first compare resume/fork of existing threads, permissions, cancellation, model selection, configured agents and captured provider sessions. Test the supported upgrade and downgrade paths and a real packed-SDK plugin fork. Choose which public import and plugin identity must continue to work. Once those consumers have a verified path, delete the classic implementation and redundant standalone tests, retaining any required compatibility exports. About **10,079 lines are in scope**, with a smaller net deletion after compatibility. This overlaps §4–6.

### 19. Retire the one-time BB-to-Omnyo source rename tool if its last consumer is done

**Conditional retirement.** The migration CLI, selectors and mapping files total **6,220 implementation lines in 12 files**. They implement a journaled source transformation with plan, apply, resume and check modes. The inspected repository references lead back to this tool and its tests. The README explicitly documents manual invocation. A repository search cannot establish that downstream operators have finished using it. [CLI](../scripts/omnyo-rename.mjs) · [Largest mapping file](../scripts/omnyo-source-map.mjs) · [Selectors](../scripts/omnyo-rename/selectors.mjs) · [Operator instructions](../scripts/omnyo-rename/README.md#L107)

**Decision and plan.** Confirm whether there is an active rename journal, downstream backport process or supported invocation that needs the tool on current main. If it is complete, record the last usable revision and remove the tool, its dedicated fixtures/tests and its live documentation together. Preserve runtime data migrations, legacy settings and supported wire formats. Verify package scripts, CI and documented maintainer workflows after the removal. If a downstream operator still runs it regularly, retain the tool. The large reduction comes from retiring the operation itself.

### 20. Retire unselected web design-lab variants before sharing renderer code

**Conditional retirement.** Six related scene components (`o-1` and `eclipse-1` through `eclipse-5`) total **4,273 lines**, plus **1,193 shader lines**. All six are registered design previews. The lab guard returns a 404 in production. The public homepage instead imports `combined-a-v2` from the same lab tree, so deleting the whole directory would break the homepage. The scene variants share lifecycle code but deliberately vary their graphics. [Design registry](../apps/web/src/lab/designs.ts#L11) · [Production guard](../apps/web/src/lab/lab-access.ts#L3) · [Homepage imports](../apps/web/src/routes/index.tsx#L5) · [First renderer](../apps/web/src/lab/o-1/eclipse-scene.tsx#L290) · [Related renderer](../apps/web/src/lab/eclipse-4/eclipse-scene.tsx#L397)

**Decision and plan.** Identify which previews still support design decisions. Remove only rejected variants and their registry entries after tracing imports of the individual assets from the surviving homepage and previews. If the variants must remain editable, compare the closest two first and share only identical WebGL lifecycle/disposal code. Keep variant geometry, uniforms and shaders local. Check the public homepage, surviving preview URLs, reduced-motion rendering and resource disposal. Capture comparable frames for any surviving renderer whose implementation changes. The 5,466 lines are the measured scope of these variants. The chosen keep-list determines the deletion. [Preview route](../apps/web/src/routes/lab.$design.tsx#L28) · [Lab access tests](../apps/web/src/lab/lab-access.test.ts)

### Implementation order and stopping rules

| Order | Work                                                                                                                                          | Completion signal                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Land §1 and §2 independently, then delete the old APIs in §3.                                                                                 | Both deletion entry points honor the same retention and containment rules. Both callback readers agree on a shared fixture matrix. All four obsolete cache exports have disappeared and current history reads still pass. |
| 2     | Consolidate provider usage (§4). Make the classic ACP support decision (§18) before spending time moving code between the two engines (§5–6). | Four registrations delegate to one usage implementation. Either the two retained engines share the identical helpers, or an accepted replacement covers the old consumers.                                                |
| 3     | Address the observed plugin-registration and CLI descriptor drift (§7, §14).                                                                  | Real and fake hosts agree on disposal. CLI configuration JSON preserves the server's descriptor metadata and established error/exit behavior.                                                                             |
| 4     | Tackle inbox fact loading (§8), Git refs (§9) and realtime subscriptions (§10) in separate changes.                                           | Before/after fixtures agree, duplicate reads or state transitions are gone, and affected callers retain their own policies.                                                                                               |
| 5     | Land the independent client and contract cleanups (§11–13, §15–17) one at a time.                                                             | Each change deletes an implementation, mapping or field list. Compare its complete diff, including new adapters and tests. Stop if indirection outweighs the deleted policy.                                              |
| 6     | Resolve the lifecycle of the rename tool and web previews (§19–20).                                                                           | Each removal has an identified last consumer or accepted keep-list, and a verified surviving workflow.                                                                                                                    |

For each implementation change, record actual production source lines added and removed separately from tests, generated artifacts and retired fixtures. For behavior-changing fixes, record the before/after output. For a pure refactor, use the same input and compare outputs. Avoid combining these independent changes in one patch.

## Validation and Acceptance

### Behavioral baseline

Proof ID: omnyo-simplification-behavior
Artifact: The fixture below, the linked source and the per-finding tests in this document.
Command: From the repository root, run the callback fixture below and the focused tests named in the finding being implemented. Capture the fixture outputs for the same inputs before and after that change.
Expected signal: At the audited revision the callback fixture prints different values. For other findings, capture supported outputs, wire requests, visible state or filesystem outcomes at their existing public entry points before editing.

### Equivalence proof

Proof ID: omnyo-simplification-behavior
Artifact: The same fixture and per-finding tests, plus the implementation diff and before/after results for the affected entry points.
Command: From the repository root, run the callback fixture below and the focused tests named in the finding being implemented. Capture the fixture outputs for the same inputs before and after that change.
Expected signal: Pure refactors preserve the captured behavior. For the callback correction both values become working. For retention, disposed-hook registration and CLI metadata, verify the explicit corrected outcomes in §1, §7 and §14. Each retirement satisfies the consumer checks in its finding.

### Reproduce the callback disagreement

Run from the repository root with the checkout's installed dependencies. This uses a synthetic source, owner and callback in SQLite memory.

    TSX_DISABLE_CACHE=1 node --conditions=source --import tsx --input-type=module <<'JS'
    import {
      createConnection, migrate, upsertHost, createProject, createThread,
      noopNotifier, threadCallbacks, insertEvents, listThreadCallbacks,
      readThreadAttentionFacts
    } from './packages/db/src/index.ts';
    import { threadScope } from './packages/domain/src/thread-event-scope.ts';

    const db = createConnection(':memory:');
    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: 'audit' });
      const { project } = createProject(db, noopNotifier, {
        name: 'audit', source: { type: 'local_path', hostId: host.id, path: '/tmp' }
      });
      const makeThread = () => createThread(db, noopNotifier, {
        projectId: project.id, providerId: 'codex', status: 'idle'
      });
      const source = makeThread();
      const owner = makeThread();
      db.insert(threadCallbacks).values({
        threadId: owner.id, id: 'audit-callback', sourceThreadId: source.id,
        sourceTitle: 'source', reason: 'audit', createdAt: 1, afterSeq: 0,
        matchText: 'done'
      }).run();
      const item = {
        id: 'task:cmd', type: 'backgroundTask', taskType: 'local_bash',
        description: 'synthetic fixture', status: 'pending',
        taskStatus: 'running', skipTranscript: false
      };
      insertEvents(db, noopNotifier, [{
        threadId: source.id, sequence: 1, scope: threadScope(), type: 'item/started',
        itemId: item.id, itemKind: 'backgroundTask', parentToolCallId: null,
        data: JSON.stringify({ item })
      }]);
      console.log(JSON.stringify({
        callbackList: listThreadCallbacks(db, owner.id)[0].sourceState,
        attentionFacts: readThreadAttentionFacts(db, [owner.id]).get(owner.id).callbacks[0].sourceState
      }));
    } finally {
      db.$client.close();
    }
    JS

### Recheck the largest counts and the cache caller search

From the repository root in Bash or Zsh, the nine file comparisons should succeed silently. `wc -l` reports physical source lines. For the cache search, classify each hit as definition, export, test or production caller and inspect any new callers before removal.

    for name in cursor grok hermes omp opencode resolver shared; do
      cmp "plugins/provider-acp/src/native-roots/$name.ts" "plugins/provider-acp-next/src/native-roots/$name.ts" || exit 1
    done
    for name in interactions cursor-model-selection; do
      cmp "packages/provider-bridge-acp/src/$name.ts" "packages/provider-bridge-acp-next/src/$name.ts" || exit 1
    done
    wc -l plugins/provider-{codex,claude-code,acp,acp-next}/src/usage-source.ts
    wc -l plugins/provider-acp/src/native-roots/{cursor,grok,hermes,omp,opencode,resolver,shared}.ts
    wc -l packages/provider-bridge-acp/src/{interactions,cursor-model-selection}.ts
    wc -l scripts/omnyo-{copy-map,embedded-source-map,environment-map,guide-map,inventory,rename,renderer-map,runtime-path-map,source-map,wire-map}.mjs scripts/omnyo-rename/{selected-path-edges,selectors}.mjs
    wc -l apps/web/src/lab/{o-1,eclipse-{1,2,3,4,5}}/{eclipse-scene.tsx,eclipse-shaders.ts}
    rg -n 'getThreadTimelineRecord|putThreadTimelineRecord|getThreadConversationOutlineRecord|upsertThreadConversationOutlineRecord' apps packages plugins scripts
