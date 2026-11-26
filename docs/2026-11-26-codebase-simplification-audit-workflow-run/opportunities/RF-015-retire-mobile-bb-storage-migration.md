# RF-015 — Retire the mobile `bb.*` to `omnyo.*` storage import, its iOS native preference-records module and the MMKVCore source patch

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium-high. About 1,080 to 1,130 handwritten production lines leave the mobile app (TypeScript, a config plugin, Objective-C++ and a Ruby CocoaPods hook), plus a 60-line patch manifest, one dependency (`@noble/hashes`) and about 700 test lines. A hash-pinned source patch of a third-party C++ pod also goes away, and with it a release-tooling check in the private store.
- **Confidence:** high that the mechanism is as described and runs on every launch. Medium that no install still needs it, because the deciding population (installs of the `app.getbb.mobile` identity) cannot be inspected from the repository.
- **Readiness:** decision-needed. Alex must decide that installs carrying the BB-era `app.getbb.mobile` identity will not be upgraded in place to an Omnyo build that still needs their unimported `bb.*` data. He must also agree to change the private iOS release script `scripts/private-ship-ios.mjs` in the `omnyo-private` Git store, which checks for the MMKV patch on every private iOS release.
- **Effort:** medium, about 1 to 1.5 days. That covers the code removal (0.5 day), the private-ship script change (0.25 to 0.5 day), an iOS prebuild and launch on a simulator or device, and an Android launch.
- **Risk:** medium. The change deletes no stored data. If a device still holds only `bb.*` data, the upgraded app opens with no saved servers, theme, haptics or push state. The user can recover by pairing again, but the loss is visible to them. A mistake in the new `getPreferencesStorage` would break every launch, because `useAppBoot` calls it at boot.
- **Prerequisites:** (1) the investigation gate (execution step 1); (2) the private-ship change in step 6, which must land before or together with the first private iOS release built from the changed source.
- **Related and overlapping:** RF-005 (BB Private desktop continuity) and RF-006 (stopped-state BB-to-Omnyo identity adoption) belong to the same decision family about how far back upgrades are supported. They share no code with this card. RF-012, RF-039 and RF-040 are the other BB-era migrations. RF-133 (unused dependency declarations) does not overlap: `@noble/hashes` has consumers today, and this card removes them. No line counted here is counted in another card.
- **Why this rank:** this is the largest piece of finished migration machinery in the mobile app. Two parts of it keep costing maintenance, not just lines. First, the MMKVCore patch hard-fails `pod install` whenever a `react-native-mmkv` upgrade moves its pinned MMKVCore version. Second, the launch-time validator holds a second copy of the allowed preference values, which must be edited in step with the real stores. It ranks below the desktop continuity (RF-005), which is about eight times larger.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 26 November 2026). The snapshot worktree named in the audit brief was no longer on disk. The files were read from a `git archive` extract of the snapshot in disposable scratch, plus `git show` and `git grep`. No tests ran, because the snapshot has no `node_modules`. The installed `react-native-mmkv` 4.3.2 under `node_modules/.pnpm/` was read for one native-call check (see below). History comes from the retired private Git store `$ARCHIVED_OMNYO_CHECKOUT`, because the public history is one squashed commit (`060950255` "Publish Omnyo source").

*What the mechanism does (Proven by inspection).* The mobile app (Expo, iOS and Android) used to store its state under `bb.*` names. When the product was renamed, three one-time imports were added. Each writes a receipt and refuses to continue when it finds a conflict:

1. **Preferences (MMKV).** `apps/mobile/src/lib/native/preferences-storage.ts`:17-54 `getPreferencesStorage` runs on every launch: `apps/mobile/src/app-shell/useAppBoot.ts`:17 calls it after `getProfileStore().load()`. It checks for the stores `bb.preferences` and `omnyo.preferences` with `existsMMKV`.
   - **iOS:** it first calls `assertPreferenceOwnerAvailableV1`, which throws "The native preference migration owner is unavailable" when the native module is missing. It then runs a native CRC integrity check on each store that exists, the `omnyo.preferences` store included, on every launch. If `bb.preferences` exists, it opens that store read-only and runs `adoptLegacyOpaquePreferencesV1`, an opaque raw copy (`importAllFrom`) verified against per-record SHA-256 digests from the native module. Otherwise it runs `validateCanonicalOpaquePreferencesV1`.
   - **Android:** it runs `adoptLegacyPreferencesV1` or `validateCanonicalPreferencesV1`.
   - All four functions are in `apps/mobile/src/lib/native/legacy-preferences-storage-v1.ts` (505 lines). That file holds the key map `exactKeys`:23-29, `canonicalKey`:31-44, the value validator `validate`:46-79, the reference check `validateReferences`:102-120 and two receipt formats (`omnyo.preferences.import.v1` and `.v2`).
