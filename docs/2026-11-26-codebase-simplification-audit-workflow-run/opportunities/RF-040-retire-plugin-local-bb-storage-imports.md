# RF-040 — Retire the receipt-based BB-to-Omnyo localStorage imports inside the Thread list and Push notifications plugins

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. About 400 handwritten production lines and one persisted receipt format disappear. One of the two mechanisms runs inside every Thread list preference read, write, remote signal and write acknowledgement.
- **Confidence:** medium. The code, its callers and its only purpose are proven by inspection. Whether any supported browser or desktop profile still holds unmigrated `bb.*` keys is unknown, and only the owner can answer it.
- **Readiness:** decision-needed. Decision D1 below (retire outright, or keep a one-line copy-if-absent step) must be made before editing.
- **Effort:** medium, about half a day. Most of the time goes into rewriting four test suites around the reduced behaviour, including one host test that uses the import conflict as its crash fixture.
- **Risk:** low to medium. The blast radius is two forkable plugins and one host test. There is no server, SDK or database contract. The regression modes are the loss of a first-paint layout cache or of a push client ID on a profile that never opened an Omnyo build, and accidentally dropping the error-recovery side effects that currently live inside the conflict helper (see "Preservation").
- **Prerequisites:** none in code. Decision D1, and for option A the profile check in step 1.
- **Related and overlapping items:** RF-005 (BB Private to Omnyo Private desktop profile and browser-origin continuity: it is the route by which `bb.*` keys reach an Omnyo desktop renderer, so if RF-005 is retired first, the desktop half of this import has no remaining source), RF-006 (stopped-state BB-to-Omnyo identity adoption), RF-012 (BB-to-Omnyo source rename tooling), RF-015 (mobile `bb.*` storage migration), RF-039 (BB-era plugin SDK migration), and RF-035 (host `sidebar.*` preferences replaced by the Thread list plugin, which touches the same product area but different keys and code). The owner should take the BB-retirement decisions in RF-005, RF-006, RF-012, RF-015, RF-039 and RF-040 together. No savings are shared with those items.
- **Why it deserves its place:** it is the largest plugin-local piece of BB-rename machinery. Unlike most migrations it is not a one-time startup step. `importLegacyPreferencesMirrorV1` runs on every mirror read and write, and its receipt and conflict state shapes the Thread list's error and ready states. Every later change to preference sync has to reason about it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The prescribed snapshot worktree was absent, so every file was read with `git show e9e1b74c…:<path>` from `$OMNYO_CHECKOUT`. No tests were run, because the snapshot has no `node_modules`. All claims below are **Proven by inspection** unless labelled otherwise.

*What the subsystem does.* The Thread list plugin keeps its layout preferences (organization mode, sort, sections and so on) on the server in plugin KV storage (`plugins/thread-list/server.ts`, `listPreferences` and `setPreference` RPCs). In the browser it keeps a localStorage mirror, `omnyo.<pluginId>.preferences.v1`, only to paint the sidebar before the server answers. Push notifications keeps a per-browser client ID (`omnyo.push-notifications.client-id`, sent as `clientId` to `notifications.ack`, where the server records it as an accepted target `"<channel>:<clientId>"` in `plugins/push-notifications/server.ts:589` `acknowledgeNotice`). It also keeps two "seen" lists (`omnyo.push-notifications.seen.web` and `.desktop`, up to 100 IDs each) that prevent showing the same notification twice. Before the rename, all of these keys used the `bb.` prefix.

*Thread list import.* `plugins/thread-list/app/preferences/preferences-sync.ts` (778 lines):

