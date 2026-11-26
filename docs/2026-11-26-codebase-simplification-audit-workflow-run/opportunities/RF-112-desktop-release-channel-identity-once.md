# RF-112 — Delete the desktop runtime's second channel parser and identity map (`createDesktopReleaseInfo`) and read both from `desktop-release-channel.mjs`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exactly as the sweep described. Two corrections: the net production saving is smaller than the sweep's 20-35 lines (about 10-25), and `releaseTag` has no reader anywhere in the repository, so the runtime should not receive it at all.
- **Potential:** low. The change is small, but the duplicated knowledge selects the desktop user-data directory. A drift between the two copies silently opens a different profile for every user of that channel.
- **Confidence:** high. The duplication, the consumers and the esbuild constraint are Proven by inspection. The line counts are projections from exact ranges.
- **Readiness:** ready. No behavior, API, persisted format or product identity changes. The single observable difference is the wording of an error message that a packaged build cannot reach (see "Proposed end state").
- **Effort:** small, about 2-3 hours including the focused desktop tests and a before/after config comparison.
- **Risk:** low to medium. The realistic regression modes are a wrong `profileName` (wrong user-data directory), a lost literal type that breaks `prepareDesktopProfilePathV1`, or moving the environment read so that the esbuild `define` no longer replaces it.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - An earlier card from the client slice of this audit, `docs/2026-11-26-codebase-simplification-audit/opportunities/RF-104-desktop-release-identity.md`, covers the same opportunity under an older ID. That card keeps `createDesktopReleaseInfo` as a delegating alias and keeps two parsers. This card supersedes it: `createDesktopReleaseInfo` has no production consumer, so it can go. The index owner should keep one of the two cards.
  - `docs/2026-11-26-codebase-simplification-audit/client-issues.md` ISS-100 records the stale runtime error message. This card fixes it as a named side effect of sharing the parser.
  - RF-034 "Delete the superseded desktop JSON version-feed checker" may edit `resolveDesktopUpdateSupport` in the same file (`versionCheck`). RF-084 "Retire the desktop JSON version-feed producer" removes `apps/desktop/scripts/generate-version-feed.mts`, one consumer of `createDesktopReleaseConfig`. RF-005 "Retire the BB Private to Omnyo Private desktop profile continuity" edits `apps/desktop/src/desktop-profile-v1.ts` and the profile code in `main.ts` `runDesktopApp`. All of these are textual overlaps only. Land each as its own commit.
- **Why this rank:** it removes one parser, one identity map and one parity test from a sensitive path, at low cost. It removes no subsystem, so it belongs below the structural items.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree had already been removed when this card was verified, so every file was read with `git show e9e1b74c3:<path>` and searched with `git grep <pattern> e9e1b74c3`. `git diff --stat e9e1b74c3 5f2d3f895` over all cited files was empty, so the anchors also hold on local `main` at `5f2d3f895`.

*What the subsystem does.* The Electron desktop app ships three release channels: `latest` (private stable), `nightly` (private nightly) and `public-beta` (local public build, macOS only). At build time, `apps/desktop/scripts/build.mjs:14` resolves the channel with `resolveDesktopReleaseChannel(process.env)` and bakes it into every bundle through the esbuild `define` entry `"process.env.OMNYO_DESKTOP_RELEASE_CHANNEL"` (`build.mjs:99-101`). At runtime, the desktop main process uses the channel to choose its display name, its profile (user-data directory) name and its window icon.

*Observed duplication (Proven by inspection).*

| Knowledge | Packaging owner | Runtime copy |
|---|---|---|
| Channel vocabulary and parser | `apps/desktop/scripts/desktop-release-channel.mjs:26-44` "resolveDesktopReleaseChannel" (trims, defaults empty to `latest`, rejects others) | `apps/desktop/src/desktop-update-provider.ts:36-54` "resolveBuiltDesktopReleaseChannel" (no trim, same default and set) |
| Channel type | `apps/desktop/scripts/desktop-release-channel.d.mts:1` "DesktopReleaseChannel" | `desktop-update-provider.ts:3` "DesktopReleaseChannel" |
| Identity: `applicationName`, `profileName`, `iconFileName`, `releaseTag` per channel | `desktop-release-channel.mjs:64-123` "createDesktopReleaseConfig" (branches at `:71-83`, `:85-104`, `:106-122`) and types at `.d.mts:11-23` "DesktopReleaseConfig" | `desktop-update-provider.ts:5-11` "DesktopReleaseInfo" and `:13-34` "createDesktopReleaseInfo" |