2. **Server profiles (expo-secure-store, which is the iOS Keychain on iOS).** `apps/mobile/src/lib/profiles/profile-store.ts`:137 `doLoad` calls `adoptLegacyProfilesV1` from `apps/mobile/src/lib/profiles/legacy-profile-storage-v1.ts`:83-177 on every load. It copies `bb.profiles.index` and `bb.profile.<id>` to `omnyo.*` under the receipt `omnyo.profiles.import.v1`. The same file also owns three things that must be kept: `canonicalProfileIndexKey`:17, `canonicalProfilePrefix`:19 and the strict `profileIndexSchema` / `parseProfileIndex`:29-52. `profile-store.ts` imports them at lines 5-11 and uses them at lines 24, 26 and 87.
3. **Connect sessions (expo-secure-store).** `apps/mobile/src/lib/native/session-cache.ts`:4-5 builds `nativeSessionCache` with `createMigratingSessionCacheV1` (`apps/mobile/src/lib/native/legacy-session-storage-v1.ts`:11-105). Every `read`, `write` and `clear` first runs `adopt`, which copies `bb.connectSession.<id>` to `omnyo.connectSession.<id>` and writes the receipt `omnyo.connectSession.import.v1.<id>`. The factory also serializes operations per profile (the `pending` map, lines 14-29), validates the stored JSON with `storedSessionSchema` and a size bound (lines 39-50), and reads every write back to verify it (lines 52-57). The callers are `apps/mobile/src/lib/session/session-scheduler.ts`:109-110 (write), :123 (clear) and :159 (read, with errors caught to `null`), `apps/mobile/src/app-shell/connector.ts`:25, `ProfilesProvider.tsx`:102 and `screens/webview/ProfileWebViewScreen.tsx`:204.

*iOS native owner (Proven by inspection).*
- `apps/mobile/src/lib/native/preferences-records-v1.ts` (68 lines) wraps `NativeModules.OmnyoPreferencesIdentityV1`.
- `apps/mobile/plugins/ios-identity-handoff/OmnyoPreferencesModuleV1.mm` (20 lines) exports `recordDigestsV1` and `integrityV1` as blocking synchronous methods.
- `OmnyoPreferencesRecordsV1.mm` (71 lines) and `.h` (7 lines) call `mmkv::MMKV::isFileValid` and a patched method, `omnyoMigrationRawDigestV1`. The same file also defines `OmnyoPreferenceVerifyBeforeAdmissionV1`:41-71, which has no caller at the snapshot (`git grep -n VerifyBeforeAdmission e9e1b74c3` finds only its declaration and definition). It is left over from the iPhone identity handoff that was removed on 11 November.
- `apps/mobile/plugins/with-preferences-records-v1.js` (138 lines) is the first entry in `apps/mobile/app.json`:71 `plugins`. It copies the three native files into the generated Xcode project and adds them to the build. It appends `#import "OmnyoPreferencesRecordsV1.h"` to the Swift bridging header (`bridgePreferencesOwnerV1`). It copies `mmkv-core-patch-v1.rb` and `.json` into `ios/`, and it injects `OmnyoMmkvCorePatchV1.apply(installer)` into the Podfile's `post_install` (`patchPreferencesPodfileV1`).
- `apps/mobile/plugins/ios-identity-handoff/mmkv-core-patch-v1.rb` (54 lines) and `mmkv-core-patch-v1.json` (60 lines) rewrite three files of MMKVCore 2.4.0 after `pod install`: `Core/MMKV_IO.cpp`, `Core/MMKV.h` and `Core/MMKV.cpp`. The script raises an error unless the pod is exactly 2.4.0 and each file's SHA-256 matches a pinned before or after value. The edits do two things: they change `isFileValid` to read the actual size from the CRC metadata and to bounds-check short files, and they add `omnyoMigrationRawDigestV1`.
- The native directories are generated by `expo prebuild` (Continuous Native Generation). Neither `apps/mobile/ios` nor `apps/mobile/android` is tracked (`git ls-tree -d e9e1b74c3 apps/mobile/ios apps/mobile/android` is empty).