- `:28` `mirrorImportReceiptSchemaV1` is a persisted receipt at `omnyo.<pluginId>.preferences-import.v1` with `phase`, `originalRaw`, `acknowledged` and `serverValues`.
- `:42` `isPreferenceKeyV1`, `:56` `parseMirrorReceiptV1` and `:79` `persistMirrorReceiptV1` (a compare-and-set write with verification).
- `:99` `importLegacyPreferencesMirrorV1` copies `bb.<pluginId>.preferences.v1` to the canonical key through a prepared receipt, with eight verify-or-throw checks, and then removes the legacy key.
- `:208` `mirrorConflictsV1`, `:228` `mirrorConflictErrorV1` (an error that tells the user to run `omnyo plugin rpc call <id> setPreference --input-file FILE`), `:238` `reconcileMirrorAuthorityV1` (it tracks which imported fields the server has confirmed, refuses unequal values and deletes the receipt once every field is acknowledged), and `:326` `setMirrorConflictV1`.
- Call sites: `:465` `readMirror` and `:492` `writeMirror` call the import on every read and write. `writeMirror:497-511` also skips unacknowledged imported keys. `:599-605` `hydratePreferences`, `:636-643` `applyRemotePreferenceSignal` and `:690-699` `flushWrite` (write acknowledgement) call `reconcileMirrorAuthorityV1` and `setMirrorConflictV1`. `:732` `schedulePreferenceWrite` calls `writeMirror` on every local change. (The sweep cited `:640`, `:669`, `:718` and `:745`; the correct anchors are the ones listed here.)
- Steady-state cost: when no legacy key or receipt exists, the import returns early after three `getItem` calls and one extra JSON parse of the canonical mirror. **Hypothesis:** the runtime saving from removing it is small. It has not been measured.

*Push import.* `plugins/push-notifications/client.ts` (351 lines): `:11-146` `importLegacyNotificationStateV1` plans three key pairs (client ID and two seen lists), validates both copies, refuses unequal pairs ("conflicts"), generates an ID when none exists, and then runs a four-pass verify, copy, verify and remove chain. `:9` `NotificationStateMigrationErrorV1` is also thrown by non-migration code: `:207` (no `navigator.locks`), `:214` (disposed) and `:301` (an invalid seen list in `claim`). `plugins/push-notifications/app.tsx:18,116` imports the class to show "Notifications are paused because saved device state needs review." `:201-224` `prepare` takes the nested locks `omnyo-notifications-web` and then `omnyo-notifications-desktop` and calls the import. `app.tsx:91` awaits the returned ID before `notifications.pending` and `notifications.ack`. The locks also serialize first-time ID creation across windows (`client.test.ts:665`, "uses one canonical owner across concurrent windows").

*Host comparison.* `apps/app/src/lib/legacy-browser-preferences.ts:151` `importPreference` handles the host's own `bb.*` keys: it copies the value when the canonical key is absent and removes the legacy key, with no receipt. Its tables (`:62` `exactPreferences`, `:102` `preferenceFamilies`) do not cover `bb.thread-list.*` or `bb.push-notifications.*`. The host cannot take these keys over without knowing plugin-private names, which `docs/forkable-plugins.md` rules out. The plugins therefore have to carry any import themselves.

*Reachability of the legacy keys.* The Thread list plugin ID is `thread-list` in both eras: `packages/domain/src/plugin-id.ts` `derivePluginId` strips `bb-plugin-` or `omnyo-plugin-`, and `thread-list` is not in `packages/domain/src/legacy-plugin-id-v1.ts` `legacyOwnedPluginIdsV1`. So `bb.thread-list.preferences.v1` is the real BB-era key, and the import is reachable on any same-origin profile that last ran a BB build. Self-hosted web keeps its origin. Desktop gets BB keys through the profile adoption in `apps/desktop/src/desktop-profile-adoption-v1.ts` (RF-005/RF-006 scope). Public Omnyo users never had `bb.*` keys: the public repository began as an Omnyo-named publish on 2026-11-24 (`060950255`). History in the private store (`$ARCHIVED_OMNYO_CHECKOUT`) shows that both imports arrived in `53ed71ff8e` ("Integrate Omnyo migration … at the phone release cutoff", 2026-11-06). The earlier Thread list mirror simply used `bb.<pluginId>.preferences.v1`, ignored invalid bytes and let the server snapshot win after hydrate (`53ed71ff8e^:plugins/thread-list/app/preferences/preferences-sync.ts:101-160`).

*Consumers searched.* Command: `git grep -n -E "importLegacyNotificationStateV1|NotificationStateMigrationErrorV1|preferences-import|bb\.thread-list|bb\.push-notifications|push-notifications\.client-id" e9e1b74c… -- apps packages plugins docs`. Results: only the two plugins, their tests, and **one host test the sweep missed**: `apps/app/src/components/plugin/PluginSlotMount.test.tsx:42` ("keeps the preferences controller alive through a sidebar collision and recovers through the typed owner RPC and Reload"). It seeds `bb.thread-list.preferences.v1`, expects the conflict crash, the CLI hint text and the receipt contents, and then recovers through `setPreference` and Reload. Its real obligation is host crash and Reload recovery for a plugin slot. That test must be re-fixtured, not deleted. No docs, CLI command, skill, SDK export, server code, Containerfile, desktop or mobile code reads these keys or exports. `apps/desktop/src/desktop-notifications.ts` and `apps/mobile/src/data/notifications/*` use push subscriptions, not these localStorage keys. A search with no hits does not prove absence. An external fork of either plugin would carry its own copy and is unaffected.