The values in the two identity maps agree today for all three channels: `latest` is `Omnyo` / `Omnyo Private` / `icon.png` / `desktop-latest`; `nightly` is `Omnyo Nightly` / `Omnyo Private Nightly` / `icon-nightly.png` / `desktop-nightly`; `public-beta` is `Omnyo` / `Omnyo` / `icon.png` (inherited from the `latest` spread at `.mjs:76`) / `desktop-public-beta`.

*Runtime consumers (Proven by inspection, `git grep -n "DESKTOP_RELEASE_INFO\|createDesktopReleaseInfo\|resolveBuiltDesktopReleaseChannel" e9e1b74c3 -- .`).*

- `apps/desktop/src/main.ts:244-249` imports `DESKTOP_RELEASE_CHANNEL` and `DESKTOP_RELEASE_INFO` from `./desktop-update-provider.js`.
- `main.ts:3363-3365` "runDesktopApp": `applicationName = app.isPackaged ? DESKTOP_RELEASE_INFO.profileName : "omnyo-dev"`. This value goes to `prepareDesktopProfilePathV1` (`main.ts:3379-3384`), whose `applicationName` parameter is typed `DesktopProfileName` (`apps/desktop/src/desktop-profile-v1.ts:134-136`, a zod enum at `:26-31`). The literal union type is therefore load-bearing for `pnpm typecheck`.
- `main.ts:3367-3369`: `displayName = DESKTOP_RELEASE_INFO.applicationName` when packaged.
- `main.ts:3529-3532`: `resolveDesktopIconPath({ packagedIconFileName: DESKTOP_RELEASE_INFO.iconFileName, ... })`.
- `DESKTOP_RELEASE_INFO.releaseTag` and `DESKTOP_RELEASE_INFO.channel` have no runtime reader. `channel` is read only by a test (`apps/desktop/test/electron-builder-config.test.ts:863`).
- `createDesktopReleaseInfo` has no production caller. Its only callers are tests: `apps/desktop/test/desktop-update-provider.test.ts:30,34`, `apps/desktop/test/public-beta.test.ts:128`, `apps/desktop/test/electron-builder-config.test.ts:834`.
- `main.ts:18-21` already imports `createDesktopReleaseConfig` and `resolveDesktopBuildPlatform` from `../scripts/desktop-release-channel.mjs`, and `main.ts:3708-3711` calls `createDesktopReleaseConfig(DESKTOP_RELEASE_CHANNEL, resolveDesktopBuildPlatform(process.platform)).appId` at runtime. The packaging module is already bundled into `main.js`, so importing more from it adds no new dependency edge.

*`releaseTag` has no reader at all (Proven by inspection for tracked files).* `git grep -n "releaseTag" e9e1b74c3 -- .` returns only the definitions in `desktop-release-channel.mjs:81,95,114`, `.d.mts:19` and `desktop-update-provider.ts:10,22,25,32`, plus an unrelated test helper in `apps/server/test/services/plugins/plugin-update.test.ts`. The literal tags `desktop-latest` and `desktop-nightly` appear elsewhere only in `apps/desktop/README.md` prose. A private CI workflow outside the repository could still import the field (Hypothesis; RF-017 notes CI workflows are not in the repository). This card therefore keeps `releaseTag` in the packaging config and stops exposing it at runtime, without deleting it.

*Other consumers checked.* `createDesktopReleaseConfig` and `resolveDesktopReleaseChannel` are also used by `apps/desktop/scripts/run-electron-builder.mjs:172,194` (productName at `:241,275`, icons at `:221,225`, `profileName` at `:280` and the protected-store identity check at `:489`), `generate-version-feed.mts:20-22`, `run-packaged-app.mjs:16-17`, `smoke-packaged-app.mjs:25-27`, `smoke-packaged-npm.mjs:346-347`, `measure-packaged-startup.mjs:459-461` and `private-update-cache.mjs:16`. None serializes the whole config object (`git grep -n "stringify(releaseConfig\|\.\.\.releaseConfig" e9e1b74c3 -- apps/desktop/scripts` has no hits), so property order is not a contract. `apps/desktop/test/electron-builder-config.test.ts:70-120` copies `desktop-release-channel.mjs` and `packages/config/src/release-version.mjs` into a temporary tree and imports it with no installed dependencies, so the module must not gain new imports. The environment variable is also read by `apps/desktop/src/startup.ts:9` and `apps/desktop/src/desktop-profile-continuity-entry-v2.ts:55` through the same esbuild `define`; those reads are out of scope and stay.