*The patch matters only to the Omnyo native module.* For `react-native-mmkv` this is Proven by inspection on the installed copy; for MMKVCore internals it is a Hypothesis. `rg -n "isFileValid|checkExist|importAllFrom|READ_ONLY"` over the installed `react-native-mmkv@4.3.2` `cpp/`, `ios/` and `NitroMmkv.podspec` finds no `isFileValid` call. `existsMMKV` maps to `MMKV::checkExist` (`cpp/HybridMMKVFactory.cpp`:34), and the podspec pins `s.dependency 'MMKVCore', '2.4.0'` (`NitroMmkv.podspec`:27). Whether MMKVCore itself calls `isFileValid` during normal loads was not checked, because the pod sources are not on disk. Execution step 2 checks it.

*Consumer search.* `rg -n "legacy-profile-storage-v1|adoptLegacyProfilesV1|legacy-session-storage-v1|createMigratingSessionCacheV1|legacy-preferences-storage-v1|preferences-records-v1|OmnyoPreferencesIdentityV1|with-preferences-records|mmkv-core-patch|bb\.preferences|bb\.connectSession|bb\.profile"` over the extracted `apps/mobile` and `packages` finds only the files above, their tests and `app.json`:71. `git grep` over the whole snapshot finds no other reference to `mmkv-core-patch`, `with-preferences-records` or `OmnyoPreferences`. Neither `scripts/`, the root `package.json`, `turbo.json` nor any plugin references them. `mmkv-core-patch-v1.test.mjs` is a `node:test` file that runs `/usr/bin/ruby`. It is outside the vitest include (`apps/mobile/vitest.config.ts` includes `src/**/*.test.ts`), and no script runs it.

*External consumer: the private iOS release script (Proven by inspection; counterevidence).* The private store's latest release worktree, `$AUDIT_WORKTREE` (commit `e68dbbaecb`, "Release private Omnyo 1.0.179 (iOS 96)", 25 November 2026), depends on the patch in `scripts/private-ship-ios.mjs`:
- `mmkvPatchDirectory`:367 and `mmkvFiles`:369-384 assert manifest version 1, MMKVCore 2.4.0 and the three patched paths.
- `readPatchedMmkv`:386-420 fails with "The selected iOS build lacks its exact MMKV migration patch" unless the job's `Pods/MMKVCore` files match.
- `verifyMmkvCandidate`:422-456 rebinds the patch through `git show <sourceCommit>:apps/mobile/plugins/ios-identity-handoff/mmkv-core-patch-v1.{json,rb}`.
- The build calls these at :491, :1488-1495, :1571 and :1670. `scripts/private-ship-ios.test.mjs`:212-254, :497-518 and :696 carry fixtures for the same checks.

Deleting the patch from this repository without changing that script breaks every private iOS release.