*Tests that encode the current contract.* `plugins/thread-list/app/preferences/preferences-sync.test.ts:306-620` ("finite preferences mirror import V1", 315 lines, 11 cases). `plugins/push-notifications/client.test.ts:317-462` ("legacy notification browser state V1") and `:464-710` ("canonical notification ownership after admitted realm drain"). `plugins/push-notifications/app.test.tsx:1869-1991` ("notification identity migration admission").

*Counterevidence.* The strictness is deliberate. Tests such as `preferences-sync.test.ts:478` ("refuses unequal recognized server values … retains both values") and `client.test.ts:355` (collision refusal) assert that no BB-era value is silently lost. That requirement only matters while BB-era profiles exist.

*Maintenance cost today.* Any change to preference sync must keep the receipt, acknowledgement and conflict states consistent across five functions. The 2026-11-13 echo fix `1ff02138eb` had to do so. The push client keeps a 136-line function whose only steady-state job is "read or create one ID".

**Proposed end state and preservation argument**

*Decision D1 (owner).* Choose one option:

- **Option A, retire (preferred if the gate passes).** Delete the legacy import from both plugins. The Thread list reads and writes only `omnyo.<pluginId>.preferences.v1`. Push reads or creates only `omnyo.push-notifications.client-id`.
- **Option B, simplify.** Keep a host-style step per legacy key: if the legacy key exists, copy it when the canonical key is absent, then remove the legacy key. The canonical value wins, and the server snapshot wins after hydrate. That is about 10 lines in the Thread list and 12 in push. This changes migration-path behaviour: an unequal BB value is dropped instead of raising a conflict, which matches the Thread list's pre-2026-11-06 behaviour. It also needs owner acceptance, though not a profile inventory.

*What disappears (both options).* `mirrorImportReceiptSchemaV1`, `MirrorImportReceiptV1`, `isPreferenceKeyV1`, `parseMirrorReceiptV1`, `persistMirrorReceiptV1`, `importLegacyPreferencesMirrorV1`, `mirrorConflictsV1`, `mirrorConflictErrorV1`, `reconcileMirrorAuthorityV1`, `setMirrorConflictV1`, the `preferences-import.v1` receipt key, the unacknowledged-key skip in `writeMirror`, and `importLegacyNotificationStateV1` with its plan and verify chain.

*What must survive (preservation).*

1. Thread list: the mirror as a first-paint cache (`hydratePreferencesFromMirror`), the debounce (`WRITE_DEBOUNCE_MS`), the one-in-flight-write-per-key logic, origin echo suppression (`applyRemotePreferenceSignal:630`), and the rule that pending local writes are not overwritten (`applyValues:556`). Malformed canonical mirror bytes must still throw and stay intact: keep `parseMirrorPayloadV1` in `readMirror` and `writeMirror`, since `preferences-sync.test.ts:118` asserts the throw. Unknown mirror fields must be preserved, and stored values that fail to parse must not be overwritten (`writeMirror:513-517`). Write verification (`writeMirror:526`) stays. The error atom, the toast ID `${pluginId}:preferences-import-v1` and `reportPreferencesSyncError` stay unchanged. Keep the toast ID string: renaming it is cosmetic and touches the host test.
2. **Hidden recovery semantics.** `setMirrorConflictV1([])` is also the success path after a remote signal and after a write acknowledgement. It clears `errorAtom`, sets `readyAtom` back to true once a server snapshot exists, and dismisses the toast. So a transient `setPreference` failure (which calls `reportPreferencesSyncError` and sets ready to false) recovers on the next successful acknowledgement or signal. Replace it with one helper, `markPreferencesSynced()`, that does exactly those three things. Use it at the end of `hydratePreferences` (which already inlines the same code at `:616-620`), `applyRemotePreferenceSignal` and the `flushWrite` success branch.
3. In `applyRemotePreferenceSignal`, `applyValues(conflicts.length === 0 && state.hasServerSnapshot ? state.serverValues : values)` becomes `applyValues(state.hasServerSnapshot ? state.serverValues : values)`. In `flushWrite`, `if (conflicts.length === 0 && state.hasServerSnapshot) applyValues(state.serverValues)` becomes `if (state.hasServerSnapshot) applyValues(state.serverValues)`. With no conflicts these are the current semantics.
4. Push: keep `NotificationStateMigrationErrorV1` under its current name, because `app.tsx` and `claim` depend on it and a rename is cosmetic. Keep both nested locks in `prepare` unchanged: they serialize first-run ID creation across windows, and against `claim`, which locks per channel. Keep the "no `navigator.locks`" refusal. Keep the exact error texts for the remaining cases: unreadable storage, an invalid stored ID ("Saved notification state is invalid. Existing data was preserved."), failure to create an ID, and an unverified write ("Saved notification state could not be verified. Existing data was preserved."). Keep the prepare-time validation of both canonical seen lists, so that an invalid seen list still pauses delivery before `notifications.pending`, as it does today.