*Intentional neighbors to keep.* `apps/desktop/src/desktop-profile-v1.ts:26-40` "profileNameSchema" and "legacyProfileNamesV1" validate a persisted profile marker and include `omnyo-dev`; they are a trust boundary, not a third copy to merge. `apps/desktop/src/private-update-config.ts` `PRIVATE_UPDATE_APP_ID` and `apps/desktop/src/public-beta-update.ts` `PUBLIC_BETA_UPDATE_APP_ID` are deliberate pinned checks.

*Tests that exist because of the duplication.* `public-beta.test.ts:121-139` asserts the beta identity through both `createDesktopReleaseConfig` and `createDesktopReleaseInfo`. `desktop-update-provider.test.ts:29-45` does the same for `latest` and `nightly`.

*Maintenance cost today.* Renaming a profile, changing an icon or adding a channel means editing two maps, two parsers, two type unions and two parity tests. Missing the runtime copy compiles and passes packaging checks but opens a different user-data directory.

**Proposed end state and preservation argument**

*What disappears.* From `apps/desktop/src/desktop-update-provider.ts`: the `DesktopReleaseChannel` type (`:3`), the `DesktopReleaseInfo` interface (`:5-11`), `createDesktopReleaseInfo` (`:13-34`) and `resolveBuiltDesktopReleaseChannel` (`:36-54`).

*What remains and who owns it.* `apps/desktop/scripts/desktop-release-channel.mjs` becomes the only owner of the channel vocabulary, the parser and the identity map. It gains two exports:

```js
// Shared parser. Callers decide whether to trim.
export function parseDesktopReleaseChannel(rawChannel) {
  if (rawChannel === undefined || rawChannel.length === 0) return "latest";
  if (rawChannel === "latest" || rawChannel === "nightly" || rawChannel === "public-beta")
    return rawChannel;
  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest, nightly or public-beta, got ${rawChannel}.`,
  );
}

export function resolveDesktopReleaseChannel(env) {
  return parseDesktopReleaseChannel(env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim());
}

// Platform-neutral identity shared by packaging and the runtime.
export function desktopReleaseIdentity(channel) {
  if (channel === "public-beta")
    return { applicationName: "Omnyo", profileName: "Omnyo", iconFileName: "icon.png" };
  if (channel === "nightly")
    return { applicationName: "Omnyo Nightly", profileName: "Omnyo Private Nightly", iconFileName: "icon-nightly.png" };
  if (channel === "latest")
    return { applicationName: "Omnyo", profileName: "Omnyo Private", iconFileName: "icon.png" };
  throw new Error("Desktop release requires its exact channel and platform");
}
```

`createDesktopReleaseConfig` keeps its validation (`:65-69`) and the macOS-only public-beta refusal (`:72-73`), and builds each branch as `{ ...desktopReleaseIdentity(channel), appId, artifactName, releaseTag, ...installer and platform fields }`. The public-beta branch stays `{ ...createDesktopReleaseConfig("latest", "macos"), ...desktopReleaseIdentity("public-beta"), appId: "dev.omnyo.beta", artifactName: "omnyo-${version}-${arch}.${ext}", releaseTag: "desktop-public-beta" }`, so every field it inherits from `latest` today (including `iconFileName: "icon.png"`) is unchanged.

`desktop-release-channel.d.mts` declares `DesktopReleaseIdentity` with the existing literal unions (`applicationName: "Omnyo" | "Omnyo Nightly"`, `profileName: "Omnyo Private" | "Omnyo Private Nightly" | "Omnyo"`, `iconFileName: "icon.png" | "icon-nightly.png"`), makes `DesktopReleaseConfig extends DesktopReleaseIdentity` (dropping its own three field lines), and declares `parseDesktopReleaseChannel(rawChannel: string | undefined): DesktopReleaseChannel` and `desktopReleaseIdentity(channel: DesktopReleaseChannel): DesktopReleaseIdentity`.

`desktop-update-provider.ts` keeps:

```ts
import {
  desktopReleaseIdentity,
  parseDesktopReleaseChannel,
  type DesktopReleaseChannel,
} from "../scripts/desktop-release-channel.mjs";