*Who can still hold `bb.*` data (observed facts, then open questions).*
- The **private** variant `com.omnyohq.app` (`apps/mobile/plugins/ios-identity-handoff/identity-binding-v1.js`:4, team `Z7T4C33A35`) was introduced by private commit `36a49ccb7d` (7 November 2026). The preference migration code is already present at that commit (`git show 36a49ccb7d:apps/mobile/src/lib/native/preferences-storage.ts`). Every build of that identity has therefore written only `omnyo.*` keys and imported any `bb.*` keys on first launch. Commit `68cca64070` (11 November) removed the identity handoff from BB Private after "Alex confirmed … the old BB Private app is deleted". It kept "the preferences records module and the MMKV patch … for now". Conclusion (Proven by inspection for builds made from source): a private-variant container holds no unimported `bb.*` data.
- The **production** and **dev** variants keep the BB identity. `apps/mobile/app.json`:13 `bundleIdentifier` and :33 `package` are `app.getbb.mobile`. The Expo `owner` is `bb-team` (:5), and `apps/mobile/README.md`:595 names Apple team `9QCU24SXK5` and App Store Connect app `6803559210`. The dev variant keeps the iOS bundle and uses the Android package `app.getbb.mobile.dev` (`app.config.js`:102). `docs/platform-support.md`:66-69 says iOS beta ships through TestFlight and Android alpha APKs ship from `get-bb/bb` releases, and that there is "No public store release yet". `apps/mobile/scripts/publish-android-apk.mjs`:53 publishes only `app.getbb.mobile` APKs into an `android-testing` data directory. The snapshot has no `eas.json` and no `.github/workflows` (`git ls-tree -r --name-only e9e1b74c3 | grep -E "eas\.json|^\.github/"` is empty), even though `apps/mobile/README.md`:590-650 describes both.
- **Unknown:** whether Alex controls the `bb-team` Apple team and the BB Android signing key, and whether any BB-era TestFlight or APK tester will receive an Omnyo-built `app.getbb.mobile` build as an in-place upgrade. Only such an install, or a reinstall of it, needs these imports. iOS Keychain items survive app deletion (`apps/mobile/README.md`:702-704), so a reinstall of that identity would also read old `bb.profile.*` items.

*Maintenance cost today (Proven by inspection).*
- **Pinned native patch.** Any `react-native-mmkv` upgrade that moves its pinned MMKVCore version makes `pod install` fail with "Unsupported Omnyo MMKV patch manifest", "The pinned MMKVCore owner is missing or ambiguous" or "Pinned MMKV source changed before migration patch" (`mmkv-core-patch-v1.rb`:9, :11 and :25). The C++ edits and their hashes must then be rewritten, in this repository and in the private release script's expectations.
- **Duplicated validation that runs at launch.** `validate`:46-79 holds a second copy of the allowed values: theme `light`/`dark`/`system` (which `apps/mobile/src/theme/theme-preference.ts`:15 `PREFERENCES` also owns), haptics `true`/`false`, push flags equal to `"1"`, and the push registration schema. The validators run on every launch and throw at boot when a value fails (`useAppBoot.ts`:24-31 then shows "Saved mobile data could not be loaded"). Adding a theme mode or changing a push record shape therefore needs a matching edit in this migration file, or launches fail. The real stores already parse leniently: `push-store.ts`:63-88 uses `safeParse`.
- **The sweep's example was wrong.** The sweep claimed that every new preference key must be added to an allow-list. That is not true. On iOS, `ownedCanonicalPreferenceKey` returns `null` for unknown keys, so they are skipped. On Android, `canonicalKey` returns a non-`bb.` key unchanged. Only unknown `bb.*` keys throw, and current code never writes those.
- **Boot cost on iOS.** Every iOS launch makes two blocking synchronous native-module calls and a whole-file CRC pass over `omnyo.preferences`, then a JS pass that parses every owned key. This is a small cold-start cost (Hypothesis; not measured).

*Out of scope (checked and rejected).* `packages/mobile-bridge/src/legacy-native-global-v1.ts` and `packages/mobile-bridge/src/inject.ts`:27-30 guard the WebView against an old `window.bb` native bridge. That is a separate four-line compatibility guard with its own tests (`packages/mobile-bridge/test/inject.test.ts`:521-536), and it is not part of storage. `migrateLegacyRelayServerUrl` and `migrateLegacyPrivateServerUrl` in `profile-store.ts` are current address migrations owned by `@omnyo/connect-client`. They stay. `identity-binding-v1.js` is the live private-variant identity (`app.config.js`:7, `plugins/with-private-ios.js`:8) and stays.

**Proposed end state and preservation argument**

What disappears:
- the three import paths and their receipts' readers;
- the `OmnyoPreferencesIdentityV1` native module and its config plugin, including the bridging-header edit;
- the MMKVCore patch and its Podfile hook;
- the launch-time `validateCanonical*` passes;
- the `@noble/hashes` dependency of `@omnyo/mobile`.