*New push helper (shape).*

```ts
export function loadNotificationClientIdV1(
  storage: Pick<Storage, "getItem" | "setItem">,
  createId: () => string = () => crypto.randomUUID(),
): string {
  // 1. getItem the client-id key and both seen keys; on throw -> "could not be read".
  // 2. Validate the seen lists with clientNotificationSchema.shape.id.array() and an
  //    existing ID with the notifications.ack clientId schema; on failure -> "is invalid".
  // 3. Return an existing valid ID without writing anything.
  // 4. Otherwise validate createId(), setItem it, and re-read to verify;
  //    on failure -> "could not be verified".
}
```

`prepare` calls it in place of `importLegacyNotificationStateV1(localStorage)`. Option B adds a copy-if-absent-then-remove for the three `bb.push-notifications.*` keys before step 1.

*Non-goals.* Do not change the server preference store, the RPC contracts, the realtime channel, the toast copy, the lock names, notification tags or the host `legacy-browser-preferences.ts`. Do not move any of this into the host or the plugin SDK.

*Remaining uncertainty.* Whether any supported profile still holds `bb.thread-list.*`, `bb.push-notifications.*` or an unresolved `omnyo.thread-list.preferences-import.v1` receipt. Under option A, such a profile loses its cached first-paint layout (server values apply after hydrate). It also loses any mirror edit the server never received, its push client ID (the next acknowledgement registers a new `"<channel>:<id>"` target) and its seen lists (pending notifications may be shown once more). No server data is lost.

**Expected gain and cost**

Counting basis: `sed -n` ranges over the snapshot files with `wc -l`, including blank lines. These are projections, not measurements.

| Item | Removed | Added | Net (option A) |
|---|---|---|---|
| Thread list receipt, import and conflict helpers (`:28-45`, `:56-341`) | about 304 | 0 | about -304 |
| Thread list call sites (`readMirror`, `writeMirror`, `hydratePreferences`, `applyRemotePreferenceSignal`, `flushWrite`) | about 30 | about 12 (`markPreferencesSynced`) | about -18 |
| Push `importLegacyNotificationStateV1` (`client.ts:11-146`) | 136 | about 35-40 (`loadNotificationClientIdV1`) | about -96 to -101 |
| **Production total** | | | **about 400-420 (A); about 375-400 (B)** |

Tests, counted separately: about 280 of the 315 lines in `preferences-sync.test.ts:306-620` go. The "keeps unsupported fields" case at `:443` is retargeted to the canonical key. About 200-230 lines of the push `client.test.ts` migration cases go. The canonical-only, invalid-canonical, unverified-write, empty-profile, concurrent-window and absent-lock cases are kept and retargeted. The collision variant in `app.test.tsx` goes (about 5 lines) and the identity-continuity case is reseeded from the canonical key. `PluginSlotMount.test.tsx:42` is re-fixtured (about 20-40 lines shorter). The test total is roughly 480-550 lines removed.

Mechanisms before: three independently written rename policies (simple host copy, Thread list receipt and conflict, push four-pass verify), one persisted receipt format, and conflict state that sets the Thread list's ready and error atoms. After option A: none in the plugins. After option B: one simple copy-if-absent policy per plugin, which matches the host's.