export const DESKTOP_RELEASE_CHANNEL = parseDesktopReleaseChannel(
  process.env.OMNYO_DESKTOP_RELEASE_CHANNEL,
);

export const DESKTOP_RELEASE_INFO = desktopReleaseIdentity(DESKTOP_RELEASE_CHANNEL);
```

`DesktopAutoUpdateFeedConfig` and `resolveDesktopUpdateSupport` stay as they are, with `DesktopAutoUpdateFeedConfig.channel` typed by the imported `DesktopReleaseChannel`.

*Why the environment read must stay in `desktop-update-provider.ts`.* The esbuild `define` at `build.mjs:99` replaces only the exact member expression `process.env.OMNYO_DESKTOP_RELEASE_CHANNEL`. `resolveDesktopReleaseChannel` reads `env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]`, which `define` does not replace. If the runtime called `resolveDesktopReleaseChannel(process.env)`, a packaged nightly or public-beta app would read the real process environment at launch, find nothing and fall back to `latest`, opening the `Omnyo Private` profile. This is the most important constraint in the plan.

*Why `desktopReleaseIdentity` must be platform-neutral.* `DESKTOP_RELEASE_INFO` is computed at module load. `createDesktopReleaseConfig("public-beta", platform)` throws on non-macOS platforms, so using it at import time would make any public-beta import on Linux or Windows (for example a test) throw. The identity function takes only the channel.

*How semantics survive.*

- Packaged builds: the baked literal is always the already-trimmed, already-validated channel, so `parseDesktopReleaseChannel` returns the same channel as `resolveBuiltDesktopReleaseChannel` did, and `desktopReleaseIdentity` returns the same three values that `main.ts` reads today.
- Unbundled runs and tests: an undefined or empty value still defaults to `latest`; the runtime still does not trim, exactly as today.
- Packaging: `createDesktopReleaseConfig` returns deep-equal objects for every valid channel and platform pair, and still throws for public-beta on Windows and Linux and for unknown input.
- Named observable change: for an invalid unbundled value the runtime error text changes from `Built desktop release channel must be latest or nightly, got X.` to `OMNYO_DESKTOP_RELEASE_CHANNEL must be latest, nightly or public-beta, got X.`. The old text was wrong (it accepted `public-beta`), no test asserts it (`git grep -n "Built desktop release channel" e9e1b74c3 -- .` returns only the definition), and packaged builds cannot reach it. This is the ISS-100 fix; mention it in the commit message.

*Non-goals.* No profile rename, app ID change, installer change, icon change, feed change or new dependency. Do not merge `desktop-profile-v1.ts` "profileNameSchema" or the pinned app-ID checks. Do not delete `releaseTag` from the packaging config in this change. Do not touch `startup.ts` or `desktop-profile-continuity-entry-v2.ts`.

**Expected gain and cost**

Counting scope: handwritten production TypeScript and JavaScript in `apps/desktop/src` and `apps/desktop/scripts`. Basis: `git show e9e1b74c3:<path> | sed -n <range>p | grep -cv '^\s*$'` over the cited ranges; projections are labeled.

| Measure | Before (observed) | After (projected) |
|---|---|---|
| Channel parsers | 2 | 1 |
| Identity maps | 2 | 1 |
| Channel type unions | 2 | 1 |
| Parity assertions that compare the two maps | 2 tests | 0 (replaced by one table test of the single map) |
| `desktop-update-provider.ts` lines 3-62 (non-blank) | 52 | about 11 (import plus two constants) |
| `desktop-release-channel.mjs` | 147 lines | about 165-170 (+identity function and parser split, minus 8 identity field lines in `createDesktopReleaseConfig`) |
| `desktop-release-channel.d.mts` | 51 lines | about 57-60 |

Projected production change: about 45 lines deleted and 25-35 added, **net about 10-25 lines removed**. Tests: `desktop-update-provider.test.ts:29-45`, `public-beta.test.ts:128-131` and `electron-builder-config.test.ts:21,834,863` are retargeted; a small table test of the parser and identity is added. Test lines are roughly neutral.

Maintenance effect: renaming a profile or icon, or adding a channel identity, becomes one edit in `desktop-release-channel.mjs` and its `.d.mts`, and the runtime follows automatically. Performance: neutral; one function call replaces another at module load, and the module is already in the `main.js` bundle. Bundle size change: negligible and unmeasured.

**Execution steps**

1. **Reconfirm.** In a fresh lane at the current `main`, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/desktop/src/desktop-update-provider.ts apps/desktop/scripts/desktop-release-channel.mjs apps/desktop/scripts/desktop-release-channel.d.mts apps/desktop/src/main.ts apps/desktop/scripts/build.mjs`. Re-run `git grep -n "DESKTOP_RELEASE_INFO\|createDesktopReleaseInfo\|resolveBuiltDesktopReleaseChannel\|releaseTag"`. Re-plan if any of these holds: a new production caller of `createDesktopReleaseInfo` or `DESKTOP_RELEASE_INFO.releaseTag` exists; the two identity maps no longer agree for some channel (that is a bug to report first, not to silently resolve); `build.mjs` no longer uses the `define` entry; or a channel was added.
2. **Capture a baseline.** Before editing, from `apps/desktop`, record the packaging config for every valid pair into the session scratch directory: for each channel in `latest nightly public-beta` and each platform in `macos windows linux`, write `node --input-type=module -e 'const m = await import("./scripts/desktop-release-channel.mjs"); try { console.log(JSON.stringify(m.createDesktopReleaseConfig(process.argv[1], process.argv[2]))) } catch (e) { console.log("THROWS " + e.message) }' <channel> <platform>` to a file. Also record `OMNYO_DESKTOP_RELEASE_CHANNEL=<channel> node scripts/run-electron-builder.mjs --mac --arm64 --print-config` for the three channels (documented in `apps/desktop/README.md:542`), and `--win --x64 --print-config` and `--linux --x64 --print-config` for `latest` and `nightly`. Record the current runtime identity with `pnpm exec tsx -e 'import("./src/desktop-update-provider.ts").then(m => console.log(["latest","nightly","public-beta"].map(c => JSON.stringify(m.createDesktopReleaseInfo(c)))))'` (the `tsx` invocation is an assumption; any TypeScript runner already in the workspace works).
3. **Edit `apps/desktop/scripts/desktop-release-channel.mjs`.** Move the body of "resolveDesktopReleaseChannel" (`:29-43`) into a new exported `parseDesktopReleaseChannel(rawChannel)` and make "resolveDesktopReleaseChannel" call it with `env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim()`. Add the exported `desktopReleaseIdentity(channel)` shown above. In "createDesktopReleaseConfig", replace the `applicationName`, `profileName` and `iconFileName` lines of the `nightly` and `latest` branches with `...desktopReleaseIdentity(channel)` as the first spread, and replace the public-beta branch's `applicationName` and `profileName` lines with `...desktopReleaseIdentity("public-beta")` after the `latest` spread. Keep `releaseTag` and every other field literal. Add no imports.
4. **Edit `apps/desktop/scripts/desktop-release-channel.d.mts`.** Add `export interface DesktopReleaseIdentity` with the three literal-union fields, change `DesktopReleaseConfig` to `extends DesktopReleaseIdentity` and remove its three duplicated field lines (`:13-14`, `:16`), and declare the two new functions.
5. **Edit `apps/desktop/src/desktop-update-provider.ts`.** Delete lines `:3-54`. Add the import shown above. Keep `DESKTOP_RELEASE_CHANNEL` with the literal `process.env.OMNYO_DESKTOP_RELEASE_CHANNEL` argument, and set `DESKTOP_RELEASE_INFO = desktopReleaseIdentity(DESKTOP_RELEASE_CHANNEL)`. Leave `DesktopAutoUpdateFeedConfig` and `resolveDesktopUpdateSupport` unchanged. `main.ts` needs no edit.
6. **Checkpoint.** Run `pnpm --filter @omnyo/desktop typecheck`. A failure at `main.ts:3381` or `:3392` means the identity type lost its literal union; fix the `.d.mts`, not the call site.
7. **Retarget tests.** In `apps/desktop/test/desktop-update-provider.test.ts:2-6,29-45`, replace `createDesktopReleaseInfo` with `desktopReleaseIdentity` imported from `../scripts/desktop-release-channel.mjs`, and make the test one table over all three channels that asserts the exact identity and that `createDesktopReleaseConfig(channel, "macos")` contains it (`toMatchObject`). Add parser cases: `undefined` and `""` give `latest`; each valid value returns itself; `" nightly "` throws from `parseDesktopReleaseChannel` (no trim) but `resolveDesktopReleaseChannel({ OMNYO_DESKTOP_RELEASE_CHANNEL: " nightly " })` returns `nightly`; `"canary"` throws with `must be latest, nightly or public-beta`. In `apps/desktop/test/public-beta.test.ts:13-16,128-131`, replace the `createDesktopReleaseInfo("public-beta")` assertion with `desktopReleaseIdentity("public-beta")` and keep the macOS identity and Windows refusal assertions. In `apps/desktop/test/electron-builder-config.test.ts:21,834,863`, drop the `createDesktopReleaseInfo` import, the `nightlyRelease` constant and the `nightlyRelease.channel` assertion (the config assertions at `:848-862` already cover the nightly identity).
8. **Compare with the baseline.** Re-run the step 2 commands and `diff` each file against its baseline. The `createDesktopReleaseConfig` outputs must be identical as parsed JSON (compare with `node -e` and `util.isDeepStrictEqual` if key order changed), every `THROWS` line must match, and every `--print-config` output must be byte-identical. The runtime identity must equal the baseline's three fields for each channel.
9. **Clean up.** Remove any comment or README text that names `createDesktopReleaseInfo` (`git grep -n createDesktopReleaseInfo` must return nothing). Format the changed files with the repository formatter, inspect the full diff for unrelated changes, and recount production lines against the step 1 baseline. Delete the step 2 scratch files once compared.