What remains, with one owner each:
- `getPreferencesStorage()` returns a single memoized `createMMKV({ id: "omnyo.preferences" })` on every platform. The theme, haptics and push stores stay the only readers and validators of their keys. They already tolerate bad values (`safeParse`, fallback defaults).
- `profile-store.ts` owns `PROFILE_INDEX_STORAGE_KEY = "omnyo.profiles.index"`, the `omnyo.profile.` prefix and the strict `profileIndexSchema` / `parseProfileIndex`, moved verbatim from `legacy-profile-storage-v1.ts`. `doLoad` reads `storage.getItem(PROFILE_INDEX_STORAGE_KEY)` directly. A malformed index still throws "Saved server profile index is invalid; no profiles were replaced.", and a missing index still means no profiles.
- The session cache becomes a canonical-key implementation in `apps/mobile/src/lib/session/session-cache.ts` (or a sibling `secure-session-cache.ts`) with the signature `createSecureSessionCache(storage: SecureStorageLike): SessionCacheLike`. It keeps three behaviors: per-profile serialization (the `pending` map, moved verbatim), `storedSessionSchema` plus `SECURE_STORAGE_MAX_VALUE_BYTES` validation on read and write (an invalid stored value still throws "Saved session is invalid…", which `session-scheduler.ts`:159 turns into `null`), and read-back verification after each write. Only the `bb.*` lookup and the receipt writes go.

Preservation argument:
- On any device whose import already finished, which includes every private-variant install, the `omnyo.*` data the app reads is exactly what it reads today.
- Leftover receipt keys stay in storage unread and do no harm: `omnyo.preferences.import.v1`, `omnyo.preferences.import.v2`, `omnyo.profiles.import.v1` and `omnyo.connectSession.import.v1.<id>`. The `push-store.ts` and theme readers do not enumerate keys. `apps/mobile/src/lib/e2e/reset.ts`:33 `clearAll()` still wipes them in E2E mode.
- The untouched `bb.preferences` MMKV files and `bb.*` Keychain items are left in place. Deleting user data is a non-goal.

Intentional semantic changes, which Alex should accept explicitly:
- A device still in a half-finished import (a `copying` receipt) now opens with whatever `omnyo.*` data exists, instead of refusing to boot.
- An invalid owned preference value no longer blocks boot. The consumer's existing fallback applies instead. The current blocking behavior is filed as a separate backlog issue, not a requirement this card keeps.

Non-goals: changing the production bundle or package identity, deleting old stores or receipts, and touching the relay or private-URL migrations or the mobile-bridge legacy guard.

Reachability proof and remaining uncertainty:
- The deletion is safe for every install whose import has run or that never had `bb.*` data.
- The only remaining uncertainty is the population in the gate: `app.getbb.mobile` installs that hold unimported BB-era data and will be upgraded in place.

**Alternative if Alex keeps the BB upgrade path (option B).** Keep the JS imports, but drop the native owner and the patch. On iOS, open `bb.preferences` read-only and use `canonical.importAllFrom(source)` followed by the JS-side owned-key rename and verification, without native digests or integrity calls. This removes about 400 native, config and Ruby lines and the pinned-patch maintenance. It keeps about 700 TypeScript lines and loses the byte-level proof that non-string records were copied unchanged. Choose it only if the gate shows that real BB-era installs will be upgraded.

**Expected gain and cost**

*Production lines (handwritten; counted with `wc -l` over the snapshot extract).*

| File | Lines removed |
|---|---|
| `legacy-preferences-storage-v1.ts` | 505 |
| `preferences-records-v1.ts` | 68 |
| `with-preferences-records-v1.js` | 138 |
| `OmnyoPreferencesModuleV1.mm` | 20 |
| `OmnyoPreferencesRecordsV1.mm` | 71 |
| `OmnyoPreferencesRecordsV1.h` | 7 |
| `mmkv-core-patch-v1.rb` | 54 |
| **Whole files deleted** | **863** |
| `legacy-profile-storage-v1.ts` (177 lines, about 35 moved into `profile-store.ts`) | about 142 net |
| `legacy-session-storage-v1.ts` (105 lines, replaced by about 40 to 50 lines of canonical cache) | about 55 to 65 net |
| `preferences-storage.ts` (54 lines down to about 8) | about 46 net |
| `app.json`:71 | 1 |