Maintenance example: today a change to how write acknowledgements update `serverValues` must also update `reconcileMirrorAuthorityV1`'s acknowledgement bookkeeping and `writeMirror`'s skip rule. Afterwards it touches only `flushWrite`.

Performance: **Hypothesis:** it is neutral to slightly better. Each mirror read and write saves two `getItem` calls and one JSON parse. Not measured.

**Execution steps**

1. **Investigation gate (must pass before editing).**
   a. Re-read the four production files above at the current `main` and confirm that the anchors and symbols still match. Re-run the consumer `git grep` from "Context". If any new caller of `importLegacyPreferencesMirrorV1`, `importLegacyNotificationStateV1` or the receipt key appears (for example a doc, skill or CLI recovery path), stop and re-plan.
   b. Get decision D1 from the owner.
   c. For option A, the owner confirms that every browser profile and desktop profile that ever ran a BB-named build has since loaded an Omnyo build. Both migrations run when the app loads: the Thread list through the `preferences-sync-v1` app overlay, push through `app.tsx:91`. The direct check, in each such profile's developer console, is `Object.keys(localStorage).filter(k => /^bb\.(thread-list|push-notifications)\./.test(k) || k.endsWith(".preferences-import.v1"))`, which must return `[]`. Any remaining key means option B, or waiting.
   d. Check whether RF-005 or RF-006 has already been executed. If BB desktop profile adoption is gone, the desktop route for `bb.*` keys is gone too. Record that in the change description.
2. **Thread list (one commit).** In `plugins/thread-list/app/preferences/preferences-sync.ts`:
   - Delete `mirrorImportReceiptSchemaV1`, `MirrorImportReceiptV1`, `isPreferenceKeyV1`, `parseMirrorReceiptV1`, `persistMirrorReceiptV1`, `importLegacyPreferencesMirrorV1`, `mirrorConflictsV1`, `mirrorConflictErrorV1`, `reconcileMirrorAuthorityV1` and `setMirrorConflictV1`. Keep `mirrorPayloadSchemaV1` and `parseMirrorPayloadV1`.
   - `readMirror`: `const key = mirrorStorageKey(); if (storage === null || key === null) return null; const raw = storage.getItem(key); if (raw === null) return null;`, then parse as today. Do not wrap `getItem` in a try, because today an exception propagates to `reportPreferencesSyncError`.
   - `writeMirror`: read `raw = storage.getItem(storageKey)` and set `snapshot = raw === null ? {} : parseMirrorPayloadV1(raw)`. Drop the `original` variable and its skip branch. Keep the invalid-stored-value skip and the write verification.
   - Add `markPreferencesSynced()`, which sets `errorAtom` to null, sets `readyAtom` to true only when `state.hasServerSnapshot`, and dismisses the toast `${pluginId}:preferences-import-v1`. Use it in `hydratePreferences` in place of `:616-620` (there `hasServerSnapshot` is already true), in `applyRemotePreferenceSignal` after `writeMirror`, and in the `flushWrite` success branch after `writeMirror`.
   - `hydratePreferences`: delete `:599-605`. `applyRemotePreferenceSignal` and `flushWrite`: apply the edits in "Preservation" item 3.
   - Option B only: add `importLegacyMirrorV1(storage, pluginId)` (if `bb.<pluginId>.preferences.v1` exists, `setItem` it to the canonical key when that key is absent, then `removeItem` the legacy key). Call it once from `hydratePreferencesFromMirror` before `readMirror`, not from every read and write.
   - Tests in `preferences-sync.test.ts`: delete the "finite preferences mirror import V1" block except the `:443` unknown-fields case, which you rewrite to seed `MIRROR_KEY` directly. Add one case: after a failed `setPreference` (rejecting RPC), the next successful acknowledgement restores `preferencesReadyAtom` to true and clears the error. This pins the recovery semantics from "Preservation" item 2. Option B also adds one case: a legacy key is copied when the canonical key is absent and dropped when it is present.
   - Checkpoint: run the Thread list tests, typecheck and lint (commands below).