**Verification and acceptance criteria**

Commands were read from `apps/desktop/package.json` (`"test": "vitest run --config vitest.config.ts"`, `"typecheck": "tsc --noEmit"`, `"test:prepare": "install-electron"`) and the root `package.json` (`"format:check": "oxfmt . --check"`, `"lint": "turbo run lint"`). None was run in this audit, because the snapshot has no `node_modules`.

From the repository root:

```sh
pnpm --filter @omnyo/desktop typecheck
pnpm --filter @omnyo/desktop test test/desktop-update-provider.test.ts test/public-beta.test.ts test/electron-builder-config.test.ts test/electron-builder-windows-config.test.ts test/app-paths.test.ts
node --test apps/desktop/test/private-fork-packaging.test.mjs
pnpm exec oxfmt --check apps/desktop/src/desktop-update-provider.ts apps/desktop/scripts/desktop-release-channel.mjs apps/desktop/scripts/desktop-release-channel.d.mts apps/desktop/test/desktop-update-provider.test.ts apps/desktop/test/public-beta.test.ts apps/desktop/test/electron-builder-config.test.ts
pnpm exec oxlint --deny-warnings --format=agent apps/desktop/src/desktop-update-provider.ts apps/desktop/scripts/desktop-release-channel.mjs apps/desktop/test/desktop-update-provider.test.ts apps/desktop/test/public-beta.test.ts apps/desktop/test/electron-builder-config.test.ts
```