- **Net production reduction:** about 1,080 to 1,130 lines. Projected; the sweep's 1,150 to 1,250 counted moved code as deleted.
- **Configuration and data:** the patch manifest `mmkv-core-patch-v1.json` (60 lines), plus one dependency line in `apps/mobile/package.json`:71.
- **Tests:** `legacy-preferences-storage-v1.test.ts` (285), `legacy-session-storage-v1.test.ts` (95), `plugins/ios-identity-handoff/mmkv-core-patch-v1.test.mjs` (194) and most of `src/lib/profiles/profile-store.omnyo.test.ts` (173, of which about 15 are kept as a canonical-key case). That is about 730 lines removed and about 40 added for the canonical session cache, so about 690 net.
- **External, in the private store:** about 100 lines of `scripts/private-ship-ios.mjs` plus its test fixtures. These are counted separately and are not repository lines.

*Mechanisms.*

| | Before | After |
|---|---|---|
| Preference stores read at launch | two MMKV stores | one |
| Receipt formats | four | none |
| Native module | one, with blocking synchronous calls | none |
| Third-party source patch | one hash-pinned C++ patch and Podfile hook | none |
| Release-tooling binding | a private-ship patch binding | none |
| Allowed preference values | duplicated in the migration validator | owned only by each store |
| Session cache | migrating wrapper | canonical cache with the same serialization and validation |

*Maintenance example.* Today, a `react-native-mmkv` upgrade that moves MMKVCore fails `pod install` until someone rewrites five C++ edits, recomputes three before and after hashes and updates the private release script. Afterwards it is an ordinary dependency bump. Today, adding a theme mode needs an edit in `theme-preference.ts` and in `legacy-preferences-storage-v1.ts`:53, or iOS and Android launches fail. Afterwards it needs only the first.

*Performance.* Likely a small iOS cold-start improvement, because two synchronous native calls, a CRC pass and a JS validation pass leave the launch path. This is a Hypothesis and was not measured. Android drops one JS validation pass. Bundle size drops by one hashing library (Hypothesis on size).

*Cost.* About 1 to 1.5 days, an iOS prebuild and launch, an Android launch, and a private-store edit. The added code is about 50 to 85 lines: the session cache replacement and the moved profile-index schema.

**Execution steps**

1. **Investigation gate (must pass before any edit).**
   - Ask the owner to decide, for the `app.getbb.mobile` identity (iOS team `9QCU24SXK5`, App Store Connect app `6803559210`, BB Android signing key): will any existing BB-era TestFlight or APK install receive an Omnyo build of this source as an in-place upgrade, and if so, may it lose its unimported saved servers, theme and push state?
   - If he answers "no such upgrade path" or "acceptable loss", continue with option A.
   - If he answers "keep it", stop and re-plan as option B.
   - Also confirm that the private store's `scripts/private-ship-ios.mjs` may be changed in the same change window.
   - Record the decision in the change description.
2. **Reconfirm the anchors.**
   - On a fresh worktree of the current `main`, rerun the consumer search from the Context section over `apps/mobile`, `packages`, `scripts` and `plugins`, and `git grep -n "mmkv-core-patch\|with-preferences-records\|OmnyoPreferences"`.
   - Re-read `profile-store.ts` and `session-scheduler.ts` for new session-cache or profile-index callers.
   - In a disposable `expo prebuild` with `pod install`, run `grep -rn isFileValid ios/Pods/MMKVCore` and confirm that MMKVCore calls it only as a public API, not from its load path.
   - Stop and re-plan if a new caller of the native module, a new `bb.*` key reader, or an MMKVCore internal dependency on the patched `isFileValid` appears.