3. **Host test (same commit as step 2).** In `apps/app/src/components/plugin/PluginSlotMount.test.tsx:42`, keep the obligation (controller survives a sidebar crash; Reload recovers), but trigger the crash without the import. Make the first `listPreferences` call reject (for example a counter in the fixture's `rpc.listPreferences` that throws once and then delegates to `harness.behavior.callRpc`), expect "Thread list stopped working." and the closed collector, then click Reload and expect "primary mounted" with the ready atom true. Drop the `bb.`, receipt-key and CLI-hint assertions. Rename the test title to match. Keep the `toast.dismiss` cleanup. Checkpoint: `apps/app` tests for that file.
4. **Push (separate commit).** In `plugins/push-notifications/client.ts`, replace `importLegacyNotificationStateV1` with `loadNotificationClientIdV1`, as sketched above (option B adds the three-key copy-if-absent step). Update `prepare` (`:218`). Keep `NotificationStateMigrationErrorV1`, the locks and `claim` unchanged. In `client.test.ts`, delete the cases that exist only for migration (legacy import, equal and collision dual IDs, legacy quota and copy interruption, seen import, seen collision, interrupted copy and retirement, destination change). Retarget "keeps an existing canonical ID", the canonical rows of "refuses invalid stored identity", "refuses an unverified write" (now on first creation), "creates and reuses only the canonical key", "concurrent windows" and "absent lock ownership" to the new function, and add an "invalid canonical seen list pauses prepare" case. In `app.test.tsx:1869`, reseed the continuity case from `omnyo.push-notifications.client-id`, drop the `bb.` assertions and keep only the `malformed` variant of the `it.each`. Checkpoint: push tests, typecheck and lint.
5. Remove leftovers: run `git grep -n -E "bb\.(thread-list|push-notifications)|preferences-import\.v1|importLegacy(PreferencesMirror|NotificationState)V1|reconcileMirrorAuthority|setMirrorConflict"`. It should return nothing under option A. Under option B it should return only the new copy-if-absent helpers and their tests. Check `plugins/thread-list/PLUGIN_OVERVIEW.md` and `plugins/push-notifications/PLUGIN_OVERVIEW.md` for any migration mention, and update them if one exists. None was found at the snapshot.
6. Inspect the full diff for unrelated changes, then recount the lines with the same `sed -n`/`wc -l` basis and compare with the table.

**Verification and acceptance criteria**

Commands are taken from the package `scripts` at the snapshot. Run them after `pnpm install` in a writable checkout, because they could not be run in this audit.

- `cd plugins/thread-list && pnpm test && pnpm typecheck && pnpm lint`
- `cd plugins/push-notifications && pnpm test && pnpm typecheck && pnpm lint`
- `cd apps/app && pnpm exec vitest run --config vitest.config.ts src/components/plugin/PluginSlotMount.test.tsx`. The `test` script is `vitest run --config vitest.config.ts`; passing a file filter is standard vitest usage and was not executed here.
- Repository root: `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent <changed files>` (root scripts `format` = `oxfmt .` and `lint` = `turbo run lint`).

Acceptance:

- Behaviour: first paint from the mirror; malformed mirror bytes throw and stay byte-identical; unknown mirror fields survive a write; the debounce coalesces writes; echo suppression works; a pending local write is not overwritten by a remote signal; after a transient write failure, the next acknowledgement restores ready and clears the error and toast. Push: the same ID across reconnects and windows, one `randomUUID` call for concurrent first runs, an invalid stored ID or seen list pauses delivery with the alert before `notifications.pending`, and the absent-lock refusal still holds. All existing non-migration cases in the four suites pass unchanged.
- UI: no visual change. Alex can check two states by hand: the Thread list sidebar on a normal load, and the "Thread list stopped working." crash chip followed by Reload.
- Structure: none of the deleted symbols or the receipt key remain, `writeMirror` and `readMirror` touch only the canonical key (option A), and `preferences-sync.ts` is about 330 lines shorter.
- Performance: no benchmark is required. The change only removes localStorage reads.

**Rollback and stop conditions**

- Rollback: revert the commits from step 2 and step 4 independently. No persisted format is written that older code cannot read. An older build that finds no legacy key and no receipt takes the early return at `:119`, so a revert is safe on profiles migrated under either option.
- Stop if: the step 1 profile check finds remaining `bb.*` keys or a receipt (switch to option B or wait); a new consumer of the receipt key or the CLI conflict hint appears; the owner wants BB-era conflict detection kept; or any retained non-migration test fails in a way that would require changing its expected behaviour. In that last case, the hidden recovery or validation semantics were not preserved, so restore them instead of editing the test.
- Smaller alternative if D1 is deferred: none worth doing alone. Partial trimming of the receipt logic keeps the coordination burden.