All five test files exist at the snapshot (`git ls-tree --name-only e9e1b74c3 apps/desktop/test/`). Unconfirmed details: `apps/desktop/package.json` defines no `lint` script, so the direct `oxlint` call is the assumed route; the `node --test` invocation for `private-fork-packaging.test.mjs` follows from its use of `node:test` and was not found in a package script; some tests may need `pnpm --filter @omnyo/desktop test:prepare` first to install Electron.

Acceptance:

- `git grep -n "createDesktopReleaseInfo\|resolveBuiltDesktopReleaseChannel\|interface DesktopReleaseInfo"` returns nothing.
- `apps/desktop/src/desktop-update-provider.ts` still contains the literal expression `process.env.OMNYO_DESKTOP_RELEASE_CHANNEL`.
- The step 8 comparisons show identical packaging configs, identical refusals and identical runtime identities for all three channels.
- Typecheck and the focused tests pass.
- No build, packaging, signing or publication step is run. This change needs none.

**Rollback and stop conditions**

- Rollback: the change is three source files and three test files in one commit. `git revert <commit>` restores the old state, with no persisted data or migration involved.
- Stop and re-plan if the step 8 comparison shows any difference in `applicationName`, `profileName`, `iconFileName`, `appId` or `productName` for any channel. A difference means the edit changed identity, which can move users to a different profile directory.
- Stop if keeping the literal union types requires overloads or casts at `main.ts` call sites. Fixing the `.d.mts` is fine; adding casts in `main.ts` would hide the type check that protects the profile name.
- Stop if anyone proposes reading the channel inside the `.mjs` from `process.env` at runtime. The esbuild `define` would no longer apply.
- Stop if `desktop-release-channel.mjs` would need a new import. The temporary-tree test at `electron-builder-config.test.ts:70-120` loads it with no installed dependencies.