3. **Checkpoint A: profiles.**
   - In `apps/mobile/src/lib/profiles/profile-store.ts`, move `profileIndexSchema`, `ProfileIndex` and `parseProfileIndex` verbatim from `legacy-profile-storage-v1.ts`:29-52 into this file (or into a new `profile-index.ts`).
   - Set `PROFILE_INDEX_STORAGE_KEY = "omnyo.profiles.index"` and `PROFILE_STORAGE_KEY_PREFIX = "omnyo.profile."` as literals.
   - In `doLoad`, replace `await adoptLegacyProfilesV1(storage)` with `await storage.getItem(PROFILE_INDEX_STORAGE_KEY)`.
   - Delete `legacy-profile-storage-v1.ts`.
   - Convert the case "preserves an intentionally unselected active profile" (`profile-store.omnyo.test.ts`:163-173) to seed `omnyo.profiles.index` and `omnyo.profile.<id>` and move it into `profile-store.test.ts`. Add one case that a malformed `omnyo.profiles.index` makes `load()` reject with the "index is invalid" message, unless an existing case already covers it.
   - Delete the rest of `profile-store.omnyo.test.ts`.
   - Run the mobile vitest suite (see Verification).
4. **Checkpoint B: sessions.**
   - Add `createSecureSessionCache(storage: SecureStorageLike): SessionCacheLike` next to `SessionCacheLike` in `apps/mobile/src/lib/session/session-cache.ts`. Pseudocode:
     - `key(id) = "omnyo.connectSession." + id`
     - `serialize`: moved verbatim from `legacy-session-storage-v1.ts`:14-29
     - `parse`: verbatim from :39-50
     - `read(id)`: `serialize(id, async () => { const raw = await storage.getItem(key(id)); return raw === null ? null : parse(raw); })`
     - `write(id, v)`: `serialize(id, async () => { const raw = JSON.stringify(v); parse(raw); await verifiedWrite(key(id), raw); })`
     - `clear(id)`: `serialize(id, () => storage.deleteItem(key(id)))`
   - Point `apps/mobile/src/lib/native/session-cache.ts` at it and delete `legacy-session-storage-v1.ts`.
   - Replace `legacy-session-storage-v1.test.ts` with a short test of the new cache. It must cover four things: a round trip, an invalid stored JSON value rejecting with "Saved session is invalid", an oversized value rejecting, and two concurrent `write` plus `clear` calls on one profile applying in call order.
5. **Checkpoint C: preferences and native.**
   - Reduce `apps/mobile/src/lib/native/preferences-storage.ts` to a memoized `createMMKV({ id: "omnyo.preferences" })`, and drop the `existsMMKV` and `Platform` imports.
   - Delete `legacy-preferences-storage-v1.ts`, its test, and `preferences-records-v1.ts`.
   - Remove `"./plugins/with-preferences-records-v1"` from `apps/mobile/app.json`:71.
   - Delete `apps/mobile/plugins/with-preferences-records-v1.js` and, under `apps/mobile/plugins/ios-identity-handoff/`, the files `OmnyoPreferencesModuleV1.mm`, `OmnyoPreferencesRecordsV1.mm`, `OmnyoPreferencesRecordsV1.h`, `mmkv-core-patch-v1.rb`, `mmkv-core-patch-v1.json` and `mmkv-core-patch-v1.test.mjs`. Keep `identity-binding-v1.js` and its test.
   - Remove `"@noble/hashes"` from `apps/mobile/package.json`:71 after `rg -n "@noble/hashes" apps/mobile` shows no remaining import. Update the lockfile through the repository's package manager (`pnpm install` in the worktree is a lockfile change: include it in the diff).
   - Run `expo prebuild --clean` for iOS and confirm three things: the Podfile has no `OmnyoMmkvCorePatchV1`, the bridging header has no `OmnyoPreferencesRecordsV1.h`, and `pod install` succeeds with stock MMKVCore.
6. **Checkpoint D: private release tooling (in `$ARCHIVED_OMNYO_CHECKOUT`, on a named branch in its own worktree).**
   - In `scripts/private-ship-ios.mjs`, remove `mmkvBindingPath`:86, `mmkvPatchDirectory`, `mmkvFiles`, `readPatchedMmkv` and `verifyMmkvCandidate`:367-456, the call at :491, the binding steps at :1488-1495 and :1571, and the `mmkvSourceBinding` field at :1670. Remove the matching fixtures in `scripts/private-ship-ios.test.mjs`:212-254, :497-518 and :696.
   - Also update that store's `docs/omnyo-migration/state-migrations.md` STATE-10 row so that it records the retirement.
   - Run that store's `node --test scripts/private-ship-ios.test.mjs` (command not confirmed against that store's scripts; check its `package.json` first).
7. **Cleanup and recount.**
   - Search `apps/mobile/README.md` for stale mentions. The snapshot README's "Local state" section (lines 682-701) already describes only `omnyo.*` keys, so no edit is expected.
   - Run `git grep -n "bb\.preferences\|bb\.profile\|bb\.connectSession\|OmnyoPreferences\|mmkv-core-patch\|adoptLegacy\|createMigratingSessionCacheV1"` and expect no hits.
   - Recount with `wc -l` against the table above, and inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

- **Unit tests.** From `apps/mobile`, run `pnpm test` (the script `vitest run --config vitest.config.ts`). All pass, including the converted profile cases, the new session-cache cases, `src/lib/native/profile-store.test.ts` ("opens a fresh private installation with no saved server and writes nothing"), `src/lib/haptics/haptics.test.ts`, `src/lib/e2e/reset.test.ts` and the push-store tests.
- **Static checks.** From `apps/mobile`, run `pnpm typecheck` (`tsc --noEmit`) and `pnpm lint` (oxlint over `app src scripts plugins metro.config.js app.config.js`). From the repository root, run `pnpm format:check` (`oxfmt . --check`).
- **Kept plugin test.** From `apps/mobile`, run `node --test plugins/ios-identity-handoff/identity-binding-v1.test.mjs`. This is a `node:test` file; the exact invocation is inferred from its imports, because no package script runs it.
- **iOS build.** From `apps/mobile`, run `pnpm prebuild -- --clean --platform ios` (the script is `expo prebuild`; the flags are Expo CLI flags) and then `pnpm ios` (`expo run:ios`) on a simulator. Acceptance:
  - `pod install` succeeds with stock MMKVCore 2.4.0.
  - The app launches to "Add server" on a fresh simulator.
  - On a simulator that already holds `omnyo.*` data from a build of the snapshot commit, the app opens the same saved servers, theme, haptics setting and push toggles. To prepare it: install the snapshot build, add a server, set a theme, then install the new build over it without erasing.
  - The cold launch shows no "Saved mobile data could not be loaded" screen.
- **Android.** From `apps/mobile`, run `pnpm android` (`expo run:android`) with the same upgrade-over-existing-install check. `pnpm e2e:android` (Maestro `e2e/android/smoke.yaml`) is optional if Maestro and an emulator are available.
- **Structural completion.** The `git grep` in step 7 is empty. `app.json` has no `with-preferences-records-v1`. `NativeModules.OmnyoPreferencesIdentityV1` is referenced nowhere. `@omnyo/mobile` no longer depends on `@noble/hashes`. The private store no longer reads `mmkv-core-patch-v1.*`.
- **Performance.** No credible baseline exists. If Alex wants the cold-start gain claimed, measure the time to the first `revealApp` on the same simulator for the snapshot build and the changed build, five cold launches each. Otherwise make no claim.

**Rollback and stop conditions**

- **Rollback.** The change is one revertible commit in this repository plus one in the private store, and neither touches stored data. Reverting restores the imports. Old `bb.*` stores and receipts are still on the device, so an import that was skipped can still run after the revert.
- **Stop: the gate shows a real upgrade population.** If The owner confirms that BB-era `app.getbb.mobile` installs will be upgraded in place and must keep their data, stop and execute option B instead. Alternatively, keep everything until those installs have launched one migrating build, and then confirm.
- **Stop: MMKVCore depends on the patched `isFileValid`.** If step 2 shows that MMKVCore calls the patched `isFileValid` from its own load path, stop. The patch may then be fixing a real defect on normal loads. Investigate it upstream before removing the patch, and keep the patch separately if needed.
- **Stop: the private release script cannot change in the same window.** If `scripts/private-ship-ios.mjs` cannot be changed in the same window, land checkpoints A and B (JS-only, about 200 net lines) and hold C and D. Releases keep working, because the patch files stay.
- **Stop: a launch regression.** If an iOS or Android launch with existing `omnyo.*` data loses any saved server, theme, haptics or push state, stop and compare the keys read before and after. Do not bless the difference.
